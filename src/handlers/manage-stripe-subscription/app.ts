import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type Stripe from 'stripe';
import { ddb } from '../../shared/dynamo';
import { envelope, errorResponse, ErrorCodes } from '../../shared/validation';
import { getUserId } from '../../shared/auth';
import { getStripe } from '../../shared/stripe-config';
import { stripeSnapshotTime, subscriptionStatus } from '../../shared/stripe-status';

const SUBSCRIPTIONS_TABLE = process.env.SUBSCRIPTIONS_TABLE!;

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
  console.log('manage-stripe-subscription', { method: event.requestContext?.http?.method || event.httpMethod, requestId: event.requestContext?.requestId });

  try {
    const userId = getUserId(event);
    if (!userId) {
      return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');
    }

    // Handle both HTTP API (v2) and REST API (v1) event structures
    const method = event.requestContext?.http?.method || event.httpMethod;

    // ─── GET: Fetch subscription details ───────────────────────────────
    if (method === 'GET') {
      return await handleGet(userId);
    }

    // ─── PUT: Pause or Resume ──────────────────────────────────────────
    if (method === 'PUT') {
      return await handlePut(userId, event.body);
    }

    // ─── PATCH: Undo cancellation ──────────────────────────────────────
    if (method === 'PATCH') {
      return await handlePatch(userId, event.body);
    }

    // ─── DELETE: Cancel subscription ───────────────────────────────────
    if (method === 'DELETE') {
      return await handleDelete(userId, event.body);
    }

    return errorResponse(405, ErrorCodes.METHOD_NOT_ALLOWED, 'Method not allowed');
  } catch (error: any) {
    console.error('Error managing Stripe subscription:', error);
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to manage subscription');
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

  const readAt = stripeSnapshotTime();
  let stripeSub: Stripe.Subscription;
  try {
    stripeSub = await stripeClient.subscriptions.retrieve(stripeSubId);
  } catch (err) {
    console.log('Could not fetch from Stripe, returning DB data', err);
    return envelope({ statusCode: 200, data: { subscription: record } });
  }

  // ── Sync DB status with Stripe status ──
  const syncedStatus = subscriptionStatus(stripeSub);

  if (syncedStatus !== record.status) {
    await storeStripeState(userId, stripeSubId, readAt, syncedStatus);
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

// ─── PUT: Pause / Resume ────────────────────────────────────────────────────

async function handlePut(userId: string, rawBody: string | null): Promise<APIGatewayProxyResult> {
  let body: any;
  try {
    body = JSON.parse(rawBody || '{}');
  } catch {
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Invalid JSON body');
  }
  const { action } = body;

  if (!['pause', 'resume'].includes(action)) {
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Invalid action. Must be "pause" or "resume"');
  }

  const record = await getSubscriptionRecord(userId);
  if (!record) {
    return errorResponse(404, ErrorCodes.NOT_FOUND, 'No subscription found');
  }

  // A paused subscription is stored as `paused`, which is not a paid status: pausing anything but a plain active
  // subscription would hide a pending cancellation or a failed payment behind it.
  if (action === 'pause' && record.status !== 'active') {
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Only an active subscription can be paused');
  }
  if (action === 'resume' && record.status !== 'paused') {
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Subscription is not paused');
  }

  const stripeSubId = record.stripeSubscriptionId;
  if (!stripeSubId) {
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'No Stripe subscription linked');
  }

  const stripeClient = await getStripe();

  try {
    await stripeClient.subscriptions.retrieve(stripeSubId);
  } catch (err: any) {
    if (err?.code === 'resource_missing') {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Stripe subscription no longer exists. Please create a new subscription.');
    }
    throw err;
  }

  const changedAt = stripeSnapshotTime();
  const updated = await stripeClient.subscriptions.update(
    stripeSubId,
    action === 'pause' ? { pause_collection: { behavior: 'void' } } : { pause_collection: null } // null clears the pause
  );
  const status = subscriptionStatus(updated);
  await storeStripeState(userId, stripeSubId, changedAt, status);

  return envelope({
    statusCode: 200,
    data: {
      message: action === 'pause' ? 'Subscription paused successfully' : 'Subscription resumed successfully',
      stripeSubscriptionId: stripeSubId,
      status,
    },
  });
}

// ─── PATCH: Undo cancellation ───────────────────────────────────────────────

async function handlePatch(userId: string, rawBody: string | null): Promise<APIGatewayProxyResult> {
  let body: any;
  try {
    body = JSON.parse(rawBody || '{}');
  } catch {
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Invalid JSON body');
  }
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

  const changedAt = stripeSnapshotTime();
  const updated = await stripeClient.subscriptions.update(stripeSubId, {
    cancel_at_period_end: false,
  });

  // Remove cancelAt and store the state Stripe now reports (active, or paused when a pause is still set)
  const status = subscriptionStatus(updated);
  await storeStripeState(userId, stripeSubId, changedAt, status, { remove: ['cancelAt'] });

  return envelope({
    statusCode: 200,
    data: {
      message: 'Cancellation undone. Your subscription will continue and you will be charged on the next billing date.',
      stripeSubscriptionId: stripeSubId,
      status,
    },
  });
}

// ─── DELETE: Cancel subscription ────────────────────────────────────────────

async function handleDelete(userId: string, rawBody: string | null): Promise<APIGatewayProxyResult> {
  let body: any;
  try {
    body = JSON.parse(rawBody || '{}');
  } catch {
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Invalid JSON body');
  }
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

  let stripeSubExists = true;
  try {
    await stripeClient.subscriptions.retrieve(stripeSubId);
  } catch (err: any) {
    if (err?.code === 'resource_missing') {
      stripeSubExists = false;
    } else {
      throw err;
    }
  }

  const changedAt = stripeSnapshotTime();

  if (stripeSubExists && cancelAtCycleEnd) {
    const updated = await stripeClient.subscriptions.update(stripeSubId, {
      cancel_at_period_end: true,
    });

    const status = subscriptionStatus(updated);
    await storeStripeState(userId, stripeSubId, changedAt, status, { set: { cancelAt: 'cycle_end' } });

    return envelope({
      statusCode: 200,
      data: {
        status,
        message: 'Your subscription will remain active until the end of the current billing period.',
        stripeSubscriptionId: stripeSubId,
      },
    });
  }

  // Immediate cancellation (or Stripe sub no longer exists)
  if (stripeSubExists) {
    await stripeClient.subscriptions.cancel(stripeSubId);
  }

  await storeStripeState(userId, stripeSubId, changedAt, 'cancelled', { set: { endedAt: changedAt } });

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

/**
 * Stores a status read from Stripe at `at`, guarded like the webhook's applyFresh: the row must still belong to
 * `subscriptionId` and hold no Stripe event newer than `at` (a webhook or another request applied after the read).
 * A skipped write is not an error: the newer state is the stored one. Returns whether it was written.
 */
async function storeStripeState(
  userId: string,
  subscriptionId: string,
  at: string,
  status: string,
  extra: { set?: Record<string, string>; remove?: string[] } = {}
): Promise<boolean> {
  const set = ['lastStripeEventAt = :at', '#status = :status', 'updatedAt = :updatedAt'];
  const values: Record<string, any> = { ':at': at, ':status': status, ':updatedAt': new Date().toISOString(), ':subId': subscriptionId };
  for (const [name, value] of Object.entries(extra.set ?? {})) {
    set.push(`${name} = :${name}`);
    values[`:${name}`] = value;
  }
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: SUBSCRIPTIONS_TABLE,
        Key: { userId },
        UpdateExpression: `SET ${set.join(', ')}${extra.remove?.length ? ` REMOVE ${extra.remove.join(', ')}` : ''}`,
        ConditionExpression: 'stripeSubscriptionId = :subId AND (attribute_not_exists(lastStripeEventAt) OR lastStripeEventAt <= :at)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: values,
      })
    );
    return true;
  } catch (err: any) {
    if (err.name !== 'ConditionalCheckFailedException') throw err;
    console.log('stored subscription is newer or belongs to another subscription, write skipped', { userId });
    return false;
  }
}
