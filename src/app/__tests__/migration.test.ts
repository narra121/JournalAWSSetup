import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../types';

vi.stubEnv('USER_POOL_ID', 'us-east-1_t');
vi.stubEnv('USER_POOL_CLIENT_ID', 'c');
vi.stubEnv('SUBSCRIPTIONS_TABLE', 'subs');
vi.stubEnv('USAGE_TABLE', 'usage');

const ddb = mockClient(DynamoDBDocumentClient);
const { createApp } = await import('../app');
const { setTokenVerifier } = await import('../auth/cognito');
const { effectiveSubscription, computeEntitlements } = await import('../billing/entitlements');

const feature = new Hono<AppEnv>();
feature.get('/plan', (c) => c.json({ plan: c.get('entitlements').plan, trialEndsAt: c.get('entitlements').trialEndsAt ?? null }));
const app = createApp({ featureRoutes: [{ basePath: '/probe', app: feature }] });
const plan = async () => (await app.request('/v1/probe/plan', { headers: { authorization: 'Bearer good' } })).json();

const day = 86_400_000;
const iso = (offset: number) => new Date(Date.now() + offset).toISOString();
const subsUpdates = () => ddb.commandCalls(UpdateCommand).map((c) => c.args[0].input).filter((i) => i.TableName === 'subs');
const daysFromNow = (value: unknown) => (new Date(String(value)).getTime() - Date.now()) / day;

beforeEach(() => {
  ddb.reset();
  ddb.on(UpdateCommand).resolves({});
  setTokenVerifier({ verify: async () => ({ sub: 'u1' }) });
});

describe('existing users on their first request after the deploy', () => {
  it('a user whose trial ended (old Free plan) gets 14 days of trial from now, once', async () => {
    ddb.on(GetCommand).resolves({ Item: { userId: 'u1', status: 'trial', trialEnd: iso(-30 * day) } });
    const body = await plan();
    expect(body.plan).toBe('trial');
    expect(daysFromNow(body.trialEndsAt)).toBeCloseTo(14, 1);

    const [update] = subsUpdates();
    expect(update.Key).toEqual({ userId: 'u1' });
    expect(update.ConditionExpression).toBe('attribute_not_exists(plansVersion)');
    expect(update.UpdateExpression).toContain('#s = if_not_exists(#s, :trial)');
    expect(update.ExpressionAttributeValues).toMatchObject({ ':v': 2, ':trial': 'trial' });
    expect(daysFromNow(update.ExpressionAttributeValues![':end'])).toBeCloseTo(14, 1);
  });

  it('a user still in an older trial keeps the later end when it is past 14 days, and never loses days', () => {
    const later = iso(20 * day);
    expect(effectiveSubscription({ status: 'trial', trialEnd: later }).trialEnd).toBe(later);
    const sooner = effectiveSubscription({ status: 'trial', trialEnd: iso(3 * day) });
    expect(daysFromNow(sooner.trialEnd)).toBeCloseTo(14, 1);
  });

  it('a user with no Subscriptions record gets a trial record', async () => {
    ddb.on(GetCommand).resolves({});
    expect((await plan()).plan).toBe('trial');
    expect(subsUpdates()[0].UpdateExpression).toContain('createdAt = if_not_exists(createdAt, :now)');
  });

  it('a lapsed Pro user from before the deploy is a non-paying user: 14 days, keeping the cancelled status', async () => {
    ddb.on(GetCommand).resolves({ Item: { userId: 'u1', status: 'cancelled', stripeSubscriptionId: 'sub_1', trialEnd: iso(-200 * day) } });
    expect((await plan()).plan).toBe('trial');
    expect(subsUpdates()[0].ExpressionAttributeNames).toEqual({ '#s': 'status' });
  });

  it('a Pro user only gains the marker: their quotas and plan stay Pro', async () => {
    ddb.on(GetCommand).resolves({ Item: { userId: 'u1', status: 'active', stripeSubscriptionId: 'sub_1' } });
    expect((await plan()).plan).toBe('pro');
    const [update] = subsUpdates();
    expect(update.UpdateExpression).toBe('SET plansVersion = :v');
    expect(update.ExpressionAttributeValues).toEqual({ ':v': 2 });
  });

  it('a migrated user is not migrated again: when Pro lapses later they are read-only, with no new trial', async () => {
    ddb.on(GetCommand).resolves({ Item: { userId: 'u1', status: 'cancelled', stripeSubscriptionId: 'sub_1', trialEnd: iso(-200 * day), plansVersion: 2 } });
    expect((await plan()).plan).toBe('free');
    expect(subsUpdates()).toHaveLength(0);
  });

  it('a request that loses the race to another migration re-reads the stored record', async () => {
    const stored = { userId: 'u1', status: 'trial', trialEnd: iso(14 * day), plansVersion: 2 };
    ddb.on(GetCommand).resolvesOnce({ Item: { userId: 'u1', status: 'trial', trialEnd: iso(-day) } }).resolves({ Item: stored });
    ddb.on(UpdateCommand).rejects(new ConditionalCheckFailedException({ message: 'x', $metadata: {} }));
    const body = await plan();
    expect(body).toEqual({ plan: 'trial', trialEndsAt: stored.trialEnd });
    expect(ddb.commandCalls(GetCommand)).toHaveLength(2);
  });
});

describe('Pro quotas during the trial', () => {
  it('the trial has the Pro monthly limits and every feature', () => {
    const e = computeEntitlements(effectiveSubscription({ status: 'trial', trialEnd: iso(-day) }));
    expect(e).toMatchObject({ plan: 'trial', limits: { ai_extract: 200, ai_insight: 30, ai_chat: 500, broker_import: 200, ai_enhance: 500 } });
    expect(Object.values(e.features).every(Boolean)).toBe(true);
  });
});
