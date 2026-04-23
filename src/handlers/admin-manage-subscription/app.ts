import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import Stripe from 'stripe';
import { ddb } from '../../shared/dynamo';
import { envelope, errorResponse, ErrorCodes, errorFromException } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';

const ssm = new SSMClient({});
const SUBSCRIPTIONS_TABLE = process.env.SUBSCRIPTIONS_TABLE!;
const STRIPE_SECRET_KEY_PARAM = process.env.STRIPE_SECRET_KEY_PARAM!;

let cachedStripeKey: string | undefined;
let stripeClient: Stripe | undefined;

async function getStripeClient(): Promise<Stripe> {
  if (stripeClient) return stripeClient;
  if (!cachedStripeKey) {
    const res = await ssm.send(new GetParameterCommand({
      Name: STRIPE_SECRET_KEY_PARAM,
      WithDecryption: true,
    }));
    cachedStripeKey = res.Parameter?.Value;
    if (!cachedStripeKey) throw new Error('Stripe secret key not found in SSM');
  }
  stripeClient = new Stripe(cachedStripeKey);
  return stripeClient;
}

function computePeriodEnd(period?: number, unit?: string): Date {
  if (unit === 'lifetime') {
    return new Date('9999-12-31T23:59:59Z');
  }
  const days = unit === 'months' ? (period ?? 1) * 30 : (period ?? 30);
  const end = new Date();
  end.setDate(end.getDate() + days);
  return end;
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const log = makeLogger({ requestId: event.requestContext?.requestId });
  try {
    const userId = event.pathParameters?.userId;
    if (!userId) {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Missing userId path parameter');
    }

    if (!event.body) {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Missing request body');
    }

    const { action, period, unit } = JSON.parse(event.body);

    switch (action) {
      case 'grant_free': {
        const periodEnd = computePeriodEnd(period, unit);
        await ddb.send(new PutCommand({
          TableName: SUBSCRIPTIONS_TABLE,
          Item: {
            userId,
            status: 'active',
            tier: 'active',
            periodEnd: periodEnd.toISOString(),
            source: 'admin_grant',
            updatedAt: new Date().toISOString(),
          },
        }));
        log.info('Granted free subscription', { userId, periodEnd: periodEnd.toISOString() });
        return envelope({ statusCode: 200, data: { userId, status: 'active', periodEnd: periodEnd.toISOString() }, message: 'Subscription granted' });
      }

      case 'cancel': {
        await ddb.send(new PutCommand({
          TableName: SUBSCRIPTIONS_TABLE,
          Item: {
            userId,
            status: 'cancelled',
            source: 'admin_cancel',
            updatedAt: new Date().toISOString(),
          },
        }));
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

        const stripe = await getStripeClient();
        const invoices = await stripe.invoices.list({ customer: sub.stripeCustomerId, limit: 1 });
        if (!invoices.data.length) {
          return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'No invoices found for this customer');
        }

        const refund = await stripe.refunds.create({ invoice: invoices.data[0].id });

        await ddb.send(new PutCommand({
          TableName: SUBSCRIPTIONS_TABLE,
          Item: {
            userId,
            status: 'cancelled',
            source: 'admin_refund',
            refundId: refund.id,
            updatedAt: new Date().toISOString(),
          },
        }));

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
