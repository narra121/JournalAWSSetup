import type { ApiHandler } from '../../shared/types';
import { UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../shared/dynamo';
import { envelope, errorResponse, ErrorCodes, errorFromException } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';
import { getStripe } from '../../shared/stripe-config';

const SUBSCRIPTIONS_TABLE = process.env.SUBSCRIPTIONS_TABLE!;
const PERIOD_UNITS = ['days', 'months', 'lifetime'];

function computePeriodEnd(period?: number, unit?: string): Date {
  if (unit === 'lifetime') {
    return new Date('9999-12-31T23:59:59Z');
  }
  const end = new Date();
  if (unit === 'months') end.setMonth(end.getMonth() + (period ?? 1));
  else end.setDate(end.getDate() + (period ?? 30));
  return end;
}

async function setStatus(userId: string, fields: Record<string, any>): Promise<void> {
  const names: Record<string, string> = {};
  const values: Record<string, any> = {};
  const sets = Object.entries({ ...fields, updatedAt: new Date().toISOString() }).map(([k, v], i) => {
    names[`#f${i}`] = k;
    values[`:v${i}`] = v;
    return `#f${i} = :v${i}`;
  });
  await ddb.send(new UpdateCommand({
    TableName: SUBSCRIPTIONS_TABLE,
    Key: { userId },
    UpdateExpression: `SET ${sets.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
}

/** An already-cancelled or missing subscription counts as cancelled, so a retry after a failed refund reaches the refund. */
async function cancelStripeSubscription(stripeSubscriptionId: string | undefined): Promise<void> {
  if (!stripeSubscriptionId) return;
  try {
    await (await getStripe()).subscriptions.cancel(stripeSubscriptionId);
  } catch (err: any) {
    if (err?.code !== 'resource_missing' && !/cancel+ed/i.test(err?.message ?? '')) throw err;
  }
}

export const handler: ApiHandler = async (event) => {
  const log = makeLogger({ requestId: event.requestContext?.requestId });
  try {
    const userId = event.pathParameters?.userId;
    if (!userId) {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Missing userId path parameter');
    }

    if (!event.body) {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Missing request body');
    }

    let parsed: any;
    try {
      parsed = JSON.parse(event.body);
    } catch {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Invalid JSON body');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Body must be a JSON object');
    }
    const { action, period, unit } = parsed;
    if (period !== undefined && !(Number.isInteger(period) && period > 0)) {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'period must be a positive whole number');
    }
    if (unit !== undefined && !PERIOD_UNITS.includes(unit)) {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'unit must be days, months or lifetime');
    }

    switch (action) {
      case 'grant_free': {
        const periodEnd = computePeriodEnd(period, unit);
        await setStatus(userId, {
          status: 'active',
          tier: 'active',
          periodEnd: periodEnd.toISOString(),
          source: 'admin_grant',
        });
        log.info('Granted free subscription', { userId, periodEnd: periodEnd.toISOString() });
        return envelope({ statusCode: 200, data: { userId, status: 'active', periodEnd: periodEnd.toISOString() }, message: 'Subscription granted' });
      }

      case 'cancel': {
        const current = (await ddb.send(new GetCommand({ TableName: SUBSCRIPTIONS_TABLE, Key: { userId } }))).Item;
        await cancelStripeSubscription(current?.stripeSubscriptionId);
        await setStatus(userId, { status: 'cancelled', source: 'admin_cancel' });
        log.info('Cancelled subscription', { userId });
        return envelope({ statusCode: 200, data: { userId, status: 'cancelled' }, message: 'Subscription cancelled' });
      }

      case 'refund': {
        const subResult = await ddb.send(new GetCommand({
          TableName: SUBSCRIPTIONS_TABLE,
          Key: { userId },
        }));
        const sub = subResult.Item;
        if (!sub?.stripeCustomerId) {
          return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'No Stripe customer found for this user');
        }

        const stripe = await getStripe();
        const invoices = await stripe.invoices.list({ customer: sub.stripeCustomerId, status: 'paid', limit: 1 });
        if (!invoices.data.length) {
          return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'No paid invoices found for this customer');
        }

        const paymentIntent = invoices.data[0].payment_intent;
        if (!paymentIntent) {
          return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'The latest paid invoice has no payment to refund');
        }
        // Cancel first: a failed refund then leaves a cancelled subscription that a retry can still refund.
        await cancelStripeSubscription(sub.stripeSubscriptionId);
        const refund = await stripe.refunds.create({
          payment_intent: typeof paymentIntent === 'string' ? paymentIntent : paymentIntent.id,
        });
        await setStatus(userId, { status: 'cancelled', source: 'admin_refund', refundId: refund.id });

        log.info('Refunded subscription', { userId, refundId: refund.id });
        return envelope({ statusCode: 200, data: { userId, status: 'cancelled', refundId: refund.id }, message: 'Subscription refunded' });
      }

      default:
        return errorResponse(400, ErrorCodes.VALIDATION_ERROR, `Invalid action: ${action}`);
    }
  } catch (err: any) {
    log.error('Admin manage subscription error', { error: err.message });
    return errorFromException(err, true);
  }
};
