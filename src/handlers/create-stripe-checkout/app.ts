import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import Stripe from 'stripe';
import { ddb } from '../../shared/dynamo';
import { envelope, errorResponse, ErrorCodes } from '../../shared/validation';
import { getUserId } from '../../shared/auth';
import { makeLogger } from '../../shared/logger';

const SUBSCRIPTIONS_TABLE = process.env.SUBSCRIPTIONS_TABLE!;
const STRIPE_SECRET_KEY_PARAM = process.env.STRIPE_SECRET_KEY_PARAM!;

// Cache Stripe secret key and instance across warm starts
let cachedStripeKey: string | null = null;
let stripe: Stripe | null = null;
const ssmClient = new SSMClient({});

async function getStripeInstance(): Promise<Stripe> {
  if (stripe && cachedStripeKey) return stripe;

  const param = await ssmClient.send(
    new GetParameterCommand({
      Name: STRIPE_SECRET_KEY_PARAM,
      WithDecryption: true,
    })
  );

  const secretKey = param.Parameter?.Value;
  if (!secretKey) {
    throw new Error('Stripe secret key not found in SSM');
  }

  cachedStripeKey = secretKey;
  stripe = new Stripe(cachedStripeKey);
  return stripe;
}

/**
 * Create a Stripe Checkout Session for subscription payments.
 * POST /v1/subscriptions
 *
 * Body: { planId: string (Stripe Price ID), successUrl?: string, cancelUrl?: string }
 */
export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  const userId = getUserId(event);
  const log = makeLogger({ requestId: event.requestContext.requestId, userId });

  log.info('create-stripe-checkout invoked');

  if (!userId) {
    log.warn('unauthorized request');
    return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');
  }

  if (!event.body) {
    log.warn('missing body');
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Missing body');
  }

  let data: { planId?: string; successUrl?: string; cancelUrl?: string };
  try {
    data = JSON.parse(event.body);
  } catch {
    log.warn('invalid json');
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Invalid JSON');
  }

  const { planId, successUrl, cancelUrl } = data;

  if (!planId) {
    log.warn('missing planId');
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Missing required field: planId');
  }

  try {
    // Check for existing active subscription
    const existing = await ddb.send(
      new GetCommand({
        TableName: SUBSCRIPTIONS_TABLE,
        Key: { userId },
      })
    );

    if (existing.Item) {
      const status = existing.Item.status;

      // If there's already a pending checkout, return the existing session URL
      // But only if it's less than 23 hours old (Stripe sessions expire after 24h)
      if (status === 'created' && existing.Item.checkoutUrl) {
        const createdAt = existing.Item.createdAt;
        const ageMs = createdAt ? Date.now() - new Date(createdAt).getTime() : Infinity;
        if (ageMs < 23 * 60 * 60 * 1000) {
          log.info('returning existing pending checkout session');
          return envelope({
            statusCode: 200,
            data: {
              checkoutSessionId: existing.Item.checkoutSessionId,
              checkoutUrl: existing.Item.checkoutUrl,
              status: 'created',
            },
            message: 'Using existing pending checkout session',
          });
        }
        log.info('existing checkout session is stale, creating new one');
      }

      // Block if subscription is already active or pending cancellation
      // Allow: trial, cancelled, expired, completed, paused (user can re-subscribe)
      if (['active', 'past_due', 'cancellation_requested'].includes(status)) {
        log.warn('duplicate subscription attempt', { existingStatus: status });
        return errorResponse(
          400,
          ErrorCodes.VALIDATION_ERROR,
          `You already have a ${status} subscription. Please manage your existing subscription instead of creating a new one.`
        );
      }
    }

    // Initialize Stripe
    const stripeClient = await getStripeInstance();

    // Whitelist allowed origins for checkout URLs
    const ALLOWED_ORIGINS = ['https://tradequt.com', 'https://www.tradequt.com', 'http://localhost:3000'];
    const requestOrigin = event.headers?.origin;
    const origin = requestOrigin && ALLOWED_ORIGINS.includes(requestOrigin) ? requestOrigin : 'https://tradequt.com';

    // Create Stripe Checkout Session
    const session = await stripeClient.checkout.sessions.create({
      mode: 'subscription',
      line_items: [
        {
          price: planId,
          quantity: 1,
        },
      ],
      success_url: successUrl || `${origin}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl || `${origin}/payment/cancel`,
      client_reference_id: userId,
      metadata: {
        userId,
        planId,
      },
      subscription_data: {
        metadata: {
          userId,
          planId,
        },
      },
    });

    const now = new Date().toISOString();

    // Store checkout record in DynamoDB with ConditionExpression to prevent duplicates
    await ddb.send(
      new PutCommand({
        TableName: SUBSCRIPTIONS_TABLE,
        Item: {
          userId,
          checkoutSessionId: session.id,
          checkoutUrl: session.url,
          planId,
          status: 'created',
          createdAt: now,
          updatedAt: now,
        },
        ConditionExpression: 'attribute_not_exists(userId) OR #status IN (:cancelled, :expired, :created, :trial, :completed, :paused)',
        ExpressionAttributeNames: {
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':cancelled': 'cancelled',
          ':expired': 'expired',
          ':created': 'created',
          ':trial': 'trial',
          ':completed': 'completed',
          ':paused': 'paused',
        },
      })
    );

    log.info('checkout session created', { sessionId: session.id });

    return envelope({
      statusCode: 200,
      data: {
        checkoutSessionId: session.id,
        checkoutUrl: session.url,
        status: 'created',
      },
      message: 'Checkout session created successfully',
    });
  } catch (error: any) {
    // Handle DynamoDB conditional check failure (duplicate active subscription race condition)
    if (error.name === 'ConditionalCheckFailedException') {
      log.warn('conditional check failed - duplicate subscription', { error: error.message });
      return errorResponse(
        409,
        ErrorCodes.VALIDATION_ERROR,
        'An active subscription already exists. Please manage your existing subscription.'
      );
    }

    log.error('failed to create checkout session', { error: error.message });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to create checkout session');
  }
};
