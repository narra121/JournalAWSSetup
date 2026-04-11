/**
 * Local development server that wraps Lambda handlers in an Express-like HTTP server.
 * Run with: npx tsx watch local-server.ts
 * Auto-reloads on file changes.
 */
import { readFileSync } from 'node:fs';

// Load env vars BEFORE any handler imports (must be synchronous, before dynamic imports)
const envLocal = JSON.parse(readFileSync('./env-local.json', 'utf-8'));
for (const [key, value] of Object.entries(envLocal.Parameters as Record<string, string>)) {
  process.env[key] = value;
}

import http from 'node:http';
import { URL } from 'node:url';

// Now import all handlers (env vars are set)
const { handler: createTrade } = await import('./src/handlers/create-trade/app.ts');
const { handler: listTrades } = await import('./src/handlers/list-trades/app.ts');
const { handler: updateTrade } = await import('./src/handlers/update-trade/app.ts');
const { handler: deleteTrade } = await import('./src/handlers/delete-trade/app.ts');
const { handler: bulkDeleteTrades } = await import('./src/handlers/bulk-delete-trades/app.ts');
const { handler: getImage } = await import('./src/handlers/get-image/app.ts');
const { handler: getStats } = await import('./src/handlers/get-stats/app.ts');
const { handler: getGoalsProgress } = await import('./src/handlers/get-goals-progress/app.ts');
const { handler: authSignup } = await import('./src/handlers/auth-signup/app.ts');
const { handler: authConfirmSignup } = await import('./src/handlers/auth-confirm-signup/app.ts');
const { handler: authLogin } = await import('./src/handlers/auth-login/app.ts');
const { handler: authRefresh } = await import('./src/handlers/auth-refresh/app.ts');
const { handler: authForgotPassword } = await import('./src/handlers/auth-forgot-password/app.ts');
const { handler: authConfirmForgotPassword } = await import('./src/handlers/auth-confirm-forgot-password/app.ts');
const { handler: extractTrades } = await import('./src/handlers/extract-trades/app.ts');
const { handler: enhanceText } = await import('./src/handlers/enhance-text/app.ts');
const { handler: listAccounts } = await import('./src/handlers/list-accounts/app.ts');
const { handler: createAccount } = await import('./src/handlers/create-account/app.ts');
const { handler: updateAccount } = await import('./src/handlers/update-account/app.ts');
const { handler: updateAccountStatus } = await import('./src/handlers/update-account-status/app.ts');
const { handler: deleteAccount } = await import('./src/handlers/delete-account/app.ts');
const { handler: updateGoal } = await import('./src/handlers/update-goal/app.ts');
const { handler: listRules } = await import('./src/handlers/list-rules/app.ts');
const { handler: getRulesGoals } = await import('./src/handlers/get-rules-goals/app.ts');
const { handler: createRule } = await import('./src/handlers/create-rule/app.ts');
const { handler: updateRule } = await import('./src/handlers/update-rule/app.ts');
const { handler: toggleRule } = await import('./src/handlers/toggle-rule/app.ts');
const { handler: deleteRule } = await import('./src/handlers/delete-rule/app.ts');
const { handler: analytics } = await import('./src/handlers/analytics/app.ts');
const { handler: getUserProfile } = await import('./src/handlers/get-user-profile/app.ts');
const { handler: updateUserProfile } = await import('./src/handlers/update-user-profile/app.ts');
const { handler: updateUserPreferences } = await import('./src/handlers/update-user-preferences/app.ts');
const { handler: updateUserNotifications } = await import('./src/handlers/update-user-notifications/app.ts');
const { handler: getSavedOptions } = await import('./src/handlers/get-saved-options/app.ts');
const { handler: updateSavedOptions } = await import('./src/handlers/update-saved-options/app.ts');
const { handler: createOrderRazorpay } = await import('./src/handlers/create-order-razorpay/app.ts');
const { handler: getSubscriptionPlans } = await import('./src/handlers/get-subscription-plans/app.ts');
const { handler: createSubscription } = await import('./src/handlers/create-razorpay-subscription/app.ts');
const { handler: manageSubscription } = await import('./src/handlers/manage-razorpay-subscription/app.ts');
const { handler: verifyPayment } = await import('./src/handlers/verify-payment-razorpay/app.ts');
const { handler: razorpayWebhook } = await import('./src/handlers/razorpay-webhook/app.ts');

// Local-only: manual stats rebuild (simulates DynamoDB Stream → update-stats)
const { DynamoDBDocumentClient, QueryCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand } = await import('@aws-sdk/lib-dynamodb');
const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
const { computeDailyRecord } = await import('./src/shared/stats-aggregator.ts');
const { extractDate, calcPnL } = await import('./src/shared/utils/pnl.ts');
const { getUserId } = await import('./src/shared/auth.ts');

const localDdb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));
const TRADES_TBL = process.env.TRADES_TABLE!;
const DAILY_STATS_TBL = process.env.DAILY_STATS_TABLE!;
const ACCOUNTS_TBL = process.env.ACCOUNTS_TABLE!;

async function rebuildStatsForUser(userId: string): Promise<{ dailyRecords: number; accountsUpdated: number; totalPnl: number }> {
  // 1. Query ALL trades for the user
  const allTrades: any[] = [];
  let lastKey: any;
  do {
    const resp = await localDdb.send(new QueryCommand({
      TableName: TRADES_TBL,
      KeyConditionExpression: 'userId = :u',
      ExpressionAttributeValues: { ':u': userId },
      ExclusiveStartKey: lastKey,
    }));
    allTrades.push(...(resp.Items || []));
    lastKey = resp.LastEvaluatedKey;
  } while (lastKey);

  // 2. Group trades by (accountId, date) for daily stats
  const dayMap = new Map<string, any[]>(); // "accountId#date" → trades
  const accountPnL: Record<string, number> = {};

  for (const t of allTrades) {
    const acct = t.accountId;
    if (!acct || acct === '-1') continue;
    const date = extractDate(t.openDate);
    if (!date) continue;

    const key = `${acct}#${date}`;
    if (!dayMap.has(key)) dayMap.set(key, []);
    dayMap.get(key)!.push(t);

    const pnl = calcPnL(t);
    if (pnl != null) accountPnL[acct] = (accountPnL[acct] || 0) + pnl;
  }

  // 3. Write daily stats records
  let dailyRecords = 0;
  for (const [key, trades] of dayMap) {
    const [accountId, date] = key.split('#', 2);
    const record = computeDailyRecord(userId, accountId, date, trades);
    if (record) {
      await localDdb.send(new PutCommand({ TableName: DAILY_STATS_TBL, Item: record }));
      dailyRecords++;
    }
  }

  // 4. Update account balances
  let accountsUpdated = 0;
  let totalPnl = 0;
  for (const [accountId, pnl] of Object.entries(accountPnL)) {
    totalPnl += pnl;
    const acctResp = await localDdb.send(new GetCommand({
      TableName: ACCOUNTS_TBL,
      Key: { userId, accountId },
      ProjectionExpression: 'initialBalance',
    }));
    if (!acctResp.Item) continue;
    const newBalance = (acctResp.Item.initialBalance || 0) + pnl;
    await localDdb.send(new UpdateCommand({
      TableName: ACCOUNTS_TBL,
      Key: { userId, accountId },
      UpdateExpression: 'SET #balance = :balance, #updatedAt = :updatedAt',
      ExpressionAttributeNames: { '#balance': 'balance', '#updatedAt': 'updatedAt' },
      ExpressionAttributeValues: { ':balance': Math.round(newBalance * 100) / 100, ':updatedAt': new Date().toISOString() },
    }));
    accountsUpdated++;
  }

  return { dailyRecords, accountsUpdated, totalPnl: Math.round(totalPnl * 100) / 100 };
}

// Route table: [method, pathPattern, handler]
type HandlerFn = (event: any, context?: any) => Promise<any>;
const routes: [string, RegExp, HandlerFn][] = [
  // Auth (no auth required)
  ['POST', /^\/v1\/auth\/signup$/, authSignup],
  ['POST', /^\/v1\/auth\/confirm-signup$/, authConfirmSignup],
  ['POST', /^\/v1\/auth\/login$/, authLogin],
  ['POST', /^\/v1\/auth\/refresh$/, authRefresh],
  ['POST', /^\/v1\/auth\/forgot-password$/, authForgotPassword],
  ['POST', /^\/v1\/auth\/confirm-forgot-password$/, authConfirmForgotPassword],

  // Trades
  ['POST', /^\/v1\/trades$/, createTrade],
  ['GET',  /^\/v1\/trades$/, listTrades],
  ['PUT',  /^\/v1\/trades\/([^/]+)$/, updateTrade],
  ['DELETE', /^\/v1\/trades\/([^/]+)$/, deleteTrade],
  ['POST', /^\/v1\/trades\/bulk-delete$/, bulkDeleteTrades],
  ['POST', /^\/v1\/trades\/extract$/, extractTrades],

  // Images
  ['GET',  /^\/v1\/images\/(.+)$/, getImage],

  // Stats
  ['GET',  /^\/v1\/stats$/, getStats],
  ['GET',  /^\/v1\/goals\/progress$/, getGoalsProgress],

  // Accounts
  ['GET',  /^\/v1\/accounts$/, listAccounts],
  ['POST', /^\/v1\/accounts$/, createAccount],
  ['PUT',  /^\/v1\/accounts\/([^/]+)$/, updateAccount],
  ['PATCH', /^\/v1\/accounts\/([^/]+)\/status$/, updateAccountStatus],
  ['DELETE', /^\/v1\/accounts\/([^/]+)$/, deleteAccount],

  // Goals & Rules
  ['PUT',  /^\/v1\/goals\/([^/]+)$/, updateGoal],
  ['GET',  /^\/v1\/rules$/, listRules],
  ['GET',  /^\/v1\/rules-goals$/, getRulesGoals],
  ['POST', /^\/v1\/rules$/, createRule],
  ['PUT',  /^\/v1\/rules\/([^/]+)$/, updateRule],
  ['PATCH', /^\/v1\/rules\/([^/]+)\/toggle$/, toggleRule],
  ['DELETE', /^\/v1\/rules\/([^/]+)$/, deleteRule],

  // Analytics
  ['GET',  /^\/v1\/analytics$/, analytics],

  // User
  ['GET',  /^\/v1\/user\/profile$/, getUserProfile],
  ['PUT',  /^\/v1\/user\/profile$/, updateUserProfile],
  ['PUT',  /^\/v1\/user\/preferences$/, updateUserPreferences],
  ['PUT',  /^\/v1\/user\/notifications$/, updateUserNotifications],

  // Saved options
  ['GET',  /^\/v1\/options$/, getSavedOptions],
  ['PUT',  /^\/v1\/options$/, updateSavedOptions],

  // Enhance text
  ['POST', /^\/v1\/enhance-text$/, enhanceText],

  // Payments & Subscriptions
  ['POST', /^\/v1\/payments\/create-order$/, createOrderRazorpay],
  ['GET',  /^\/v1\/subscriptions\/plans$/, getSubscriptionPlans],
  ['POST', /^\/v1\/subscriptions$/, createSubscription],
  ['GET',  /^\/v1\/subscriptions$/, manageSubscription],
  ['PUT',  /^\/v1\/subscriptions$/, manageSubscription],
  ['PATCH', /^\/v1\/subscriptions$/, manageSubscription],
  ['DELETE', /^\/v1\/subscriptions$/, manageSubscription],
  ['POST', /^\/v1\/payments\/verify$/, verifyPayment],
  ['POST', /^\/v1\/payments\/webhook$/, razorpayWebhook],
];

function buildLambdaEvent(req: http.IncomingMessage, body: string, pathMatch: RegExpMatchArray): any {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const queryStringParameters: Record<string, string> = {};
  url.searchParams.forEach((v, k) => { queryStringParameters[k] = v; });

  // Extract path parameters from regex groups
  const pathParameters: Record<string, string> = {};
  if (pathMatch[1]) {
    pathParameters.tradeId = pathMatch[1];
    pathParameters.accountId = pathMatch[1];
    pathParameters.goalId = pathMatch[1];
    pathParameters.ruleId = pathMatch[1];
    pathParameters.imageId = pathMatch[1];
  }

  return {
    httpMethod: req.method,
    requestContext: {
      http: { method: req.method, path: url.pathname },
      requestId: `local-${Date.now()}`,
      authorizer: { jwt: { claims: {} } },
    },
    headers: req.headers,
    queryStringParameters: Object.keys(queryStringParameters).length ? queryStringParameters : null,
    pathParameters: Object.keys(pathParameters).length ? pathParameters : null,
    body: body || null,
    isBase64Encoded: false,
  };
}

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Expose-Headers', 'authorization,content-type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url!, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const method = req.method!.toUpperCase();

  // Collect body
  const chunks: Buffer[] = [];
  req.on('data', (chunk) => chunks.push(chunk));
  await new Promise<void>((resolve) => req.on('end', resolve));
  const body = Buffer.concat(chunks).toString();

  // Find matching route
  for (const [routeMethod, pattern, handler] of routes) {
    if (routeMethod !== method) continue;
    const match = pathname.match(pattern);
    if (!match) continue;

    const event = buildLambdaEvent(req, body, match);
    try {
      const result = await (handler as any)(event, {});
      const statusCode = result?.statusCode || 200;
      const responseHeaders = result?.headers || {};
      const responseBody = result?.body || '';

      res.writeHead(statusCode, { 'Content-Type': 'application/json', ...responseHeaders });
      res.end(responseBody);
      console.log(`  ${method} ${pathname} => ${statusCode}`);

      // Auto-rebuild stats after successful trade mutations (simulates DynamoDB Stream)
      const isTradeMutation = /^\/v1\/trades/.test(pathname) && ['POST', 'PUT', 'DELETE'].includes(method);
      if (isTradeMutation && statusCode >= 200 && statusCode < 300) {
        const userId = getUserId(event);
        if (userId) {
          rebuildStatsForUser(userId)
            .then(r => console.log(`  [auto-rebuild] stats updated: ${r.dailyRecords} days, ${r.accountsUpdated} accounts, totalPnl=${r.totalPnl}`))
            .catch(e => console.error(`  [auto-rebuild] failed:`, e.message));
        }
      }
    } catch (err: any) {
      console.error(`  ERROR ${method} ${pathname}:`, err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Internal Server Error', error: err.message }));
    }
    return;
  }

  // No route matched
  console.log(`  404: ${method} ${pathname}`);
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ message: `Not Found: ${method} ${pathname}` }));
});

const PORT = 3001;
server.listen(PORT, () => {
  console.log(`\n  Local API server running at http://localhost:${PORT}/v1`);
  console.log(`  Watching for file changes...\n`);
});
