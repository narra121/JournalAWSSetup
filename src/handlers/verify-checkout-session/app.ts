import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import Stripe from 'stripe';
import { ddb } from '../../shared/dynamo';
import { envelope, errorResponse, ErrorCodes } from '../../shared/validation';
import { getUserId } from '../../shared/auth';

const SUBSCRIPTIONS_TABLE = process.env.SUBSCRIPTIONS_TABLE!;
const STRIPE_SECRET_KEY_PARAM = process.env.STRIPE_SECRET_KEY_PARAM!;

const ssmClient = new SSMClient({});
let stripe: Stripe | null = null;

async function getStripe(): Promise<Stripe> {
  if (stripe) return stripe;
  const result = await ssmClient.send(
    new GetParameterCommand({ Name: STRIPE_SECRET_KEY_PARAM, WithDecryption: true })
  );
  const key = result.Parameter?.Value;
  if (!key) throw new Error('Stripe secret key not found in SSM');
  stripe = new Stripe(key);
  return stripe;
}

/**
 * Verify a Stripe Checkout Session after redirect.
 * GET /v1/subscriptions/verify?session_id=cs_xxx
 *
 * Calls stripe.checkout.sessions.retrieve() to get the real-time status,
 * then updates DynamoDB if the subscription is now active.
 */
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
      // Payment succeeded — update DynamoDB if not already done by webhook
      const sub = session.subscription as Stripe.Subscription;

      if (sub) {
        const now = new Date().toISOString();
        await ddb.send(
          new UpdateCommand({
            TableName: SUBSCRIPTIONS_TABLE,
            Key: { userId },
            UpdateExpression: `SET #status = :active,
              stripeSubscriptionId = :subId,
              stripeCustomerId = :custId,
              planId = :planId,
              paidCount = if_not_exists(paidCount, :zero) + :one,
              currentStart = :periodStart,
              currentEnd = :periodEnd,
              chargeAt = :periodEnd,
              updatedAt = :now`,
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':active': 'active',
              ':subId': sub.id,
              ':custId': typeof session.customer === 'string' ? session.customer : session.customer?.id || '',
              ':planId': sub.items?.data?.[0]?.price?.id || '',
              ':periodStart': new Date((sub.current_period_start || 0) * 1000).toISOString(),
              ':periodEnd': new Date((sub.current_period_end || 0) * 1000).toISOString(),
              ':now': now,
              ':zero': 0,
              ':one': 1,
            },
          })
        );
      }

      return envelope({
        statusCode: 200,
        data: {
          status: 'active',
          subscriptionId: typeof session.subscription === 'string' ? session.subscription : (session.subscription as any)?.id,
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
    return envelope({
      statusCode: 200,
      data: {
        status: 'pending',
        message: 'Payment is still being processed. Please wait a moment.',
      },
    });
  } catch (error: any) {
    console.error('Error verifying checkout session:', error);

    if (error.type === 'StripeInvalidRequestError') {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Invalid checkout session ID');
    }

    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to verify checkout session');
  }
};
