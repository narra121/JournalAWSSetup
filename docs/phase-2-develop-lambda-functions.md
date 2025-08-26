# Phase 2 – Develop Lambda Function Code

Goal: Implement Node.js (TypeScript + esbuild) Lambda functions defined in the SAM template (versioned `/v1` API, validation, structured logging, partial closes, full stats rebuild strategy).

## Structure

```
src/
  handlers/
    create-trade/
      app.ts (or .js)
    get-trade/
      app.ts
    list-trades/
      app.ts
    update-trade/
      app.ts
    delete-trade/
      app.ts
    generate-upload-url/
      app.ts
    update-stats/
      app.ts
    rebuild-stats-job/
      app.ts  # scheduled 6h full rebuild safety net
    openapi-spec/
      app.ts  # serve OpenAPI YAML (public)
    openapi-docs/
      app.ts  # serve Swagger UI (public)
    auth-*/
      app.ts  # signup, confirm, login, refresh, forgot, confirm-forgot, account, export, logout-all
```

## Data Contract

- TradesTable keys:
  - PK: userId (string)
  - SK: tradeId (string, UUID)
- GSIs: date, symbol+date, status+date, idempotency (see Phase 1)
- TradeStatsTable aggregates (full rebuild fields): tradeCount, realizedPnL, wins, losses, bestWin, worstLoss, sumWinPnL, sumLossPnL, lastUpdated

## Common Utilities

- Use AWS SDK v3 `@aws-sdk/client-dynamodb` + `@aws-sdk/lib-dynamodb` (DocumentClient)
- Parse user `sub` from Cognito JWT injected by API Gateway authorizer (event.requestContext.authorizer.jwt.claims.sub)
- Handle JSON parsing and validation; return proper HTTP status codes

## CRUD Function Sketches (Node.js)

- create-trade: generate UUID, validate payload (AJV), enforce optional Idempotency-Key header, store trade
- get-trade: get by (userId, tradeId)
- list-trades: query with multi-filter (symbol/status/tag/date) choosing appropriate GSI; paginate (limit + nextToken)
- update-trade: handle partial closes (append partialCloses, derive realizedPartialPnl, remainingQuantity, recompute pnl/status when closed)
- delete-trade: conditional delete on owner

## generateUploadUrl

- Validate content type and key pattern (e.g., `images/{userId}/{tradeId}/{uuid}.jpg`)
- Use S3 `GetObjectCommand` / `PutObjectCommand` with `getSignedUrl` from `@aws-sdk/s3-request-presigner` (or v2 equivalent)
- Return URL and headers required for upload

## update-stats (DynamoDB Streams)

Adopts FULL REBUILD per affected user for correctness (simplifies complex historical edits):
- On INSERT/MODIFY/REMOVE, load all user's trades (paginated) and recompute aggregates from scratch.
- Write complete stats item (idempotent). DLQ captures persistent failures; scheduled job repairs drift.

## rebuild-stats-job (Scheduled)
- Every 6 hours scans trades per user and recomputes stats (safety net / backfill).

## Error Handling & Observability

- Structured logs (JSON), include level, time, requestId, userId. Avoid logging large arrays directly; provide summaries.
- Return 4xx for validation/auth errors; 5xx for unexpected errors
- Consider adding Powertools for Lambda (logging/metrics/tracing)

## Local Testing

```powershell
# Unit tests (example)
npm install --save-dev vitest @types/aws-lambda ts-node typescript
npx vitest run

# SAM local invoke (example)
sam local invoke CreateTradeFunction --event tests/create-trade.json
```

## Next

Proceed to [Phase 3 – Deploy the Backend](./phase-3-deploy-backend.md).
