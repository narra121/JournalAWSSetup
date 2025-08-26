# Trading Journal Backend – Feature Roadmap & Status

Legend: `[x]` = Complete / shipped, `[~]` = Partial / needs refinement, `[ ]` = Not started.

---
## 1. Core Functionality
- [x] CRUD Trades (create, get, list, update, delete)
- [x] Extended Trade Schema (risk, psychology, notes, images, tags, metrics)
- [x] Image Handling (base64 inline upload + presigned URL support)
- [x] Image Diff on Update (add new, retain unchanged, delete removed)
- [x] Cascade Image Deletion on Trade Delete
- [x] Aggregate Stats via DynamoDB Stream (wins/losses, best/worst, realizedPnL, expectancy derivations)
- [x] Recompute Stats on exitPrice edits (full rebuild on MODIFY/REMOVE & closed INSERT)
- [x] Recompute best/worst on trade deletion (full rebuild ensures accuracy)
- [~] Pagination for List Trades (LastEvaluatedKey + limit)  *(implemented basic pagination & nextToken)*
- [~] Filtering (symbol, status, tag, date range combined) *(initial symbol/status/tag/date filters added)*
- [~] Secondary GSIs (e.g., symbol-date, status-date) *(added GSIs user-symbol-date, user-status-date, idempotency)*
- [~] Idempotent Create (client idempotency key header) *(header supported, returns existing)*
- [ ] Bulk Import/Export Trades

## 2. Authentication & Authorization
- [x] Cognito User Pool + Client
- [x] JWT Authorizer on API Gateway (default)
- [x] Custom Auth Endpoints (signup, confirm-signup, login, refresh, forgot password, confirm forgot password)
- [~] Password Policy Enforcement / Validation Feedback *(Cognito policy set; need custom validation messaging)*
- [x] Account Deletion Endpoint (purge user data + images + stats + Cognito user)
- [x] User Data Export (JSON bundle of trades + stats)
- [x] Session Revocation / Global Sign-Out (admin global sign-out endpoint)
- [~] Brute Force / Rate Limiting (basic DynamoDB TTL counter implemented; future: WAF/IP + exponential backoff)

## 3. Data Validation & Contracts
- [x] Central JSON Schemas (create/update trade, auth bodies)
- [~] Runtime Schema Validation (AJV) with detailed error codes *(create-trade integrated; others pending)*
 - [x] OpenAPI / Swagger Spec Generation (initial `docs/openapi.yaml`)
- [~] Consistent Response Envelope `{ data, meta, error }` *(create-trade implemented)*
- [~] Error Code Catalog (e.g., TRADE_NOT_FOUND, VALIDATION_ERROR) *(initial codes added)*

## 4. Security & Compliance
- [x] Principle of Least Privilege (initial targeted policies) *(needs review)*
- [ ] Policy Tightening (remove remaining wildcards, separate roles per function)
- [x] S3 Block Public Access Explicitly Enforced (bucket PublicAccessBlockConfiguration added)
- [ ] S3 Default Encryption (AES256/KMS)
- [ ] DynamoDB PITR (Point-In-Time Recovery) Enabled
- [ ] Secrets / Config via SSM Parameter Store (instead of plain env)
- [ ] Image Size / Type Validation + Rejection
- [ ] Image Sanitization / Malware Scan Pipeline
- [ ] Audit Logging Trail (CloudTrail analysis + custom events)
- [ ] Data Retention / Deletion Policy (GDPR style)

## 5. Reliability & Resilience
- [x] Stream-Based Stats Updater
- [~] Dead Letter Queue (DLQ) for Stream Processing Failures *(stats stream DLQ added)*
- [~] Retry / Backoff Strategy (explicit) for transient errors *(stream config: bisect + max 2 retries)*
- [~] CloudWatch Alarms (errors %, throttles, latency) per Lambda *(initial error alarm for stats function)*
- [x] Automatic Stats Rebuild Job (periodic full recompute) *(EventBridge 6h schedule)*
- [~] Graceful Handling of Partial Closes (multi-stage closes) *(partial closes data model & calc added)*
- [~] High Cardinality Safe Logging (avoid large payload logs) *(update-trade safe field summary)*

## 6. Observability
- [~] Structured JSON Logging (level, requestId, userId) *(logger utility added; integrated in get/list trades)*
- [ ] Correlation / Trace IDs Propagation
- [ ] AWS X-Ray Tracing Enabled
- [ ] Custom Metrics (trade_created, trade_closed, stats_rebuild_duration)
- [ ] Centralized Dashboard (CloudWatch or Grafana)

## 7. Performance & Cost Optimization
- [x] TypeScript + esbuild Bundling (reduces size) *(baseline)*
- [ ] Bundle Size Audit / Tree Shaking (remove unused AWS SDK clients)
- [ ] Cold Start Optimization (layer reuse, minimal deps)
- [ ] DynamoDB Access Patterns Review (avoid scans)
- [ ] Batch Operations Where Appropriate
- [ ] Adaptive Concurrency Controls (reserved concurrency for hot functions)

## 8. Testing & Quality
- [ ] Unit Tests (trade derive logic, stats transitions, auth flow)
- [ ] Integration Tests (end-to-end signup→CRUD→stats)
- [ ] Load / Soak Tests (baseline latency, error rate under load)
- [ ] Mutation Testing / Coverage Thresholds
- [ ] Pre-Commit Hooks (lint, typecheck, tests)
- [ ] Security Dependency Scans in CI (npm audit, osv scanner)

## 9. Deployment & DevOps
- [x] SAM Infrastructure as Code
- [ ] CI Pipeline (lint/test/build/deploy with approvals) – GitHub Actions / CodePipeline
- [~] Multi-Stage Environments (dev/stage/prod stacks) *(Stage + ApiVersion params added; need separate config files)*
- [~] Blue/Green or Canary Deployments (CodeDeploy integration) *(canary/linear deployment preferences added)*
- [ ] Automated Rollback on Alarm Trigger *(alarms partial; need hook for rollback policy)*
- [x] Versioned API Strategy (/v1 prefix) & Deprecation Policy *(ApiVersion parameter + path prefix)*

## 10. Data Modeling Extensions
- [ ] Partial Fills / Multi-Leg Trades (child items + parent aggregation)
- [ ] Symbol-Level Performance Stats (PnL per symbol)
- [ ] Tag Frequency / Performance Stats
- [ ] R-Multiple Tracking & Net Realized PnL (including costs)
- [ ] Journal Sentiment Index (aggregate psychology metrics over time)

## 11. User Experience & API Ergonomics
- [ ] Consistent Pagination Meta (`{ items, nextToken }`)
- [ ] Sorting Options (openDate desc, pnl desc)
- [ ] Client Hints / Minimal Field Projections (`fields` query param)
- [ ] Timezone Handling Strategy (store UTC, convert on client)
- [ ] Rate Limit Headers (X-RateLimit-*)

## 12. Governance & Housekeeping
- [ ] Log Retention Policy (e.g. 30/90 days tiering)
- [ ] S3 Lifecycle (image archival / deletion for deleted trades)
- [ ] Scheduled Backups / Export (S3 snapshots of trades table)
- [ ] Dependency Update Automation (Renovate/Bot)
- [ ] SLA/SLO Definition (latency/error budgets) & Monitoring

## 13. Documentation
- [x] Comprehensive Endpoint Reference (`api-endpoints.md`)
 - [x] OpenAPI Spec Published (`/v1/openapi.yaml` + Swagger UI `/v1/docs`)
 - [x] Architecture Diagram (high-level components) (`architecture-diagram.md`)
 - [x] Runbook (incident response, common failure modes) (`runbook.md`)
 - [x] Onboarding Guide (dev setup, deploy steps) (`onboarding-guide.md`)

## 14. Nice-to-Have / Stretch
- [ ] WebSocket or EventBridge Notifications (real-time trade updates)
- [ ] Frontend UI (React/Vue journaling dashboard)
- [ ] ML Insights (anomaly detection on PnL / psychology patterns)
- [ ] Public Demo Sandbox Environment

---
## Snapshot Summary
Completed: Core CRUD, extended schema, image lifecycle, stats (baseline), custom auth endpoints, TypeScript build, docs.
Partial: IAM least privilege (needs review), bundling optimization potential.
Pending (High Impact Next): Validation + OpenAPI, pagination & filtering, observability (structured logs + alarms), security hardening (encryption, PITR), CI pipeline.

---
## Suggested Immediate Next Sprint (Example)
1. Add JSON schema validation & unified error envelope.
2. Implement pagination + filtering (symbol, status, tag) and update docs.
3. Enable DynamoDB PITR + S3 encryption + block public access.
4. Introduce structured logging + basic CloudWatch alarms.
5. Author initial OpenAPI spec and publish in repo.

---
(Keep this file updated as items progress. Adjust priorities based on user feedback & usage metrics.)
