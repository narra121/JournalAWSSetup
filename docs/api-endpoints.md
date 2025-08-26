# Trading Journal API – Endpoint Reference

Base URL: `https://<api-id>.execute-api.<region>.amazonaws.com/v1` (stack output `ApiBaseUrl`).

Public (no auth): `/v1/openapi.yaml`, `/v1/docs`.

Protected: All other `/v1/*` endpoints require Cognito IdToken in `Authorization` header (`Bearer <token>` or raw token).

Headers:
```
Authorization: <IdToken>
Content-Type: application/json
Idempotency-Key: <uuid>   # optional for POST /v1/trades (single create)
```

Response Envelope (rolling adoption): Target success shape `{ data, meta, error:null }`. Legacy endpoints may still return raw objects or `{"message": "..."}` for errors.

---
## Trade Data Model
Primary Table: `Trades-<stage>` (PK `userId`, SK `tradeId`).

Global Secondary Indexes
| Index | PK | SK | Purpose |
|-------|----|----|---------|
| trades-by-date-gsi | userId | openDate | Date range queries |
| user-symbol-date-gsi | userId | symbolOpenDate | Symbol + time queries |
| user-status-date-gsi | userId | statusOpenDate | Status + time queries |
| user-idempotency-gsi | userId | idempotencyKey | Idempotent create protection |

Core + Extended Fields (optional unless noted)
| Field | Type | Notes |
|-------|------|-------|
| userId | string | Partition key (Cognito sub) |
| tradeId | string | Sort key (UUID) |
| symbol | string | Required |
| side | BUY|SELL | Required |
| quantity | number | Required > 0 |
| openDate | YYYY-MM-DD | Required |
| closeDate | YYYY-MM-DD|null | Final closure date |
| entryPrice | number|null |  |
| exitPrice | number|null | Setting creates CLOSED when no remaining qty |
| stopLoss / takeProfit | number|null | Planning fields |
| partialCloses | PartialClose[] | Sequence of partial executions |
| realizedPartialPnl | number|null | Sum PnL from partials |
| remainingQuantity | number|null | quantity - sum(partial qty) if still open |
| pnl | number|null | Final gross PnL (full close) |
| netPnl | number|null | pnl - (commission+fees) |
| commission / fees | number|null | Costs |
| riskAmount | number|null | User-supplied risk $ |
| riskRewardRatio | number|null | Derived |
| status | OPEN|PARTIAL|CLOSED|CANCELLED | Derived from partials/exit |
| setupType | string|null | Strategy label |
| timeframe | string|null | Chart timeframe |
| marketCondition | string|null |  |
| tradingSession | string|null |  |
| tradeGrade | A|B|C|D|F|null | Journal metric |
| confidence | number|null 0-10 |  |
| setupQuality / execution | number|null 0-10 |  |
| emotionalState | string|null |  |
| psychology | object | { greed,fear,fomo,revenge,overconfidence,patience } booleans |
| preTradeNotes / postTradeNotes | string|null | Journal notes |
| mistakes / lessons / newsEvents / economicEvents | string[] | Arrays overwrite on update |
| tags | string[] | Labels |
| images | TradeImage[] | Upsert per id |
| createdAt / updatedAt | ISO string | System maintained |

PartialClose
| Field | Type |
|-------|------|
| id | string (UUID) |
| quantity | number > 0 |
| price | number > 0 |
| date | ISO datetime |
| realizedPnl | number (derived) |

TradeImage
| Field | Type |
|-------|------|
| id | string |
| url | string |
| timeframe | string|null |
| description | string|null |

Image ingestion
1. Inline: images[].base64Data (server stores & sets url)
2. Presigned PUT: GET /v1/upload-url then send `url`
3. Existing public URL (stored as-is)

---
## Endpoints

### Create Trade
POST /v1/trades

Body: Trade object subset (required: symbol, side, quantity, openDate). Optional images & journal / PnL fields. Provide `Idempotency-Key` header for safe retry (single create only).

Hybrid PnL Logic:
1. If both `pnl` and `netPnl` provided, stored unchanged.
2. If only `pnl`, derive `netPnl = pnl - (commission + fees)`.
3. If only `netPnl`, derive `pnl = netPnl + (commission + fees)`.
4. If neither and both `entryPrice` & `exitPrice` present, compute `pnl` from prices (BUY => (exit-entry)*qty; SELL => (entry-exit)*qty) then derive `netPnl`.
5. If insufficient data, both remain null.

Returns 201 with full trade (or 200 if idempotent repeat once envelope rollout complete). `netPnl` present whenever derivable.

### Bulk Create Trades
POST /v1/trades (body contains `{ "items": [ {...}, {...} ] }`)

Rules:
- Max 50 items per request.
- Per-item hybrid PnL logic identical to single create.
- Optional `idempotencyKey` per item to skip duplicates via GSI lookup.
- Images per item allowed (base64 or existing url).
- Response fields: `created`, `skipped[]`, `errors[]`, `items[]`.

### Bulk Delete Trades
POST /v1/trades/bulk-delete

Body: `{ "tradeIds": ["id1","id2",...] }` (max 50).

Behavior:
- Batches deletions (25 per BatchWrite) with up to 3 retries for unprocessed.
- Best-effort S3 image cleanup per trade.
- Response: `{ deletedRequested, errors:[{tradeId,message}] }`.

Idempotent: Re-sending same list after success is safe; already deleted ids simply have no effect.

### Get Trade
GET /v1/trades/{tradeId}
Returns full trade. Guarantees `netPnl` (derives from `pnl - (commission+fees)` if missing and data available).

### List Trades
GET /v1/trades
Query params (optional, combinable): symbol, status, tag, startDate, endDate, limit (1-100), nextToken.
Returns `{ items[], nextToken? }` (inside envelope once migrated). For each item ensures `netPnl` present (derive if absent). Uses GSIs for efficiency.

### Update Trade
PUT /v1/trades/{tradeId}
Partial update. Arrays overwrite (except images upsert by id, partialCloses appended). Derived fields ignored if supplied.

### Delete Trade (Single)
DELETE /v1/trades/{tradeId}
Removes trade and associated S3 images (cascade). Use bulk-delete for many trades.

### Presigned Upload URL
GET /v1/upload-url?tradeId=...&contentType=image/jpeg
Returns temporary PUT url + key.

### Extract Trades From Image
POST /v1/trades/extract

Purpose: Send a base64-encoded screenshot / image of a trade history (e.g. platform statement section) and receive a structured array of extracted trades inferred by the Gemini vision model.

Request Body:
```json
{ "imageBase64": "data:image/png;base64,...." }
```
`imageBase64` may include a `data:image/<type>;base64,` prefix or be raw base64. Large images are rejected (HTTP 413) based on configured server limit.

Successful Response (200):
```json
{
  "data": {
    "items": [
      {
        "symbol": "XAUUSD",
        "side": "SELL",
        "quantity": 0.2,
        "openDate": "2023-08-21T17:46:25",
        "closeDate": "2023-08-21T18:15:15",
        "entryPrice": 3343.58,
        "exitPrice": 3338.78,
        "fee": -0.8,
        "swap": 0,
        "pnl": 95.2
      }
    ]
  },
  "meta": {
    "elapsedMs": 12010,
    "parseSteps": ["Stripped markdown code fence", "Detected array boundaries directly"]
  },
  "error": null
}
```

Key Notes:
- `parseSteps` describes heuristics used to normalize model output (e.g. stripping ```json fences).
- The model is instructed to return an array only; defensive parsing tolerates markdown fences and surrounding text.
- Errors use the standard envelope with `error.code` such as `BadRequest`, `ImageTooLarge`, `UpstreamTimeout`, `UpstreamError`, `ParseError`, `JSONParseError`.

Error Codes (non-exhaustive):
| Status | code | Meaning |
|--------|------|---------|
| 400 | BadRequest / BadJSON | Missing body, invalid JSON, or missing imageBase64 |
| 413 | ImageTooLarge | Base64 payload length over limit |
| 502 | UpstreamError | Gemini API error (non-timeout) |
| 504 | UpstreamTimeout | Gemini request exceeded configured per-attempt timeout |
| 500 | ParseError / JSONParseError / InternalError | Model output unusable or unexpected server error |

Throughput / Performance:
- Per-attempt timeout configurable via `GEMINI_REQUEST_TIMEOUT_MS`.
- (Optional future) Retries/backoff can be added; current implementation may parse first successful response only.

### Stats
GET /v1/stats
Recomputed via FULL REBUILD on each relevant stream event + scheduled 6h safety job. Fields: tradeCount, realizedPnL, wins, losses, bestWin, worstLoss, sumWinPnL, sumLossPnL + derived (winRate, avgWin, avgLoss, expectancy).

### Auth (public)
POST /v1/auth/signup
POST /v1/auth/confirm-signup
POST /v1/auth/login
POST /v1/auth/refresh
POST /v1/auth/forgot-password
POST /v1/auth/confirm-forgot-password

### Auth (protected)
DELETE /v1/auth/account (delete user + data + images)
GET /v1/auth/export (export trades + stats)
POST /v1/auth/logout-all (global sign-out)

---
## Status Codes
| Code | Meaning |
|------|---------|
| 200 | Success |
| 201 | Created |
| 204 | No Content (delete) |
| 400 | Validation / bad request |
| 401 | Missing/invalid token |
| 404 | Not found |
| 409 | Conflict (future idempotency mismatch) |
| 413 | Payload too large (image reject) |
| 502 | Upstream dependency error (Gemini) |
| 504 | Upstream timeout (Gemini) |
| 500 | Internal error |

---
## Future Enhancements
- Bulk import/export trades
- Full response envelope adoption everywhere + structured error codes
- Fine-grained partial close PnL streaming into stats (current full rebuild handles correctness)
- Sorting, field projection (`fields` param)
- Advanced filtering (ranges on pnl, risk)

---
## Quick Flow Example
```
POST /v1/trades { symbol, side, quantity, openDate, images:[{ base64Data:... }] }
PUT  /v1/trades/{id} { exitPrice }
GET  /v1/stats
PUT  /v1/trades/{id} { images:[{ base64Data:..., timeframe:'5m'}] }
GET  /v1/trades?status=CLOSED&limit=20
```

---
Questions or discrepancies? See OpenAPI spec `/v1/openapi.yaml` or raise an issue.
          "url": "https://trading-journal-images-.../images/cognito-sub-123/7f3f9e2c-2a6d-4d1a-86dc-1e908e6cb6b2/b3b9f3ce.jpg",
          "timeframe": "1H",
          "description": "Entry setup"
        }
      ],
      "createdAt": "2025-08-23T10:16:15.701Z",
      "updatedAt": "2025-08-23T10:16:15.701Z"
    }
  ]
}
```
Pagination: NOT YET IMPLEMENTED (future: LastEvaluatedKey).

Errors: 401, 500.

### Update Trade
PUT `/trades/{tradeId}`

Purpose: Partial or full update. You can send ANY of the create fields (same list) plus new / modified images. Fields omitted are preserved. Arrays provided overwrite those arrays except `images` which is upserted per `id`.

Special image handling:
- Provide `images` array with items containing either `base64Data` or `url` plus optional metadata.
- Existing image with same `id` is merged; new `id` appended.

Derived fields recomputed on each update (pnl, netPnl, riskRewardRatio, status) and any supplied values for them are ignored.

Response Codes:
- 200 OK – updated full trade
- 400 Missing tradeId / body
- 401 Unauthorized
- 404 Not found
- 500 Internal error

### Delete Trade
DELETE `/trades/{tradeId}`

Effects: Removes trade item and deletes all S3 objects under `images/<userId>/<tradeId>/`. If trade was CLOSED its PnL is reversed out of aggregate stats (wins/losses decremented) but `bestWin`/`worstLoss` not recomputed (can become stale).

Response Codes: 204, 400, 401, 500.

---
## Uploads
Used for associating images (e.g. charts) with a trade. Files stored in S3 bucket `trading-journal-images-<account>-<region>-<stage>` under `images/<userId>/<tradeId>/<uuid>.{ext}`.

### Get Presigned Upload URL
GET `/upload-url?tradeId=<tradeId>&contentType=<mime>`

Query Parameters:
- `tradeId` (required)
- `contentType` (optional, default `image/jpeg`; must start with `image/`)

Response 200:
```json
{
  "uploadUrl": "https://bucket.s3.amazonaws.com/...",  // PUT URL valid ~5 min
  "key": "images/<userId>/<tradeId>/<uuid>.jpg"
}
```
Errors: 400 (missing tradeId / invalid contentType), 401, 500.

Upload Usage (example curl after obtaining URL):
```
curl -X PUT -H "Content-Type: image/jpeg" --data-binary @file.jpg "<uploadUrl>"
```

---
## Statistics (Design & Calculation)
Aggregates stored in DynamoDB table `TradeStats-<stage>` keyed by `userId`.

### Event Flow
1. A trade item mutation fires a DynamoDB Stream record (NEW_AND_OLD_IMAGES) on `Trades` table.
2. `UpdateStatsFunction` consumes each record sequentially.
3. For each record it:
   - Loads current stats (GetCommand).
   - Adjusts `tradeCount` (+1 on INSERT, -1 on REMOVE).
   - Determines if PnL transition occurred:
     * INSERT: If trade arrives already closed (entry & exit present) treat as closed and add PnL.
     * MODIFY: If previously not closed (no exitPrice) and now closed (exitPrice set) add PnL once.
     * REMOVE: If deleting closed trade, subtract its PnL and decrement win/loss counts.
   - PnL formula: BUY => (exitPrice - entryPrice) * quantity; SELL => (entryPrice - exitPrice) * quantity.
   - Updates cumulative metrics then writes full stats object (PutCommand). Last write wins.

### Stored Base Fields
| Field | Meaning |
|-------|---------|
| tradeCount | Total active historical count (insertions minus deletions) |
| realizedPnL | Sum of all closed trade PnL applied (net of neither fees nor commission; gross) |
| wins | Count of trades with PnL > 0 |
| losses | Count of trades with PnL < 0 |
| bestWin | Max single-trade PnL observed |
| worstLoss | Min (most negative) single-trade PnL observed |
| sumWinPnL | Sum of positive PnL values |
| sumLossPnL | Sum of negative PnL values (negative number) |
| lastUpdated | ISO timestamp of last aggregation write |

### Derived At Read (GET /stats)
| Field | Formula |
|-------|---------|
| winRate | wins / (wins + losses) or 0 |
| avgWin | sumWinPnL / wins or 0 |
| avgLoss | sumLossPnL / losses or 0 (negative) |
| expectancy | winRate * avgWin + (1 - winRate) * avgLoss |

### Consistency & Limitations
- Eventual consistency: Stats may lag a trade write by stream processing latency (< few seconds typically).
- Updating `exitPrice` after initially set is NOT reflected (no delta logic) – future enhancement: recompute diff.
- Deleting closed trades reverses PnL & counts but does not recompute `bestWin` / `worstLoss` (staleness risk).
- Concurrency: Parallel MODIFIY events could race; last processed event overwrites previous aggregated state (acceptable for low volume). Row-level transactions or atomic counters could harden this.
- Fees/commission are not subtracted in `realizedPnL`; `netPnl` is per-trade only.

### Enhancement Ideas
- Maintain netRealizedPnL (subtract avg costs) and R-multiples.
- Rebuild aggregates periodically via batch scan (repair job).
- Track partial closes (status PARTIAL) with incremental realized adjustments.

### Get Stats
GET `/stats`

Returns base + derived fields. See response example below.

Response 200 example:
```json
{
  "userId": "<sub>",
  "tradeCount": 3,
  "realizedPnL": 145.5,
  "wins": 2,
  "losses": 1,
  "bestWin": 120.0,
  "worstLoss": -30.5,
  "sumWinPnL": 150.0,
  "sumLossPnL": -4.5,
  "lastUpdated": "2025-08-23T12:34:56.789Z",
  "winRate": 0.6667,
  "avgWin": 75.0,
  "avgLoss": -4.5,
  "expectancy": 48.5
}
```
Errors: 401, 500.

Aggregation Notes / Limitations:
- PnL computed when a trade becomes closed (first time `exitPrice` appears) using: BUY => (exit - entry) * qty; SELL => (entry - exit) * qty.
- Updating `exitPrice` after initial close is ignored by stats (no adjustment).
- Deleting a closed trade reverses its PnL and decrements win/loss counts but does NOT recompute `bestWin` / `worstLoss` (they can become stale until a new extreme occurs).
- Concurrency: last-write-wins; acceptable for low volume.

---
## Authentication Endpoints
All routes below are `Auth: NONE` (no JWT required). They wrap Cognito flows so a frontend can avoid calling Cognito directly. All respond with `200` on success unless stated otherwise.

### Sign Up
POST `/auth/signup`
Body: `{ "email": "user@example.com", "password": "StrongPass1!" }`
Behavior: Creates Cognito user; triggers email with confirmation code (since email attribute supplied). Returns:
```json
{ "userConfirmed": false, "codeDelivery": { "Destination": "u***@e***.com", "DeliveryMedium": "EMAIL", "AttributeName": "email" } }
```
Errors: 400 (missing fields / Cognito error e.g. UsernameExistsException)

### Confirm Sign Up
POST `/auth/confirm-signup`
Body: `{ "email": "user@example.com", "code": "123456" }`
Returns `{ "confirmed": true }`.

### Login
POST `/auth/login`
Body: `{ "email": "user@example.com", "password": "StrongPass1!" }`
Returns tokens:
```json
{
  "IdToken": "...",
  "AccessToken": "...",
  "RefreshToken": "...",
  "ExpiresIn": 3600,
  "TokenType": "Bearer"
}
```
Use `IdToken` in `Authorization` header for protected routes.

### Refresh Session
POST `/auth/refresh`
Body: `{ "refreshToken": "<RefreshToken>" }`
Returns new `IdToken` + `AccessToken` (no new refresh token per Cognito default).

### Forgot Password (Initiate)
POST `/auth/forgot-password`
Body: `{ "email": "user@example.com" }`
Effect: Sends a confirmation code to email. Returns code delivery details.

### Confirm Forgot Password
POST `/auth/confirm-forgot-password`
Body: `{ "email": "user@example.com", "code": "123456", "newPassword": "NewStrongPass1!" }`
Returns `{ "message": "Password reset confirmed" }`.

General Error Shape: `{ "message": "<cognito error>" }` (e.g. CodeMismatchException, LimitExceededException, ExpiredCodeException).

Token scope: Multi-tenant isolation enforced by deriving `userId` = Cognito `sub` claim from provided IdToken on protected routes.

---
## HTTP Status Code Summary
| Code | Meaning | Common Causes |
|------|---------|---------------|
| 200  | Success | Get/List/Update operations succeed |
| 201  | Created | New trade created |
| 204  | No Content | Trade deleted |
| 400  | Bad Request | Missing path param/body/required field/invalid query |
| 401  | Unauthorized | Missing or invalid IdToken |
| 404  | Not Found | Trade not found on get/update (conditional fail) |
| 413  | Payload Too Large | Oversized base64 image for extraction |
| 502  | Upstream Error | Gemini model responded with error / non-timeout failure |
| 504  | Upstream Timeout | Gemini request exceeded configured timeout |
| 500  | Internal Error | Unhandled exception in Lambda |

---
## Future / Potential Enhancements (Not Implemented Yet)
- Idempotent PnL adjustments if `exitPrice` changes.
- Recompute aggregates on delete / update to keep best/worst accurate.
- Pagination for large trade lists (LastEvaluatedKey support).
- Sorting / filtering by tags, symbol, side.
- Bulk import/export.
- Structured error codes with machine-readable identifiers.
- Admin endpoints (user management, global stats).

---
## Quick Example Sequence
```
# 1. Create trade with base64 image
POST /trades { symbol, side, quantity, openDate, images:[{base64Data:...}] }
# 2. Close trade later
PUT /trades/{id} { exitPrice }
# 3. Fetch stats (expect wins/losses updated)
GET /stats
# 4. Add another image
PUT /trades/{id} { images:[{ base64Data:..., timeframe:'5m'}] }
# 5. List last 7 days
GET /trades?startDate=2025-08-16
```

Let me know any fields / behaviors you want to change or expand.
