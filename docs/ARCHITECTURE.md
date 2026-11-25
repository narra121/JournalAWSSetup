# TradeQut backend architecture

How the backend in this repo is built and where each thing is handled. Read this before changing the API, the data, the
billing rules or the deploy. The error body format is defined once, in the "Error contract" section of
[README.md](../README.md); this file only links to it. Day-to-day operation is in
[runbooks/operations.md](runbooks/operations.md).

The code in the working tree is the source of truth. Where this file names a file or a symbol, open it for the current
values (routes, limits, prices and table names are not copied here).

## 1. Request path

```
Browser
  -> CloudFront distribution (api.tradequt.com / api-dev.tradequt.com), OAC signs the request with SigV4
  -> Lambda Web Function  <StageName>-api, endpoint "live"  (one Hono app, bundle of src/app/server.ts)
  -> src/app/app.ts  createApp()
  -> route handler
```

| Hop | Where it is defined | Notes |
|---|---|---|
| CloudFront | `ApiDistribution`, `ApiCachePolicy`, `ApiResponseHeadersPolicy`, `ApiOAC` in `template.yaml` | Default behavior plus a `/v1/chat/*` behavior with compression off (streamed chat). Origin read timeout 60 s. The cache policy has TTL 0 (nothing is cached) and forwards `Authorization` and `CloudFront-Viewer-Country`. |
| Web Function | `ApiWebFunction`, `ApiRevision`, `ApiEndpoint` in `template.yaml` | Runtime nodejs24.x, timeout 58 s (just under CloudFront's 60 s), throttle and max environments set on `ApiEndpoint`. A code change makes a new revision; `ApiEndpoint` sends 100 % of traffic to it. |
| Server entry | `src/app/server.ts` | Starts Hono with `@hono/node-server`. On Lambda it binds the address in `AWS_LAMBDA_HTTP_ENDPOINT`; locally it binds `127.0.0.1:$PORT` (default 3001). It passes `featureRoutes` from `src/features/index.ts` to `createApp`. |
| App | `src/app/app.ts` | Builds the middleware chain and mounts every route. |

### Middleware order (`src/app/app.ts`)

Global, for every request:

1. `requestLog` (`src/app/http/log.ts`): sets `requestId` (header `lambda-web-request-id`, else a UUID), adds `x-request-id` to the response, defaults `Cache-Control: no-store`, writes one JSON access-log line.
2. `apiGatewayCors` (`src/app/http/cors.ts`): allowed origins come from `ALLOWED_ORIGINS`; answers `OPTIONS` with 204. Keep its header lists in step with `ApiResponseHeadersPolicy` in `template.yaml` (a comment in the file says so).
3. `errorContract` (`src/app/http/errors.ts`): rewrites every response with status >= 400 (except event streams) into the error body of the README "Error contract". Unknown routes use `notFound` and thrown errors use `onError` (500 with `requestId`).

Per route, by auth group (`AuthGroup` in `src/app/routes.ts`):

| Group | Middleware chain before the handler |
|---|---|
| `public` | none (`POST /v1/errors/report` adds `optionalUser`) |
| `admin` | `requireAdmin` (`src/app/auth/admin.ts`) |
| `cognito` | `signedIn()` in `app.ts` = `requireUser` (`src/app/auth/cognito.ts`) -> `userRateLimit` (`src/app/http/rate-limit.ts`) -> `withEntitlements` -> `readOnlyGuard` (both in `src/app/billing/middleware.ts`) |

After that, a route's own `extra` middleware runs (`metered(feature)` for AI quotas, `advancedAnalyticsGate` for `GET /v1/stats`), then the handler.

### Where routes are registered

| Registration | File | Used for |
|---|---|---|
| `LEGACY_ROUTES` table (method, path in API Gateway notation, auth group, handler, optional `extra`) | `src/app/routes.ts` | Handlers under `src/handlers/<route>/app.ts`: trades, accounts, goals, rules, options, user, auth, subscriptions, payments webhook, images, admin. |
| `app.route('/v1', ...)` and `app.use(path, ...signedIn())` | `src/app/app.ts` | App modules under `src/app/<module>/routes.ts`: account (`src/app/account`), billing and `/me` (`src/app/billing`), goals history (`src/app/goals`), uploads (`src/app/uploads`), journal (`src/app/journal`). |
| `featureRoutes` array | `src/features/index.ts` | Feature sub-apps mounted at `/v1<basePath>` behind `signedIn()`: import, insights (with focus), chat, reports, analysis. |

The adapter (`src/app/http/adapter.ts`) lets a `src/handlers/*` function run unchanged: `lambdaRoute` builds an API Gateway HTTP API v2 event from the Hono request (`toApiGatewayEvent`: lower-cased headers, `pathParameters` from the route, text bodies as strings and other bodies base64, verified claims placed in `requestContext.authorizer.jwt.claims`), calls the handler, and `fromLambdaResult` turns the `{ statusCode, headers, body }` result back into a response.

### The three code homes

| Home | Shape | Put new code here when |
|---|---|---|
| `src/handlers/<route>/app.ts` | `export const handler` taking an API Gateway v2 event, returning `{ statusCode, body }` via `envelope` / `errorResponse` (`src/shared/validation.ts`); identity from `getUserId(event)` (`src/shared/auth.ts`) | You extend a route of an existing handler family (trades, accounts, goals, rules, options, user, subscriptions, admin, auth). One folder per route plus `__tests__/app.test.ts`. |
| `src/app/<module>/routes.ts` | Hono sub-app typed with `AppEnv` (`src/app/types.ts`); reads `c.get('userId')`, `c.get('entitlements')`, `c.get('quota')`; answers with `c.json({ success: true, message, data })` or `fail` from `src/features/http.ts` | The code is platform behavior of the app itself: account, billing, uploads, journal, anything that touches plan or identity. |
| `src/features/<feature>/` | Hono sub-app factory `xxxApp(deps)` with injected dependencies (stores, AI client) so tests need no AWS; helpers `ok`, `fail`, `quotaFail`, `readJson` from `src/features/http.ts` | A product feature with its own domain logic and data (import, AI insights and chat, analysis, reports). The contract it codes against is `src/app/types.ts` (extend it additively only). |

Shared logic that more than one of these needs goes in `src/shared/` (section 6). The convention is to extend the home where the resource already lives; a new area is a new Hono sub-app (module or feature) rather than a new handler.

## 2. Local dev server

`bun run dev` runs `bun --watch src/app/server.ts`: the same Hono app and the same features as Lambda, on `http://127.0.0.1:3001/v1/...`.

- It talks to the real deployed dev tables, buckets and SSM parameters, so it needs AWS credentials (`AWS_PROFILE=personal`, region us-east-1).
- Copy `.env.example` and fill it in. Env var names mirror `EnvironmentVariables` of `ApiRevision` in `template.yaml`. The bucket names, `USER_POOL_ID` and `USER_POOL_CLIENT_ID` come from the stack outputs (`bun run outputs:dev`).
- The physical table names are `<Table>-<StageName>` with `StageName` = `tradequt-dev` (for example `Accounts-tradequt-dev`, `Trades-tradequt-dev-v1`; check with `aws dynamodb list-tables`). The sample values in `.env.example` (`Accounts-dev` and so on) do not match the deployed names: use the real ones.
- `STAGE_NAME` is `dev` or `prod` (the template's `Environment` parameter), not the `tradequt-dev` stack name. Stripe SSM paths are built from it (`/tradequt/<STAGE_NAME>/stripe/...`).
- `RATE_LIMIT_TABLE` unset turns the per-user request limit off (`userRateLimit`).
- `createApp()` called without arguments (as the tests do) mounts no feature routes. Only `server.ts` passes `featureRoutes`.
- `.env.example` sets `ALLOWED_ORIGINS=http://localhost:8080`; the origin of the frontend you run must be in that list or the browser blocks the response.

## 3. Auth

### Signed-in users (Cognito)

- `requireUser` verifies the `Authorization: Bearer` token in-process with `aws-jwt-verify` (`CognitoJwtVerifier`, built from `USER_POOL_ID` and `USER_POOL_CLIENT_ID`, `tokenUse: null` so ID and access tokens both pass). Failure answers 401 `UNAUTHORIZED`.
- The user id for all data scoping is `claims.sub`, stored as `userId` in the context (`c.get('userId')`) and in `requestContext.authorizer.jwt.claims` for handlers (`getUserId` in `src/shared/auth.ts`). Every table's partition key is `userId` (section 5), so a query is scoped by passing the caller's `userId`. No handler should take a user id from the request body or path; the `/v1/admin/*` routes are the exception and are admin-only.
- Tokens are verified offline. `POST /v1/auth/logout-all` revokes refresh tokens only; an issued access token lives until it expires (about an hour).
- Login, signup, refresh, forgot and confirm routes are public handlers (`src/handlers/auth-*`) that call Cognito and are rate limited per e-mail with `checkRateLimit` (`src/handlers/auth-rate-limit-wrapper/rateLimit.ts`, table `AuthRateLimit`). The same table holds the per-user counter `user:<sub>` used by `userRateLimit`.
- Cognito setup (`UserPool`, `UserPoolClient`, optional `GoogleIdentityProvider`, `UserPoolDomain`) is in `template.yaml`. The pool sends its own mails through SES (`EmailConfiguration`); the template sets no custom verification message.

### Cognito triggers (run in the Event Function)

| Trigger | Module | What it does |
|---|---|---|
| `PreSignUp_ExternalProvider` (Google) | `src/handlers/auth-pre-signup/app.ts` | Auto-confirms; when the provider says the e-mail is verified, links the Google identity to an existing confirmed e-mail/password user, and deletes an unconfirmed one with the same address. A link failure is logged and does not block sign-in. |
| `PreSignUp_SignUp` (e-mail/password) | same | Never auto-confirms. Refuses the sign-up when a confirmed or Google user already owns the address (the frontend's `authService` matches the text `USER_EXISTS`). |
| `PostConfirmation_ConfirmSignUp` | `src/handlers/auth-post-confirmation/app.ts` | Creates the default rules (`createDefaultRules`), the default saved options (`createDefaultSavedOptions`) and the trial row in `Subscriptions` (`TRIAL_DAYS`, `PLANS_VERSION` from `src/app/billing/entitlements.ts`). Throws if the trial row cannot be written, so Cognito retries. When the trial row is new it then sends the welcome mail (`welcomeMail`), best effort with a 2 s cap, so a failed send never fails the confirmation. |

### Admin

- `POST /v1/admin/login` (`src/handlers/admin-login/app.ts`, public): checks the password against the SSM parameter named by `ADMIN_SECRET_PARAM` (constant-time compare), after two rate limits in `AuthRateLimit` (per source IP and one global bucket), and returns an HS256 JWT signed with the secret in `ADMIN_JWT_SECRET_PARAM` (`signAdminToken` in `src/shared/admin-jwt.ts`, 4 hour expiry, payload `role: 'admin'`).
- `requireAdmin` calls the authorizer logic in `src/handlers/admin-authorizer/app.ts` (`verifyAdminToken`, secret cached 15 minutes). No header = 401; bad token = 403; an SSM failure throws and answers 500.
- Admin routes (`/v1/admin/*`) skip the user middleware: no entitlements and no per-user rate limit. They read and write any user's data through the same tables.
- SSM names are the stack parameters `AdminSecretParamName` and `AdminJwtSecretParamName` (section 5, SSM). Prod must use names under `/tradequt/prod/`; `scripts/deploy.mjs` refuses otherwise.
- `PUT /v1/admin/config` can only write the ad configuration parameter (`AD_CONFIG_PARAM`).

## 4. Event Function (`src/app/events.ts`)

One Lambda, `<StageName>-events` (`EventFunction` in `template.yaml`, nodejs24.x, arm64, 600 s timeout). Its handler looks at the event and calls one module:

| Event source (in `template.yaml`) | How `events.ts` recognizes it | Module | What happens |
|---|---|---|---|
| Cognito PreSignUp (`UserPool` `LambdaConfig`) | `triggerSource` starts with `PreSignUp_` | `src/handlers/auth-pre-signup/app.ts` | see section 3 |
| Cognito PostConfirmation | `PostConfirmation_` | `src/handlers/auth-post-confirmation/app.ts` | see section 3 |
| `TradesStream` (Trades table stream, batch 100, 2 retries, failures to `StatsDLQ`) | `Records[0].eventSource = aws:dynamodb` and the ARN is not the preferences table | `src/handlers/update-stats/app.ts` | Per trade change: adjusts the account balance and trade count with atomic ADDs, rebuilds the affected `DailyStats` day records (`computeDailyRecord`), flags the user in the `#dirty` partition (`markStatsDirty`), adds new symbols to `SavedOptions`, and when the TTL removes a soft-deleted trade, deletes its screenshots (`removeImagesForTrade`). Returns `batchItemFailures`. |
| `PreferencesStream` (UserPreferences stream) | ARN contains `:table/UserPreferences-` | `src/handlers/preference-changes/app.ts` | When a user's `timeZone` changes, rebuilds that user's stats with `rebuildForUser(userId, { force: true })`. |
| `RebuildStats` schedule, `rate(6 hours)` | `event.job = 'rebuild-stats'` | `src/handlers/rebuild-stats-job/app.ts` | Rebuilds balances and day records for the users listed in the `#dirty` partition and clears their flag. |
| `LifecycleEmails` schedule, `cron(0 4 * * ? *)` | `job = 'lifecycle-emails'` | `runLifecycleEmails` in `src/handlers/lifecycle-emails/app.ts` | Scans `Subscriptions`; mails trial users 3 days before the end and once after it ended; a marker attribute on the row (`trialEndingEmailFor`, `trialEndedEmailFor`) stops repeats. In the first week it also sends up to three getting-started mails: day 1, 3 and 7 after `trialStarted`, chosen by whether the journal has trades, markers `gettingStartedDay1For` / `gettingStartedDay3For` / `gettingStartedDay7For`, skipped when `notifications.tradeReminders` is false (the Settings switch "Getting-started emails"). |
| `WeeklyInsights` schedule, `cron(30 4 ? * MON *)` | `job = 'weekly-insights'` | `runWeeklyReports` in the same file, wired by `defaultWeeklyDeps` | For Pro and trial users with the weekly report on, generates an insight per currency with enough trades (`generateInsight` in `src/features/insights/service.ts`, using the user's own quota) and sends a "report ready" mail. |

Anything else throws `Unsupported event`, which raises the `EventFunctionErrors-<StageName>` alarm. Schedules are UTC (EventBridge).

`events.ts` also exports `legacyExtract` (`src/app/legacy-extract.ts`). It runs as a separate function URL (`LegacyExtractFunction`), created only when `ProdUserPoolId` and `ProdUserPoolClientId` are set, which `scripts/deploy.mjs` does for dev. It exists so the prod frontend's old extract call keeps working against dev.

Stream consumers must be safe to retry: Lambda re-delivers a failed batch. `update-stats` keeps ADD-based counters and its comments say a failed ADD is left for `rebuild-stats-job` to correct.

## 5. Data

### DynamoDB tables (`template.yaml`)

Physical name = `<Table>-<StageName>` (Trades: `Trades-<StageName>-<ApiVersion>`), with `StageName` `tradequt-dev` or `tradequt-prod`. All tables are pay-per-request, have point-in-time recovery, and have `DeletionPolicy` and `UpdateReplacePolicy` set to `Retain`. Every partition key is `userId` except `AuthRateLimit`.

| Logical resource | Env var | Key (PK / SK) | Extras | Holds | Read or written by |
|---|---|---|---|---|---|
| `TradesTable` | `TRADES_TABLE` | `userId` / `tradeId` | GSI `trades-by-date-gsi` (`userId`, `openDate`, keys only); GSI `user-idempotency-gsi` (`userId`, `idempotencyKey`, keys only); stream (new and old images); TTL `ttl` | Trades, including soft-deleted ones (`deletedAt`, `ttl`) | trade handlers (create, update, delete, restore, bulk, sync, list, get), `update-stats`, `rebuild-stats-job`, `src/shared/softDelete.ts`, `src/shared/tradeRecords.ts`, `src/features/trades-repo.ts`, account export and purge |
| `DailyStatsTable` | `DAILY_STATS_TABLE` | `userId` / `sk` = `<accountId>#<date>` | GSI `stats-by-date-gsi` (`userId`, `date`, all attributes) | One aggregate record per account per day. The partition `userId = '#dirty'` lists users to rebuild (`src/shared/statsDirty.ts`). | `update-stats`, `rebuild-stats-job`, `get-stats` and goals through `src/shared/dailyStats.ts`, `delete-rule` |
| `AuthRateLimitTable` | `RATE_LIMIT_TABLE` | `key` | TTL `ttl` | Rate-limit counters (`login:<email>`, `user:<sub>`, `admin-login:...` and so on) | `checkRateLimit`, `userRateLimit` |
| `AccountsTable` | `ACCOUNTS_TABLE` | `userId` / `accountId` | | Trading accounts (balance, currency, trade count, status) | account handlers, `update-stats`, `rebuild-stats-job`, `get-stats`, `src/features/analysis/load.ts` |
| `GoalsTable` | `GOALS_TABLE` | `userId` / `goalId` | | Goals | goal handlers, `get-goals-progress` |
| `RulesTable` | `RULES_TABLE` | `userId` / `ruleId` | | Trading rules | rule handlers, `get-goals-progress`, `src/shared/user-initialization.ts` |
| `UserPreferencesTable` | `USER_PREFERENCES_TABLE` | `userId` | stream (new and old images) | Preferences, profile, notification switches, `timeZone` | user handlers, `src/shared/timezone.ts` (`getUserTimeZone`), `lifecycle-emails` |
| `SavedOptionsTable` | `SAVED_OPTIONS_TABLE` | `userId` | | Saved symbols, setups and other dropdown values | options handlers, `update-stats` |
| `SubscriptionsTable` | `SUBSCRIPTIONS_TABLE` | `userId` | | Plan state: trial dates, Stripe ids and status, `plansVersion`, e-mail markers | `src/app/billing/*`, Stripe handlers, `lifecycle-emails`, admin handlers |
| `AiDataTable` | `AI_DATA_TABLE` | `userId` / `sk` | | Rows by sort-key prefix: `INSIGHT#`, `CHAT#`, `MSG#`, `IMPORT#` (features) and `DAYNOTE#` (journal) | `src/features/store.ts`, `src/app/journal/routes.ts` |
| `UsageTable` | `USAGE_TABLE` | `userId` / `sk` = `<YYYY-MM>#<feature>` | TTL `ttl` | Monthly quota counters | `src/app/billing/quota.ts` |

The account also holds `InsightsCache-*` tables; they are not in `template.yaml` and no file in this repo references them.

Both Lambda roles list their tables in `template.yaml`: `ApiFunctionRole` (all eleven) and the `EventFunction` policy (all except `Goals` and `AuthRateLimit`).

### S3

| Bucket (logical) | Env var | Holds | Rules in `template.yaml` |
|---|---|---|---|
| `ImagesBucket` | `IMAGES_BUCKET` | Trade screenshots under `images/<userId>/<tradeId>/` and pending uploads under `images/upload/<userId>/` | Private (public access blocked, TLS only). Objects under `images/` move to Glacier IR and expire after years; `images/upload/` expires after 1 day. CORS allows GET and PUT from `AllowedOrigins`. |
| `ErrorReportsBucket` | `ERROR_REPORTS_BUCKET` | Client error reports under `errors/<userId>/` (`src/handlers/report-error/app.ts`) | Glacier after 30 days, expire after 365. |
| Artifacts bucket (stack `tradequt-artifacts`, `infra/artifacts.yaml`) | none at runtime | Versioned Web and Event Function zips and the uploaded template | Used only by `scripts/deploy.mjs`. |
| `FrontendBucket`, `AdminBucket` (conditional) | none | Static frontend and admin console | Deployed by the scripts in `TradeQut-Research/release/`, not by this repo. |

Screenshot flow:

1. `POST /v1/uploads/images` (`src/app/uploads/routes.ts`) validates type (png, jpeg, webp) and size, enforces a per-day cap, and returns a presigned S3 PUT URL for `images/upload/<userId>/<uuid>.<ext>`. The browser uploads straight to S3.
2. Creating or updating a trade (`create-trade`, `update-trade`) calls `adoptUploads` (`src/shared/images.ts`), which copies each upload to `images/<userId>/<tradeId>/<file>` and stores that key in the trade's `images[]`. `ownsImageKey` rejects keys of other users.
3. Reading uses no presigned URL: `GET /v1/images/{imageId+}` (`src/handlers/get-image/app.ts`) checks the key belongs to the caller, reads the object and returns it base64 through the Lambda. The handler adds the `images/` prefix itself. The frontend caches the result (`TradeFlow/src/store/api/imageCache.ts`).
4. When the TTL removes a soft-deleted trade, `update-stats` removes its folder; account deletion removes all of a user's objects (`purgeUser`).

### SSM parameters

No secret value is stored in this repo or in `template.yaml`. The template passes parameter names as stack parameters and env vars; the code reads values at run time.

| Name or pattern | Stack parameter / env var | Read by | Why |
|---|---|---|---|
| `/tradequt/openrouterApiKey` | `OpenRouterApiKeyParamName` / `OPENROUTER_API_KEY_PARAM` | `src/features/ai/*`, `src/shared/gemini.ts` | AI provider key (OpenRouter is the default) |
| `/tradequt/geminiApiKey` | `GeminiApiKeyParamName` / `GEMINI_API_KEY_PARAM` | same | Direct Gemini key, used when `AiProvider` is `gemini` |
| `/tradequt/<env>/stripeSecretKey`, `/tradequt/<env>/stripeWebhookSecret` | `StripeSecretKeyParamName`, `StripeWebhookSecretParamName` | `src/shared/stripe-config.ts` (`readParam`, 15 min cache) | Stripe API and webhook signing |
| `/tradequt/<env>/stripe/price/pro_<month or year>_<usd or inr>`, `/tradequt/<env>/stripe/portalConfigId` | none (path built from `STAGE_NAME`; IAM wildcard `/tradequt/<env>/stripe/*`) | `proPriceId`, `portalConfigId`, `get-subscription-plans` | Stripe price ids and portal configuration; written by `scripts/stripe/*` |
| `/tradequt/<env>/adConfig` | `AdConfigParamName` / `AD_CONFIG_PARAM` | `get-ad-config` and `admin-get-config` (read), `admin-update-config` (write; the web role has `ssm:PutParameter` on this one name) | Ad placement JSON |
| `/tradequt/adminSecret`, `/tradequt/adminJwtSecret` (dev defaults; prod under `/tradequt/prod/`) | `AdminSecretParamName`, `AdminJwtSecretParamName` | `admin-login`, `admin-authorizer` | Admin password and JWT signing key |
| `/tradequt/<env>/userPoolId` | env `USER_POOL_ID_PARAM` (Event Function) | `src/shared/email.ts` | Created by the stack (`UserPoolIdParam`); lets the Event Function look up a user's e-mail without a circular template reference |

## 6. Domain modules

### `src/shared/` (used by handlers, modules and features)

| Concern | Files |
|---|---|
| DynamoDB client, batch writes | `dynamo.ts` (`ddb`), `batchWrite.ts` |
| Error body and validation | `apiError.ts` (error contract), `validation.ts` (ajv, `envelope`, `errorResponse`, `ErrorCodes`) |
| Trades: shape and storage | `tradeFields.ts` (optional contract fields), `presentTrade.ts` (stored trade to API shape), `softDelete.ts` (30-day soft delete and restore), `tradeRecords.ts` (BatchGet of full records), `tags.ts`, `utils/pnl.ts` (`calcPnL`) |
| Stats | `stats-aggregator.ts` (`computeDailyRecord`, `aggregateDailyRecords`), `metrics/registry.ts` and `metrics/processors/*` (one processor pair per metric group, registered in `processors/index.ts`), `dailyStats.ts` (queries), `statsDirty.ts`, `statsSections.ts`, `advanced-stats.ts` |
| Time | `timezone.ts` (`dayOf`, `dayQueryRange`, `getUserTimeZone`): every day bucket is a calendar day in the user's zone |
| Currency | `currency.ts` (accepted account currencies) |
| Goals and rules defaults | `goalDefaults.ts`, `defaults.ts`, `user-initialization.ts` |
| Billing helpers | `stripe-config.ts`, `stripe-status.ts`, `subscription.ts` |
| Mail | `email.ts` |
| AI text calls (extract, enhance) | `gemini.ts` (`aiProvider()`, `generateText`) |
| Account data | `account-data.ts` (`exportUserData`, `purgeUser`) |
| Identity | `auth.ts`, `admin-jwt.ts`, `cognitoUser.ts`, `cognitoFilter.ts`, `cognitoErrors.ts`, `passwordValidation.ts` |
| Images, logging | `images.ts`, `s3.ts`, `logger.ts` |

### Who owns what

| Topic | Owner | Notes |
|---|---|---|
| Trades CRUD | `src/handlers/create-trade`, `update-trade`, `delete-trade`, `get-trade`, `list-trades`, `restore-trades`, `sync-trades`, `bulk-update-trades`, `bulk-delete-trades` | Stored shape built in `create-trade` (`buildItem`) and `update-trade`; returned through `presentTrade`. P&L is the client's value, else `calcPnL`. |
| Accounts | `src/handlers/create-account`, `update-account`, `list-accounts`, `delete-account`, `update-account-status` | Balance and trade count are kept by `update-stats`; `list-accounts` can set them absolutely. |
| Stats | write: `update-stats`, `rebuild-stats-job`; read: `get-stats` | `get-stats` reads day records (`queryDailyStats`), merges them (`aggregateDailyRecords`) and adds `buildAdvancedStats` for `sections=advanced` (plan-gated by `advancedAnalyticsGate`). A new metric is a processor under `src/shared/metrics/processors/`. |
| Goals and rules | `src/handlers/create-goal`, `update-goal`, `get-goals-progress`, `create-rule`, `update-rule`, `delete-rule`, `list-rules`, `get-rules-goals`; history in `src/app/goals/history.ts` | Progress is computed from `DailyStats`, not from trades. |
| Journal day notes | `src/app/journal/routes.ts` | Stored in `AiData` under `DAYNOTE#<date>#<scope>`. |
| Import (broker files) | `src/features/import/` | Parsers in `parsers/` are listed in `registry.ts` (`PARSERS`); `detect.ts` picks one. Zerodha, Upstox, Angel One and Groww are `makeFillParser` configs in `parsers/fills.ts` whose fills `roundtrip.ts` pairs FIFO; MT4/MT5 are in `parsers/mt.ts`; Dhan's Global Transaction Report (daily buy and sell totals per contract) is in `parsers/dhan.ts`. `service.ts` turns rows into trades (`computePnl` from `src/features/pnl`): charges listed in the file are kept (`chargesEstimated: false`), otherwise they are estimated (`charges/india.ts`). `xlsx.ts` reads UTF-8 and UTF-16 sheet parts. The fixtures are written by `fixtures/generate.mjs` in the brokers' real export layouts. The parse route consumes the `broker_import` quota. |
| P&L engine | `src/features/pnl/index.ts` | Same algorithm as the frontend's `TradeFlow/src/lib/pnl`; both test against the same `vectors.json`. |
| Analysis | `src/features/analysis/` | `GET /v1/analysis`, what-if and query routes; no AI call. |
| Insights, focus, chat | `src/features/insights/`, `focus/`, `chat/` | Store in `AiData` through `src/features/store.ts`. Insights use the `ai_insight` quota, chat `ai_chat`. |
| AI provider | `src/features/ai/` (`openrouter.ts`, `gemini.ts`, `runner.ts`, `core.ts`) and `src/shared/gemini.ts` | `AI_PROVIDER` (stack parameter `AiProvider`) picks OpenRouter (default) or direct Gemini (`aiProvider()`). Model lists per purpose (report, chat, extract) are `OPENROUTER_MODELS` and `GEMINI_MODELS`. `extract-trades` and `enhance-text` call `generateText`. |
| Tax report | `src/features/reports/tax.ts` | Rules per financial year in `TAX_RULES`; gated by the `tax_report` plan feature. |
| Billing | `src/app/billing/` | See below. |
| Stripe | `src/app/billing/routes.ts` (checkout, portal), `src/handlers/stripe-webhook`, `create-stripe-checkout`, `manage-stripe-subscription`, `verify-checkout-session`, `get-subscription-plans` | The webhook (`POST /v1/payments/webhook`) verifies the signature, applies `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed` and `customer.subscription.created`, `updated`, `deleted`, and ignores an event older than the last one applied (`lastStripeEventAt`). A failure logs `stripe_webhook_failed`. |
| Mail | `src/shared/email.ts` | SES `SendEmail` from `FROM_EMAIL`. |
| Privacy | `src/app/account/routes.ts` and `src/shared/account-data.ts` | `GET /v1/auth/export`; `DELETE /v1/auth/account` cancels Stripe, deletes the user's items in every table, the screenshots and error reports, then the Cognito user. |

### Billing and entitlements

- `src/app/billing/entitlements.ts`: `computeEntitlements(subscription)` returns the plan (`free`, `trial`, `pro`), status, limits and features. `PRO_LIMITS`, `READ_ONLY_LIMITS`, `TRIAL_DAYS` and `PLANS_VERSION` live here. `plan: 'free'` means read-only: every write answers 402 `TRIAL_EXPIRED` (`readOnlyGuard`) except the exempt writes in `EXEMPT_WRITES` (`src/app/billing/middleware.ts`).
- `withEntitlements` loads the user's `Subscriptions` row once per request. A row without the current `plansVersion` is migrated (`effectiveSubscription`): a non-paying user gets a fresh trial of `TRIAL_DAYS`.
- Quotas: `createQuota` (`src/app/billing/quota.ts`) keeps atomic monthly counters in `Usage` (reset at the start of the next UTC month). `metered(feature)` takes units before the handler and refunds them when the response is >= 400. Quota features: `QuotaFeature` in `src/app/types.ts`. 402 bodies are built in `src/app/billing/responses.ts`. Every place that answers 402: `metered()` and `readOnlyGuard` in `src/app/billing/middleware.ts` (plus its `planRequired` check for `advanced_analytics`), `quotaFail` in `src/features/insights/routes.ts`, `src/features/chat/routes.ts` and `src/features/import/routes.ts`, `planRequired` in `src/features/reports/routes.ts`, and `src/app/legacy-extract.ts`.
- `GET /v1/me/entitlements` returns entitlements, usage, reset date, billing currency and writable accounts to the frontend.
- Currency: `billingCurrencyFor` gives INR for viewers CloudFront reports in India (`CloudFront-Viewer-Country`), USD otherwise; a customer who already has a currency keeps it.

## 7. Validation

- JSON schemas are in `src/schemas/*.schema.json`, exported from `src/schemas/index.ts`: trade create and update, signup, login, forgot and confirm password, error report. Other routes validate by hand in the handler or module.
- `getValidator(schema, key)` (`src/shared/validation.ts`) compiles with ajv (`allErrors`, `removeAdditional: true`, `useDefaults: true`) and caches by key. Because the trade schemas set `additionalProperties: false`, a property that is not in the schema is silently removed from the body, not rejected. A new trade field that is missing from both trade schemas is dropped without an error.
- A failed validation becomes `errorResponse(400, ErrorCodes.VALIDATION_ERROR, ..., formatErrors(validate.errors))`: `formatErrors` turns each ajv error into a sentence a trader can read. The resulting body is the `VALIDATION_ERROR` case with `error.fields` in the README "Error contract".
- Hono modules and features answer validation errors with `fail(c, 400, 'VALIDATION_ERROR', message)` (`src/features/http.ts`), which produces the same body.

## 8. Observability

| What | Where |
|---|---|
| Web logs | CloudWatch group `/aws/lambda/web/<StageName>-api` (`bun run logs:dev`, `bun run logs:prod`). Retention is the `LogRetentionDays` parameter. |
| Event logs | CloudWatch group `/aws/lambda/<StageName>-events` |
| Access log | One JSON line per request from `requestLog`: `msg: 'access'`, `requestId`, `method`, `route`, `status`, `ms`, `userId`. |
| App logs | `makeLogger` (`src/shared/logger.ts`: JSON with `level`, `msg`, `requestId`, `userId`; `LOG_LEVEL` filters) and plain `console.log(JSON.stringify(...))`. AI calls log `ai_call` and `ai_unavailable` (`src/features/ai/log.ts`). |
| Find one request | Every response carries `x-request-id`; a 500 body also has `requestId`. Search the web log group for it: `aws logs tail /aws/lambda/web/tradequt-dev-api --since 1h --filter-pattern '"<requestId>"'` (profile `personal`), or CloudWatch Logs Insights with `filter @message like "<requestId>"`. |
| Alarms (SNS topic `<StageName>-alarms`, optional `AlarmEmail`) | `EventFunctionErrors-<StageName>`, `StatsDlqVisible-<StageName>`, `ApiCloudFront5xx-<StageName>`, `StripeWebhookFailed-<StageName>`, `GeminiErrors-<StageName>`, `AdminLoginFailed-<StageName>`. The last three come from log metric filters in the namespace `TradeQut/<StageName>`. |

The `GeminiErrors` filter matches the text `gemini_error`. No file in `src/` writes that text (AI failures log `ai_unavailable`), so that alarm cannot fire until the filter or the log line is changed.

[runbooks/operations.md](runbooks/operations.md) says what to check first for each alarm.

## 9. Build, test, deploy

Run commands from the repo root. The test runner needs a working directory spelled with an upper-case drive letter.

```
cd C:/Users/narpra1/Work/Personal/JournalAWSSetup
bun install
bun run test                 # vitest run (src/**/*.test.ts)
bunx tsc --noEmit            # typecheck (same as bun run typecheck)
sam validate --lint          # template lint (bun run validate)
bun run build                # node scripts/build.mjs -> dist/web.zip, dist/events.zip
```

| Script | What it does |
|---|---|
| `scripts/build.mjs` | esbuild bundles `src/app/server.ts` (web) and `src/app/events.ts` (events) to one minified CommonJS `index.js` each, zips them deterministically (`scripts/lib/zip.mjs`) and prints JSON with each zip path and sha256 on the last line. |
| `scripts/deploy.mjs` | See below. |
| `scripts/lib/deploy-args.mjs` | Argument parsing and the prod parameter rules (`prodParamProblems`); tested by `src/test/deploy-args.test.ts`. |
| `scripts/backup.mjs` | `node scripts/backup.mjs --stage dev --out <dir>` (`bun run backup:dev`): on-demand backup of every DynamoDB table found in the stack, plus stack, template, user pool, client and Route 53 record snapshots and a `REVERT.md`. |
| `scripts/contract-test.mjs` | `--record <file>` then `--compare <file>` (`bun run contract:record`, `contract:compare`). Probes every route listed in `src/app/__tests__/routes.fixture.json` without a token and with the QA user's token and compares status and top-level JSON keys. Default API `https://api-dev.tradequt.com/v1`, override with `--api`. QA login comes from `<TRADEQUT_RESEARCH>/secrets/dev-qa.json`. |
| `scripts/gen-openapi.ts` | `bun scripts/gen-openapi.ts` writes only `docs/openapi.yaml` from `LEGACY_ROUTES` plus the lists inside the script (recipe 10a). |
| `scripts/stripe/setup-test.mjs` | `bun run stripe:setup-test`: creates the Pro product, four prices and the portal configuration in Stripe test mode (the key must start with `sk_test_`) and writes `/tradequt/dev/stripe/*`. `--dry-run` writes nothing. |
| `scripts/stripe/create-live-prices.mjs` | `bun run stripe:live-dry` is a dry run; `--live --confirm` creates the live objects (the key must start with `sk_live_`) and writes `/tradequt/prod/stripe/*`. `scripts/stripe/lib.mjs` holds the shared code and the price table (`PRICES`). |

### `scripts/deploy.mjs`

```
cd C:/Users/narpra1/Work/Personal/JournalAWSSetup
AWS_PROFILE=personal AWS_REGION=us-east-1 node scripts/deploy.mjs --stage dev --dry-run
AWS_PROFILE=personal AWS_REGION=us-east-1 node scripts/deploy.mjs --stage dev
AWS_PROFILE=personal AWS_REGION=us-east-1 node scripts/deploy.mjs --stage prod --dry-run --param AlarmEmail=<address>
AWS_PROFILE=personal AWS_REGION=us-east-1 node scripts/deploy.mjs --stage prod --confirm-prod --param AlarmEmail=<address>
```

Flags: `--stage dev|prod` (required), `--dry-run`, `--confirm-prod`, `--skip-checks`, `--skip-backup`, `--param Key=Value` (repeatable). The AWS profile defaults to `personal` when no access key is in the environment (`scripts/lib/aws.mjs`).

Steps and guards, in order:

1. Prod without `--dry-run` and without `--confirm-prod` stops at once.
2. Checks (unless `--skip-checks`): vitest, `tsc --noEmit`, `sam validate --lint`.
3. `scripts/build.mjs`; the two zips are uploaded to the artifacts bucket (stack `tradequt-artifacts`, output `CodeBucketName`) under `web/<stage>/<sha256>.zip` and `events/<stage>/<sha256>.zip`, and the template under `templates/<stage>/`. The S3 version ids become the `WebCodeVersion` and `EventsCodeVersion` parameters.
4. `--param` keys must be declared by the template and cannot be the five code parameters the script sets. All other parameters keep their previous value. On dev the script also sets `ProdUserPoolId`, `ProdUserPoolClientId` (from the prod stack) and `AppHost`.
5. Prod only: `prodParamProblems` refuses (exit 4) unless `AlarmEmail` is an address and the admin, Stripe and ad-config parameter names start with `/tradequt/prod/`.
6. The final parameter table (value and source; NoEcho values masked) is printed, then a CloudFormation change set is created.
7. Change-set guard (exit 2): any `AWS::DynamoDB::Table`, `AWS::Cognito::UserPool`, `AWS::Cognito::UserPoolClient`, `AWS::S3::Bucket` or `AWS::Route53::HostedZone` that would be removed or replaced aborts and deletes the change set.
8. `--dry-run` stops here and deletes the change set.
9. Backups (unless `--skip-backup`) via `scripts/backup.mjs`, then the change set is executed and the script waits for `UPDATE_COMPLETE`.
10. Smoke check: polls `<ApiBaseUrl>/subscriptions/plans` until it answers 200 (exit 3 if it never does).

Artifacts of each run (`changeset.json`, `parameters.json`, `template-new.yaml`, `outputs.json` and the backup files) go to `<TRADEQUT_RESEARCH>/build/backups/<stage>-<timestamp>/`. `TRADEQUT_RESEARCH` defaults to `C:\Users\narpra1\Work\Personal\TradeQut-Research`.

Order across the whole site: backend, then frontend, then the CloudFront router (the frontend deploy scripts are in `TradeQut-Research/release/`).

### GitHub workflows (`.github/workflows/`)

| File | Trigger | What it runs |
|---|---|---|
| `test.yml` | push or pull request on `main` and `develop` | `bun run test`, `bunx tsc --noEmit`, `sam validate --lint`, `node scripts/build.mjs` |
| `deploy.yml` | `Tests` workflow completed on `main` (only when it succeeded), or manual | `node scripts/deploy.mjs --stage dev` with AWS keys from repository secrets |
| `deploy-prod-manual.yml` | manual only; input `confirm` must be `deploy-prod`; `params` is the list of `Key=Value` pairs; `dry_run` defaults to true | `deploy.mjs --stage prod` (`--dry-run` or `--confirm-prod`), checks out `main` |

The feature branch `feat/web-function` is not on those triggers.

## 10. Making changes

Checks to run at the end of every recipe (from the repo root): `bun run test`, `bunx tsc --noEmit`, `sam validate --lint` when `template.yaml` changed, then `node scripts/deploy.mjs --stage dev --dry-run` before a real deploy. These are the "common checks" below.

### a. Add an API route end to end

1. Pick the home (section 1). For a new area, create `src/app/<module>/routes.ts` or a feature under `src/features/<name>/` exporting a Hono app typed `Hono<AppEnv>`.
   - Handler route: add `src/handlers/<route>/app.ts` (copy a sibling; use `getUserId`, `envelope`, `errorResponse`) and a line in `LEGACY_ROUTES` in `src/app/routes.ts` with the right auth group and, if needed, `extra` (`metered('<feature>')`).
   - App module: mount it in `src/app/app.ts` with `app.use('/v1/<path>/*', ...signedIn())` then `app.route(...)`.
   - Feature: add `{ basePath, app }` to `featureRoutes` in `src/features/index.ts` (`signedIn()` is applied for you).
2. Input checks: for a body that needs a schema add `src/schemas/<name>.schema.json` and export it from `src/schemas/index.ts`, then use `getValidator` and `formatErrors`. Otherwise validate by hand and answer with the `VALIDATION_ERROR` body.
3. Writes by a user whose trial ended are refused by `readOnlyGuard`. If the route must still work then, add it to `EXEMPT_WRITES` in `src/app/billing/middleware.ts` and to the sentence in the `info.description` of `scripts/gen-openapi.ts`.
4. Quota or plan gate: add the feature to `QuotaFeature` (`src/app/types.ts`), `QUOTA_FEATURES` and `PRO_LIMITS` / `READ_ONLY_LIMITS` (`src/app/billing/entitlements.ts`) and the label in `src/app/billing/responses.ts`. For a handler use `metered()`; in a Hono module call `c.get('quota').consume(...)` and `quotaFail`. A plan-only feature (no quota) is a new key in `GatedFeature` (`src/app/types.ts`) plus its message in `PLAN_MESSAGE` (`src/app/billing/responses.ts`). `allFeatures(true)` turns it on for Pro and trial, and `READ_ONLY_FEATURES` (`allFeatures(true)` with only `auto_sync` off) also turns it on for trial-ended users: add `<flag>: false` there if they must lose it. Nothing checks the flag for you: in the route read `const ent = c.get('entitlements')` and `return planRequired(c, '<flag>', ent)` when `!ent?.features?.<flag>`, as `src/features/reports/routes.ts` does for `tax_report`. Copy every new `QuotaFeature` / `GatedFeature` key into `TradeFlow/src/types/entitlements.ts`.
5. Tests: handler, `src/handlers/<route>/__tests__/app.test.ts` (`src/test/setup.ts` fakes the verified claims from an unsigned token); module or feature, a test next to it (see `src/app/__tests__/uploads-routes.test.ts`). Adding to `LEGACY_ROUTES` breaks `expect(LEGACY_ROUTES.length).toBe(fixture.length - 1 + 3)` in `src/app/__tests__/routes.test.ts`: raise the `+ 3` and extend the comment that lists the added routes.
6. `docs/openapi.yaml`: routes in `LEGACY_ROUTES` appear after `bun scripts/gen-openapi.ts`. A route in a module or feature needs a line in the `EXTRA` array or an `add(...)` call in `scripts/gen-openapi.ts`. If it can answer 402, add its key to `METERED` or `GATED` (or set `gated`) there. Commit the regenerated file.
7. Contract test: `scripts/contract-test.mjs` only reads `routes.fixture.json` (the original routes). Run `bun run contract:record` before the deploy and `bun run contract:compare` after it to check that existing routes did not change; a new route is not in the fixture.
8. Frontend consumer: add an endpoint in the matching `TradeFlow/src/store/api/<area>Api.ts` (`api.injectEndpoints` on the `api` of `baseApi.ts`; add a tag to `tagTypes` in `baseApi.ts` if it needs one) and response types in `TradeFlow/src/types/`, then the component. Deploy the backend first, then the frontend.
9. Checks: the common checks, then `bun scripts/gen-openapi.ts` and `git diff docs/openapi.yaml`.

### b. Add a field to trades

1. `src/schemas/trade-create.schema.json` and `src/schemas/trade-update.schema.json`: add the property (both have `additionalProperties: false`; without this the field is silently dropped, section 7).
2. `src/shared/tradeFields.ts`: for an optional contract-style field add it to `NUMERIC` or `TEXT` (`NUMERIC` only converts to a number; put range limits in the schema `minimum` / `maximum`). `create-trade` and `update-trade` then store it through `contractFields`. For any other field, add it by hand to `buildItem` in `src/handlers/create-trade/app.ts` and to the field lists in `src/handlers/update-trade/app.ts` (`mapable` and `arrFields`).
3. `src/handlers/bulk-update-trades/app.ts` (`SETTABLE_FIELDS`, `LIST_FIELDS`, `BOOLEAN_FIELDS`) if the field may be bulk edited; `src/handlers/list-trades/app.ts` if it needs a filter.
4. `src/shared/presentTrade.ts` if its API shape differs from the stored one.
5. Stats: if the field changes any metric, read it in the processors under `src/shared/metrics/processors/` (`computeDailyRecord` gets full trade records from `update-stats`) and add it to the `ProjectionExpression` in `loadTrades` of `src/handlers/rebuild-stats-job/app.ts`, otherwise the rebuild will not see it. After the deploy, force a rebuild for existing users (`docs/runbooks/operations.md`, "Stats look wrong").
6. Analysis and AI read a narrower row: `TradeRow` and its mapping in `src/features/trades-repo.ts`; add the field there only if analysis or prompts need it.
7. Import: `NormalizedTrade` in `src/features/import/types.ts`, the parser output and `src/features/import/service.ts` (the mapping to a trade). AI extraction (`src/handlers/extract-trades/app.ts`) if the model should fill it.
8. Export and account deletion read whole items, so they need no change.
9. Frontend: `TradeFlow/src/types/trade.ts`, `TradeFlow/src/lib/api/trades.ts` (`CreateTradePayload` and the mappers), `TradeFlow/src/store/api/tradesApi.ts`, then the form (`TradeFlow/src/components/trade/TradeForm.tsx`).
10. Tests: `src/handlers/create-trade/__tests__/app.test.ts`, `update-trade`, `src/shared/__tests__/presentTrade.test.ts`, `stats-aggregator.test.ts` if stats changed. Checks: the common checks.

### c. Add a scheduled job or stream reaction

1. Write the module under `src/handlers/<job>/app.ts` exporting a function (plain, with injected dependencies if it calls AI).
2. `src/app/events.ts`: add a branch. A schedule sends `{"job":"<name>"}`: add `if (event?.job === '<name>') return ...` before the final `throw`. For a new DynamoDB stream add a branch for its table ARN above the default (the default branch treats any other stream as the Trades stream).
3. `template.yaml`, `EventFunction`, `Events`: add a `Schedule` event with `Schedule` (UTC) and `Input` JSON, or a `DynamoDB` event with `Stream`, `BatchSize`, `BisectBatchOnFunctionError`, `MaximumRetryAttempts`, `ReportBatchItemFailures` and an `OnFailure` destination like `TradesStream`. A new stream also needs `StreamSpecification` on that table.
4. If the job touches a new resource, add its IAM statement to the `EventFunction` `Policies` and its env var to the `EventFunction` `Environment` (the Event Function does not get the Web Function's variables).
5. Test: add a case to `src/app/__tests__/events.test.ts` and a test for the module.
6. After the deploy run it once by hand: `aws lambda invoke --function-name tradequt-dev-events --cli-binary-format raw-in-base64-out --payload '{"job":"<name>"}' out.json` (profile `personal`), then read the Event log group.
7. Checks: the common checks (`sam validate --lint` is needed).

### d. Add a config value or secret via SSM

1. `template.yaml` `Parameters`: add `<Name>ParamName` (a name, never a value). No default for anything that must differ per stage.
2. Env var: add `<NAME>_PARAM: !Ref <Name>ParamName` to `EnvironmentVariables` of `ApiRevision` (and to `Environment` of `EventFunction` if the Event Function reads it).
3. IAM: add the parameter ARN to `ReadParameters` in `ApiFunctionRole` (and to the `ssm:GetParameter` list of the Event Function policy). A path under `/tradequt/<env>/stripe/` is already covered by a wildcard.
4. Runtime: read it with `readParam(process.env.<NAME>_PARAM)` from `src/shared/stripe-config.ts` (15 minute cache, `null` when missing), or `ssmKey(...)` from `src/features/ai/core.ts` (one hour cache) for a key. Never log the value.
5. Create the parameter yourself (`aws ssm put-parameter --type SecureString`, profile `personal`); never put the value in the repo.
6. `scripts/deploy.mjs`: pass `--param <Name>ParamName=/tradequt/<env>/<name>`. For a prod-only secret, add the parameter to `PROD_PARAM_NAMES` in `scripts/lib/deploy-args.mjs` and cover it in `src/test/deploy-args.test.ts`.
7. Add the name to `.env.example`. Checks: the common checks; the final parameter table in the dry run must show the new row.

### e. Change plan limits, trial length or prices

| Change | Files, in order |
|---|---|
| Monthly quota or the trial's limits | `src/app/billing/entitlements.ts` (`PRO_LIMITS`; trial users get the same limits), the label text in `src/app/billing/responses.ts`, tests `src/app/__tests__/billing-routes.test.ts` and `ai-metering.test.ts`, then the frontend's displayed limits in `TradeFlow/src/content/product-facts.ts` (plan limit rows) and any copy that repeats them. |
| Trial length | `TRIAL_DAYS` in `src/app/billing/entitlements.ts` (used by `auth-post-confirmation` and `effectiveSubscription`); it applies to new trials only. Frontend copy: `TradeFlow/src/content/product-facts.ts` and the "14-day" strings in `TradeFlow/src/content/alternatives.ts` (search for the number). Do not bump `PLANS_VERSION` for this: a bump gives every non-paying user a new trial (`effectiveSubscription`). |
| Prices | The price table `PRICES` in `scripts/stripe/lib.mjs` (amounts in the smallest unit). Run `bun run stripe:setup-test` (dev), or `bun run stripe:live-dry` and then `node scripts/stripe/create-live-prices.mjs --live --confirm` (prod): a changed amount creates a new price under the same lookup key, archives the old one and writes the new ids to SSM. Then update the display amounts in `PLAN_CONFIG` of `src/handlers/get-subscription-plans/app.ts` and `PRO_PRICES` in `TradeFlow/src/content/product-facts.ts`. Existing subscribers stay on their price and show `legacyPrice` in the entitlements. |
| Which currency a viewer sees | `billingCurrencyFor` in `src/shared/stripe-config.ts` and the matching logic in `src/handlers/get-subscription-plans/app.ts`. |

Checks: the common checks; `GET /v1/subscriptions/plans` on dev; [runbooks/stripe-live.md](runbooks/stripe-live.md) for the live steps.

### f. Add a DynamoDB table or GSI

1. `template.yaml`: add the table with `DeletionPolicy: Retain`, `UpdateReplacePolicy: Retain`, pay-per-request and point-in-time recovery, named `<Table>-<StageName>` like its neighbours (`!Sub <Table>-${StageName}).
2. Env var: add `<TABLE>_TABLE: !Ref <Table>` to `ApiRevision` and, if the Event Function needs it, to `EventFunction`.
3. IAM: add `!GetAtt <Table>.Arn` (and `/index/*` if it has a GSI) to the `Tables` statement of `ApiFunctionRole` and to the `EventFunction` policy.
4. Deploy guard: adding a table is allowed. Anything that replaces or removes a table (changing its key schema or name) makes `scripts/deploy.mjs` exit 2. Adding a GSI is an in-place change, but DynamoDB allows one GSI change per update; deploy several one at a time. The Trades table name carries `ApiVersion` so a replacement is possible by bumping it; that is a data migration and needs its own plan.
5. Backups: `scripts/backup.mjs` backs up every table in the stack by itself, so nothing to add. Update the table count in `docs/runbooks/operations.md`.
6. Privacy: add the table to `exportUserData` and `purgeUser` in `src/shared/account-data.ts` so export and account deletion cover it.
7. Local: add the variable to `.env.example`. Tests that touch the table set the env var.
8. Checks: the common checks; the dry-run change set must show one added table and no guard violation.

### g. Change an e-mail

1. App mails (welcome, getting started, trial ending, trial ended, payment failed, weekly report): the template functions in `src/shared/email.ts` (`welcomeMail`, `firstTradesMail`, `otherWaysMail`, `tagTradesMail`, `weekReviewMail`, `trialEndingMail`, `trialEndedMail`, `paymentFailedMail`, `weeklyReportMail`). Optional mails (getting started, weekly report) end with the Settings link that switches them off; account mails do not. A new mail is a new function returning `Mail` plus a caller.
2. Test: `src/shared/__tests__/email.test.ts`.
3. Senders: `src/handlers/auth-post-confirmation/app.ts` (welcome), `src/handlers/lifecycle-emails/app.ts` (getting-started mails, trial mails and weekly report) and `src/handlers/stripe-webhook/app.ts` (payment failed). Change the schedule or the conditions there, not in `email.ts`.
4. Sender and links: `FROM_EMAIL` and `APP_URL` come from the stack parameters `AppDomain` and `AppHost` (`template.yaml`); SES must have the domain verified.
5. Cognito's own mails (sign-up code, password reset) are not defined in this repo: the template sets no custom message, so Cognito's defaults are used.
6. Checks: `bun run test`, `bunx tsc --noEmit`.
