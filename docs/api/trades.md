# Trades API

Base path: `/v1`

## Create Trade (Single)
POST `/v1/trades`

Request body (partial example):
```
{
  "symbol": "AAPL",
  "side": "BUY",
  "quantity": 10,
  "openDate": "2025-08-24",
  "entryPrice": 180.5,
  "exitPrice": 182.1,
  "pnl": 16.0,
  "netPnl": 14.5,
  "commission": 1.0,
  "fees": 0.5
}
```
PnL handling (hybrid):
- If both `pnl` and `netPnl` provided they are stored as-is.
- If `pnl` provided but `netPnl` missing, backend derives `netPnl = pnl - (commission+fees)`.
- If `netPnl` provided but `pnl` missing, backend reconstructs `pnl = netPnl + (commission+fees)`.
- If neither provided and prices present, backend computes `pnl` from prices and then derives `netPnl`.

Optional header for idempotency: `Idempotency-Key`.

## Bulk Create Trades
POST `/v1/trades`

Bulk payload shape:
```
{ "items": [ { ...trade1 }, { ...trade2 } ] }
```
Constraints:
- Max 50 items per request.
- Hybrid PnL logic applied per item (same rules as single create).
- Images: each item may include `images[]` with either `base64Data` (data URL or raw base64) or a presigned `url`.
- Idempotency: include `idempotencyKey` per item to skip duplicates.

Response example:
```
{
  "created": 2,
  "skipped": [ { "index": 1, "tradeId": "abc", "reason": "idempotent_duplicate" } ],
  "errors": [],
  "items": [ { "tradeId": "...", "pnl": 16, "netPnl": 14.5, ... } ]
}
```

## Get Trade
GET `/v1/trades/{tradeId}`

Always returns `netPnl`; if absent in storage it's derived from `pnl - (commission+fees)`.

## List Trades
GET `/v1/trades`

Query params:
- `symbol` (optional)
- `status` (optional)
- `startDate`, `endDate` (ISO date)
- `tag` (post-filter)
- `limit` (default 50, max 100)
- `nextToken` (pagination)

Each returned item includes `netPnl` (derived if missing).

## Update Trade
PUT `/v1/trades/{tradeId}`

(Same hybrid PnL logic should be maintained; update code if diverges.)

## Delete Trade (Single)
DELETE `/v1/trades/{tradeId}`

Deletes trade and associated images.

## Bulk Delete Trades
POST `/v1/trades/bulk-delete`

Request body:
```
{ "tradeIds": ["id1", "id2", "id3"] }
```
Rules:
- Max 50 tradeIds per call.
- Best-effort image cleanup per trade.
- Retries unprocessed DynamoDB batch write items up to 3 times.

Response:
```
{
  "deletedRequested": 3,
  "errors": [ { "tradeId": "id2", "message": "Unprocessed after retries" } ]
}
```

## Error Model
```
{
  "message": "...",
  "code": "VALIDATION_ERROR",
  "details": [ ... ]
}
```

## PnL Field Reference
- `pnl`: Gross profit/loss (before costs).
- `netPnl`: Profit/loss after subtracting `commission + fees`.
- `commission`: Broker commissions.
- `fees`: Exchange or other fees.

If only `netPnl` supplied, `pnl = netPnl + commission + fees` for consistency.

## Idempotency
- Single create: use `Idempotency-Key` header.
- Bulk create: include `idempotencyKey` inside each item.

## Pagination
Use `nextToken` returned by list to fetch subsequent pages. Treat token as opaque.

## Rate Limits
(Not yet enforced for trade routes; auth routes may have rate-limiting.)
