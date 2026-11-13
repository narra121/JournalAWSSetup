import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { Hono } from 'hono';
import { ddb } from '../../shared/dynamo';
import { fail } from '../../features/http';
import type { AppEnv } from '../types';

export const journalRoutes = new Hono<AppEnv>();

export const MAX_NOTE_LENGTH = 2000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PREFIX = 'DAYNOTE#';
/** Same cap as the import routes; the sort key `DAYNOTE#<date>#<scope>` must stay under DynamoDB's 1024-byte limit. */
const MAX_ACCOUNT_ID_LENGTH = 100;

/** A calendar day: Date.parse alone accepts 2026-02-30 and rolls it into March. */
function isRealDay(date: string): boolean {
  const time = Date.parse(date);
  return DATE.test(date) && !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === date;
}
/** Account scope of a note; `null` in the API is stored as ALL. */
const scopeOf = (accountId: unknown): string => (typeof accountId === 'string' && accountId && accountId !== 'ALL' ? accountId : 'ALL');

/** Day notes live in the AiData table under `DAYNOTE#<date>#<scope>`, so export and account deletion already cover them. */
journalRoutes.get('/days', async (c) => {
  const from = c.req.query('from') ?? '0000-01-01';
  const to = c.req.query('to') ?? '9999-12-31';
  if (!DATE.test(from) || !DATE.test(to)) return fail(c, 400, 'VALIDATION_ERROR', 'Use dates like 2026-11-12 for from and to.');
  const accountId = c.req.query('accountId');

  const days: any[] = [];
  let lastKey: Record<string, any> | undefined;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: process.env.AI_DATA_TABLE!,
        KeyConditionExpression: 'userId = :u AND sk BETWEEN :a AND :b',
        ExpressionAttributeValues: { ':u': c.get('userId'), ':a': `${PREFIX}${from}`, ':b': `${PREFIX}${to}#~` },
        ExclusiveStartKey: lastKey,
      }),
    );
    for (const it of res.Items ?? []) {
      if (accountId !== undefined && it.scope !== scopeOf(accountId)) continue;
      days.push({ date: it.date, accountId: it.scope === 'ALL' ? null : it.scope, plan: it.plan ?? '', review: it.review ?? '', updatedAt: it.updatedAt });
    }
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  return c.json({ success: true, message: 'Success', data: { days } });
});

/** PUT /days/{date} { accountId?, plan?, review? }: a field left out keeps its stored text; both texts empty removes the note. */
journalRoutes.put('/days/:date', async (c) => {
  const date = c.req.param('date');
  if (!isRealDay(date)) return fail(c, 400, 'VALIDATION_ERROR', 'Use a date like 2026-11-12.');
  const body: any = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(c, 400, 'VALIDATION_ERROR', 'The request body must be a JSON object.');
  for (const field of ['plan', 'review']) {
    if (body[field] !== undefined && typeof body[field] !== 'string') return fail(c, 400, 'VALIDATION_ERROR', `The ${field} note must be text.`);
    if ((body[field] ?? '').length > MAX_NOTE_LENGTH) return fail(c, 400, 'VALIDATION_ERROR', `The ${field} note can have at most ${MAX_NOTE_LENGTH} characters.`);
  }
  if (body.accountId !== undefined && body.accountId !== null && (typeof body.accountId !== 'string' || body.accountId.length > MAX_ACCOUNT_ID_LENGTH)) {
    return fail(c, 400, 'VALIDATION_ERROR', 'accountId must be an account id or null.');
  }

  const userId = c.get('userId');
  const scope = scopeOf(body.accountId);
  const key = { userId, sk: `${PREFIX}${date}#${scope}` };
  const existing = body.plan === undefined || body.review === undefined
    ? (await ddb.send(new GetCommand({ TableName: process.env.AI_DATA_TABLE!, Key: key }))).Item
    : undefined;
  const plan = (body.plan !== undefined ? body.plan : existing?.plan ?? '').trim();
  const review = (body.review !== undefined ? body.review : existing?.review ?? '').trim();
  const updatedAt = new Date().toISOString();

  if (!plan && !review) {
    await ddb.send(new DeleteCommand({ TableName: process.env.AI_DATA_TABLE!, Key: key }));
    return c.json({ success: true, message: 'Success', data: { date, accountId: scope === 'ALL' ? null : scope, plan: '', review: '', updatedAt } });
  }
  await ddb.send(new PutCommand({ TableName: process.env.AI_DATA_TABLE!, Item: { ...key, date, scope, plan, review, updatedAt } }));
  return c.json({ success: true, message: 'Success', data: { date, accountId: scope === 'ALL' ? null : scope, plan, review, updatedAt } });
});
