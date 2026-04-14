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

  const secretKey = result.Parameter?.Value;
  if (!secretKey) {
    throw new Error('Stripe secret key not found in SSM');
  }

  stripe = new Stripe(secretKey);
  return stripe;
}

/** Convert a Stripe Unix timestamp (seconds) to an ISO string, or null. */
function toISO(ts: number | null | undefined): string | null {
  return ts ? new Date(ts * 1000).toISOString() : null;
}

/**
 * Manage Stripe subscriptions: fetch details, pause/resume, cancel, undo cancellation.
 * Routes: GET, PUT, PATCH, DELETE on /v1/subscriptions
 */
export const handler = async (
  event: APIGatewayProxyEvent | any
): Promise<APIGatewayProxyResult> => {
  const { headers, multiValueHeaders, ...safeEvent } = event;
  console.log('Event:', JSON.stringify(safeEvent, null, 2));

  try {
    const userId = getUserId(event);
    if (!userId) {
      return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');
    }

    // Handle both HTTP API (v2) and REST API (v1) event structures
    const method = event.requestContext?.http?.method || event.httpMethod;

    // ─── GET: Fetch subscription details ───────────────────────────────
    if (method === 'GET') {
      return handleGet(userId);
    }

    // ─── PUT: Pause or Resume ──────────────────────────────────────────
    if (method === 'PUT') {
      return handlePut(userId, event.body);
    }

    // ─── PATCH: Undo cancellation ──────────────────────────────────────
    if (method === 'PATCH') {
      return handlePatch(userId, event.body);
    }

    // ─── DELETE: Cancel subscription ───────────────────────────────────
    if (method === 'DELETE') {
      return handleDelete(userId, event.body);
    }

    return errorResponse(405, ErrorCodes.VALIDATION_ERROR, 'Method not allowed');
  } catch (error: any) {
    console.error('Error managing Stripe subscription:', error);
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to manage subscription', error.message);
  }
};

// ─── GET ─────────────────────────────────────────────────────────────────────

async function handleGet(userId: string): Promise<APIGatewayProxyResult> {
  const result = await ddb.send(
    new GetCommand({ TableName: SUBSCRIPTIONS_TABLE, Key: { userId } })
  );

  if (!result.Item) {
    // No subscription record — return empty subscription (pre-migration user or no trial)
    return envelope({
      statusCode: 200,
      data: {
        subscription: null,
        status: 'none',
        message: 'No subscription found',
      },
    });
  }

  const record = result.Item;
  const stripeSubId = record.stripeSubscriptionId;

  if (!stripeSubId) {
    return envelope({ statusCode: 200, data: { subscription: record } });
  }

  const stripeClient = await getStripe();

  let stripeSub: Stripe.Subscription;
  try {
    stripeSub = await stripeClient.subscriptions.retrieve(stripeSubId);
  } catch (err) {
    console.log('Could not fetch from Stripe, returning DB data', err);
    return envelope({ statusCode: 200, data: { subscription: record } });
  }

  // ── Sync DB status with Stripe status ──
  const syncedStatus = resolveStatus(stripeSub, record.status);

  if (syncedStatus !== record.status) {
    await ddb.send(
      new UpdateCommand({
        TableName: SUBSCRIPTIONS_TABLE,
        Key: { userId },
        UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':status': syncedStatus,
          ':updatedAt': new Date().toISOString(),
        },
      })
    );
  }

  return envelope({
    statusCode: 200,
    data: {
      subscription: {
        ...record,
        status: syncedStatus,
        currentPeriodStart: toISO(stripeSub.current_period_start),
        currentPeriodEnd: toISO(stripeSub.current_period_end),
        trialEnd: toISO(stripeSub.trial_end),
        cancelAt: toISO(stripeSub.cancel_at),
        canceledAt: toISO(stripeSub.canceled_at),
        cancelAtPeriodEnd: stripeSub.cancel_at_period_end,
        stripeDetails: {
          status: stripeSub.status,
          cancelAtPeriodEnd: stripeSub.cancel_at_period_end,
          currentPeriodStart: stripeSub.current_period_start,
          currentPeriodEnd: stripeSub.current_period_end,
          trialEnd: stripeSub.trial_end,
        },
      },
    },
  });
}

/**
 * Map Stripe subscription state to our canonical DB status.
 *
 * Priority:
 *  1. pause_collection set            → 'paused'
 *  2. Stripe status 'canceled'        → 'cancelled'
 *  3. Stripe status 'past_due'        → 'past_due'
 *  4. Stripe 'active' + cancel_at_period_end → 'cancellation_requested'
 *  5. Stripe 'active' + DB already 'cancellation_requested' → keep it
 *  6. Stripe 'active'                 → 'active'
 *  7. Fallback: Stripe status as-is
 */
function resolveStatus(stripeSub: Stripe.Subscription, dbStatus: string): string {
  if (stripeSub.pause_collection) {
    return 'paused';
  }

  if (stripeSub.status === 'canceled') {
    return 'cancelled';
  }

  if (stripeSub.status === 'past_due') {
    return 'past_due';
  }

  if (stripeSub.status === 'active') {
    if (stripeSub.cancel_at_period_end) {
      return 'cancellation_requested';
    }
    if (dbStatus === 'cancellation_requested') {
      // Stripe no longer shows cancel_at_period_end but DB still does — trust Stripe
      return 'active';
    }
    return 'active';
  }

  // trialing, incomplete, incomplete_expired, unpaid — pass through
  return stripeSub.status;
}

// ─── PUT: Pause / Resume ────────────────────────────────────────────────────

async function handlePut(userId: string, rawBody: string | null): Promise<APIGatewayProxyResult> {
  const body = JSON.parse(rawBody || '{}');
  const { action } = body;

  if (!['pause', 'resume'].includes(action)) {
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Invalid action. Must be "pause" or "resume"');
  }

  const record = await getSubscriptionRecord(userId);
  if (!record) {
    return errorResponse(404, ErrorCodes.NOT_FOUND, 'No subscription found');
  }

  const stripeSubId = record.stripeSubscriptionId;
  if (!stripeSubId) {
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'No Stripe subscription linked');
  }

  const stripeClient = await getStripe();

  if (action === 'pause') {
    await stripeClient.subscriptions.update(stripeSubId, {
      pause_collection: { behavior: 'void' },
    });

    await updateSubscriptionStatus(userId, 'paused');

    return envelope({
      statusCode: 200,
      data: {
        message: 'Subscription paused successfully',
        stripeSubscriptionId: stripeSubId,
        status: 'paused',
      },
    });
  }

  // Resume
  await stripeClient.subscriptions.update(stripeSubId, {
    pause_collection: '' as any, // Clear pause_collection to resume
  });

  await updateSubscriptionStatus(userId, 'active');

  return envelope({
    statusCode: 200,
    data: {
      message: 'Subscription resumed successfully',
      stripeSubscriptionId: stripeSubId,
      status: 'active',
    },
  });
}

// ─── PATCH: Undo cancellation ───────────────────────────────────────────────

async function handlePatch(userId: string, rawBody: string | null): Promise<APIGatewayProxyResult> {
  const body = JSON.parse(rawBody || '{}');
  const { action } = body;

  if (action !== 'undo_cancellation') {
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Invalid action. Must be "undo_cancellation"');
  }

  const record = await getSubscriptionRecord(userId);
  if (!record) {
    return errorResponse(404, ErrorCodes.NOT_FOUND, 'No subscription found');
  }

  if (record.status !== 'cancellation_requested') {
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Subscription is not scheduled for cancellation');
  }

  const stripeSubId = record.stripeSubscriptionId;
  if (!stripeSubId) {
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'No Stripe subscription linked');
  }

  const stripeClient = await getStripe();

  // Verify subscription is still active in Stripe before undoing
  const stripeSub = await stripeClient.subscriptions.retrieve(stripeSubId);
  if (stripeSub.status !== 'active') {
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Subscription is no longer active in Stripe');
  }

  await stripeClient.subscriptions.update(stripeSubId, {
    cancel_at_period_end: false,
  });

  // Remove cancelAt and set status back to active
  await ddb.send(
    new UpdateCommand({
      TableName: SUBSCRIPTIONS_TABLE,
      Key: { userId },
      UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt REMOVE cancelAt',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':status': 'active',
        ':updatedAt': new Date().toISOString(),
      },
    })
  );

  return envelope({
    statusCode: 200,
    data: {
      message: 'Cancellation undone. Your subscription will continue and you will be charged on the next billing date.',
      stripeSubscriptionId: stripeSubId,
      status: 'active',
    },
  });
}

// ─── DELETE: Cancel subscription ────────────────────────────────────────────

async function handleDelete(userId: string, rawBody: string | null): Promise<APIGatewayProxyResult> {
  const body = JSON.parse(rawBody || '{}');
  const { cancelAtCycleEnd = true } = body;

  const record = await getSubscriptionRecord(userId);
  if (!record) {
    return errorResponse(404, ErrorCodes.NOT_FOUND, 'No subscription found');
  }

  if (record.status === 'cancellation_requested') {
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Subscription is already scheduled for cancellation');
  }

  if (record.status === 'cancelled') {
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Subscription is already cancelled');
  }

  const stripeSubId = record.stripeSubscriptionId;
  if (!stripeSubId) {
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'No Stripe subscription linked');
  }

  const stripeClient = await getStripe();

  if (cancelAtCycleEnd) {
    // Schedule cancellation at end of billing period
    await stripeClient.subscriptions.update(stripeSubId, {
      cancel_at_period_end: true,
    });

    await ddb.send(
      new UpdateCommand({
        TableName: SUBSCRIPTIONS_TABLE,
        Key: { userId },
        UpdateExpression: 'SET #status = :status, cancelAt = :cancelAt, updatedAt = :updatedAt',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':status': 'cancellation_requested',
          ':cancelAt': 'cycle_end',
          ':updatedAt': new Date().toISOString(),
        },
      })
    );

    return envelope({
      statusCode: 200,
      data: {
        status: 'cancellation_requested',
        message: 'Your subscription will remain active until the end of the current billing period.',
        stripeSubscriptionId: stripeSubId,
      },
    });
  }

  // Immediate cancellation
  await stripeClient.subscriptions.cancel(stripeSubId);

  const now = new Date().toISOString();
  await ddb.send(
    new UpdateCommand({
      TableName: SUBSCRIPTIONS_TABLE,
      Key: { userId },
      UpdateExpression: 'SET #status = :status, endedAt = :endedAt, updatedAt = :updatedAt',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':status': 'cancelled',
        ':endedAt': now,
        ':updatedAt': now,
      },
    })
  );

  return envelope({
    statusCode: 200,
    data: {
      status: 'cancelled',
      message: 'Subscription cancelled immediately',
      stripeSubscriptionId: stripeSubId,
    },
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function getSubscriptionRecord(userId: string): Promise<Record<string, any> | undefined> {
  const result = await ddb.send(
    new GetCommand({ TableName: SUBSCRIPTIONS_TABLE, Key: { userId } })
  );
  return result.Item;
}

async function updateSubscriptionStatus(userId: string, status: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: SUBSCRIPTIONS_TABLE,
      Key: { userId },
      UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':status': status,
        ':updatedAt': new Date().toISOString(),
      },
    })
  );
}
