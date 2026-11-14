import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type Stripe from 'stripe';
import { ddb } from '../../shared/dynamo';
import { envelope, errorResponse, ErrorCodes } from '../../shared/validation';
import { getUserId } from '../../shared/auth';
import { getStripe } from '../../shared/stripe-config';
import { stripeSnapshotTime, subscriptionStatus } from '../../shared/stripe-status';

const SUBSCRIPTIONS_TABLE = process.env.SUBSCRIPTIONS_TABLE!;

/**
 * Verify a Stripe Checkout Session after redirect.
 * GET /v1/subscriptions/verify?session_id=cs_xxx
 *
 * Calls stripe.checkout.sessions.retrieve() to get the real-time status, then stores the subscription exactly as the
 * webhook's checkout.session.completed does (stripe-webhook handleCheckoutSessionCompleted), so either writer may win.
 */
const pending = (): APIGatewayProxyResult =>
  envelope({ statusCode: 200, data: { status: 'pending', message: 'Payment is still being processed. Please wait a moment.' } });

export const handler = async (
  event: APIGatewayProxyEvent | any
): Promise<APIGatewayProxyResult> => {
  const userId = getUserId(event);
  if (!userId) {
    return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');
  }

  const sessionId = event.queryStringParameters?.session_id;
  if (!sessionId) {
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Missing session_id query parameter');
  }

  try {
    const stripeClient = await getStripe();

    const readAt = stripeSnapshotTime();
    // Retrieve the checkout session from Stripe
    const session = await stripeClient.checkout.sessions.retrieve(sessionId, {
      expand: ['subscription'],
    });

    // Verify this session belongs to the requesting user
    if (session.metadata?.userId !== userId && session.client_reference_id !== userId) {
      return errorResponse(403, ErrorCodes.UNAUTHORIZED, 'Session does not belong to this user');
    }

    const status = session.status; // 'complete' | 'expired' | 'open'
    const paymentStatus = session.payment_status; // 'paid' | 'unpaid' | 'no_payment_required'

    if (status === 'complete' && paymentStatus === 'paid') {
      // Payment succeeded — store the subscription unless the webhook already did
      const sub = typeof session.subscription === 'string'
        ? await stripeClient.subscriptions.retrieve(session.subscription)
        : (session.subscription as Stripe.Subscription | null);

      // Nothing to activate without a subscription: do not report it as active.
      if (!sub) return pending();

      const price = sub.items?.data?.[0]?.price;
      const periodEnd = new Date((sub.current_period_end || 0) * 1000).toISOString();
      try {
        // Only the latest session recorded for this user may activate and only over an older Stripe state; the
        // session is cleared on use so a replay cannot re-activate.
        await ddb.send(
          new UpdateCommand({
            TableName: SUBSCRIPTIONS_TABLE,
            Key: { userId },
            UpdateExpression: `SET currency = :currency, #interval = :interval, amount = :amount,
              stripeSubscriptionId = :subId,
              stripeCustomerId = :custId,
              #status = :status,
              planId = :planId,
              currentStart = :periodStart,
              currentEnd = :periodEnd,
              chargeAt = :periodEnd,
              paidCount = :paidCount,
              lastStripeEventAt = :readAt,
              updatedAt = :now
              REMOVE checkoutSessionId, checkoutUrl, #src, periodEnd`,
            ConditionExpression: 'checkoutSessionId = :sid AND (attribute_not_exists(lastStripeEventAt) OR lastStripeEventAt <= :readAt)',
            ExpressionAttributeNames: { '#status': 'status', '#src': 'source', '#interval': 'interval' },
            ExpressionAttributeValues: {
              ':sid': sessionId,
              ':currency': price?.currency?.toUpperCase() ?? null,
              ':interval': price?.recurring?.interval ?? null,
              ':amount': price?.unit_amount ?? null,
              ':status': subscriptionStatus(sub),
              ':subId': sub.id,
              ':custId': typeof session.customer === 'string' ? session.customer : session.customer?.id || '',
              ':planId': price?.id || '',
              ':periodStart': new Date((sub.current_period_start || 0) * 1000).toISOString(),
              ':periodEnd': periodEnd,
              ':paidCount': 1,
              ':readAt': readAt,
              ':now': new Date().toISOString(),
            },
          })
        );
      } catch (err: any) {
        if (err.name !== 'ConditionalCheckFailedException') throw err;
        // Session already applied (webhook), not the user's latest one, or a newer Stripe event is stored: report the
        // stored state, change nothing.
        const current = await ddb.send(new GetCommand({ TableName: SUBSCRIPTIONS_TABLE, Key: { userId } }));
        if (current.Item?.status !== 'active') return pending();
      }

      return envelope({
        statusCode: 200,
        data: {
          status: 'active',
          subscriptionId: sub.id,
          message: 'Payment successful! Your subscription is now active.',
        },
      });
    }

    if (status === 'expired') {
      return envelope({
        statusCode: 200,
        data: {
          status: 'expired',
          message: 'This checkout session has expired. Please try again.',
        },
      });
    }

    // Session still open or unpaid
    return pending();
  } catch (error: any) {
    console.error('Error verifying checkout session:', error);

    if (error.type === 'StripeInvalidRequestError') {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Invalid checkout session ID');
    }

    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to verify checkout session');
  }
};
