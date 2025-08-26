# Runbook

Operational guide for incident response and common failure modes.

## Quick Reference
- API Spec: `/v1/openapi.yaml`
- Swagger UI: `/v1/docs`
- Main Tables: Trades, TradeStats
- Critical Lambdas: create-trade, update-trade, list-trades, update-stats (stream), rebuild-all-stats
- DLQ: StatsDLQ (SQS) for failed stream events

## Monitoring & Dashboards
(Currently minimal) – Add CloudWatch dashboards for:
- Lambda Errors & Throttles
- Duration & Cold Starts
- DynamoDB Throttle Events
- DLQ ApproximateNumberOfMessagesVisible

## Common Playbooks
### 1. Stats Out of Sync
Strategy uses FULL REBUILD per user on stream events plus scheduled 6h rebuild. Issues are rare; if they occur:
Actions:
1. Check CloudWatch logs for `update-stats` Lambda for recent errors.
2. Inspect DLQ (StatsDLQ). If messages exist:
   - Review a sample message body; identify underlying trade event.
   - Fix root cause (e.g., malformed item) and reprocess (move message back to source via replay script or manual invoke of rebuild job).
3. Manually invoke rebuild-all-stats Lambda to repair aggregates immediately.
4. If persistent, export affected user's trades; investigate malformed trade records (partialCloses integrity).

### 2. Elevated 5xx Error Rate After Deployment
Canary/linear deployments send a small % first.
1. Inspect CodeDeploy deployment in console (alias `live`).
2. Review error metrics & logs for new version only.
3. Rollback: shift alias to previous version manually (until automated rollback alarms configured).
4. Capture sample request IDs for reproduction & root cause analysis.

### 3. Throttling (DynamoDB or Lambda)
Actions:
1. Review CloudWatch metrics: `Throttles` for Lambda, `ThrottledRequests` for DynamoDB.
2. For Lambda: consider raising reserved concurrency for hot paths; investigate spikes.
3. For DynamoDB: review capacity mode (on-demand assumed). If sustained high usage, consider GSIs usage patterns and query efficiency.

### 4. DLQ Growth
Actions:
1. List messages from StatsDLQ.
2. Parse message to identify failing trade record.
3. Re-run logic locally or replicate failing scenario.
4. After fix, delete or reprocess messages (script to call primary handler with original event records).

### 5. Image Handling Failures
Symptoms: Missing images, stale references.
Actions:
1. Check `update-trade` or `create-trade` logs for image processing summary.
2. Confirm objects in S3 bucket match trade item image keys.
3. For orphaned images, schedule cleanup script (future enhancement).

### 6. Cognito Auth Issues
Symptoms: Login failures, token invalid.
Actions:
1. Validate User Pool client settings (flows, secret, allowed origins).
2. Decode JWT (jwt.io) and ensure `aud` and `iss` match configuration.
3. Review CloudWatch logs for auth endpoints for validation errors.

## Diagnostics
- Use structured logs: filter by `requestId` or `userId` fields.
- Include a correlationId header (future) to stitch multi-function flows.

## Emergency Manual Stats Rebuild
1. Invoke rebuild-all-stats Lambda with no payload.
2. Monitor duration vs. typical baseline.
3. If duration spikes, consider paginating or segmenting future job design.

## Change Management
- Canary/linear deployments minimize risk; observe metrics for first 5–10 minutes post-release.
- Pending: automated rollback tied to error rate alarms.

## Security Incidents
1. Revoke compromised user session via global sign-out endpoint.
2. Rotate any exposed secrets (after migration to SSM Parameter Store).
3. Review CloudTrail events for anomalous actions.

## Future Enhancements (Not Yet Implemented)
- Automated rollback lambda or CodeDeploy alarm triggers.
- Structured correlation/trace IDs across all logs.
- On-demand rebuild per user for targeted fixes.

## Contacts / Ownership
- Primary Maintainer: (TBD – fill in name/contact)
- Escalation Path: (TBD)
