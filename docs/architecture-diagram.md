# Architecture Overview

High-level components and data flows for the Trading Journal Backend.

```
+------------------+        +-------------------+          +-------------------+
|      Client      |  HTTPS |  API Gateway HTTP |  Lambda  |  Auth Handlers    |
|  (Web / Mobile)  +------->+  API (/v1, JWT)   +--------->+  (Signup/Login/..) |
+---------+--------+        +------+------------+          +---------+---------+
          |                           |                               |
          |                           |  Invokes                      |
          |                           v                               v
          |                 +-------------------+           +-------------------+
          |                 |  Trade Handlers   |  Streams  |   Update Stats    |
          |                 | (CRUD, images,    +---------->+ (Full rebuild on  |
          |                 |  partial closes)  |           |  stream + schedule)|
          |                 +---------+---------+           +-------------------+
          |                           |
          |                           | DynamoDB (Put/Query/Scan)
          |                           v
          |                 +-------------------+         +-------------------+
          |                 |   Trades Table    |         |  TradeStats Table  |
          |                 +-------------------+         +-------------------+
          |                           ^                            ^
          |                           | Images (Get/Put/Delete)     |
          |                           |                             |
          |                 +-------------------+                   |
          |                 |   S3 Images Bucket |<-----------------+
          |                 +--------------------+
          |                            \
          | Rate Limit / Auth           \
          |                             v
          |                 +-------------------+
          |                 | AuthRateLimit Tbl |
          |                 +-------------------+
          |                             
          | Scheduled (6h)                           Monitoring/Alarms
          |         +-------------------------------------+
          |         |                                     |
          v         v                                     v
+------------------+        +-------------------+   +-------------------+
| Cognito UserPool |<-------+ Rebuild Stats Job |   | CloudWatch Alarms |
+------------------+        +-------------------+   +-------------------+
```

## Components
- API Gateway HTTP API: Versioned routes (`/v1/*`) with Cognito JWT authorizer (except public docs/spec endpoints).
- Lambda Functions:
  - Auth handlers (signup, login, refresh, password reset, delete account, export, sign-out)
  - Trade handlers (create, get, list, update with partial closes, delete, bulk import placeholder)
  - UpdateStats stream processor (full rebuild strategy for correctness)
  - RebuildAllStats scheduled job (6h safety net)
  - OpenAPI spec + Swagger UI static serving handlers
- DynamoDB Tables:
  - Trades: Core trade records + partialCloses array; GSIs (user-date, user-symbol-date, user-status-date, idempotency)
  - TradeStats: Aggregated per-user statistics
  - AuthRateLimit: TTL-based simple rate limiting counters
- S3 Bucket (Images): Stores trade image objects; cascade delete on trade removal.
- Cognito: User authentication and tokens.
- CloudWatch: Alarms (partial) for error monitoring; logs for structured JSON output.
- SQS DLQ: For failed DynamoDB stream events (stats updates) with bisect + limited retries.
- EventBridge Schedule: Triggers periodic full stats rebuild.

## Data Flows
1. Client calls authenticated endpoint with JWT -> API Gateway -> Lambda handler executes business logic.
2. Trade mutations write to Trades table; DynamoDB stream triggers UpdateStats (which performs full stats rebuild for impacted user).
3. Images uploaded via base64 or presigned URL workflow to S3; references stored in trade item.
4. Scheduled job periodically recomputes all stats to ensure eventual consistency and repair anomalies.
5. Errors and structured logs emitted to CloudWatch; alarms can trigger rollback (future enhancement).

## Deployment Strategy
- SAM template with `ApiVersion` parameter for versioned path prefix.
- CodeDeploy deployment preferences (canary/linear) via Lambda aliases (`live`).
- Future: multi-stage stacks (dev/stage/prod) with distinct `Stage` parameter and samconfig profiles.

## Security Considerations
- Cognito JWT verification at gateway layer.
- Principle of least privilege (needs further tightening of IAM policies).
- S3 Block Public Access; future work: default encryption, malware scanning pipeline.
- Planned: enable DynamoDB PITR, migrate secrets to SSM Parameter Store.

## Reliability Features
- DLQ for stats stream failures.
- Scheduled rebuild job redundancy.
- Partial close handling for accurate realized metrics.
- Canary/linear deployments to reduce blast radius.

## Observability
- Structured JSON logging utility (partial rollout).
- Initial CloudWatch alarm on stats function errors; more to add (throttles, latency, error rate%)

## OpenAPI & Documentation
- Served at `/v1/openapi.yaml` (raw) and `/v1/docs` (Swagger UI) allowing interactive exploration.
