# Onboarding Guide

Getting new contributors productive quickly.

## Prerequisites
- Node.js 20+
- AWS CLI configured (`aws configure`) with appropriate credentials
- SAM CLI installed
- (Optional) Docker (for future local emulation)

## Initial Setup
1. Clone repository.
2. Install dependencies:
```
npm install
```
3. Review `template.yaml` for resource overview.
4. (Optional) Create a feature branch.

## Environment Configuration
- Parameters:
  - `ApiVersion` (default `v1`)
  - `Stage` (future multi-stage support)
- Update or create `samconfig.toml` profiles for separate stages (dev/stage/prod) with parameter overrides.

## Build & Deploy
Deploy guided first time (sets StageName + ApiVersion):
```
sam deploy --guided
```
Subsequent deploys:
```
sam deploy
```

## Invoking Functions Locally (Optional)
Example (if local events defined later):
```
sam local invoke CreateTradeFunction -e events/create-trade.json
```

## Making Changes
1. Add/update handler code under `src/handlers/*`.
2. Shared utilities under `src/shared/*`.
3. Keep documentation updated (`docs/roadmap.md`).
4. Run lint/typecheck (add scripts later):
```
npm run build
```

## Testing Strategy (Planned)
- Unit tests for trade calculations and stats rebuild logic.
- Integration tests for auth → create trade → stats.
- Load tests for critical list endpoints.

## API Documentation
- OpenAPI: `/v1/openapi.yaml`
- Swagger UI: `/v1/docs`
- Endpoint reference: `docs/api-endpoints.md`

## Logging & Monitoring
- Structured JSON logs (logger utility) rolling out; includes level, time, requestId, userId.
- Avoid adding PII or large blobs to logs; summarize images/arrays.
- CloudWatch: check function-specific log groups; stats function alarm currently basic (errors ≥1).

## Security Practices
- Never commit secrets. Use AWS SSM Parameter Store (future migration task).
- Validate inputs (schemas) before logic – extend validation to all handlers.

## Contributing Workflow
1. Branch naming: `feature/<short-desc>` or `fix/<issue-id>`.
2. Commit messages: short imperative summary + detail.
3. Open PR; ensure CI (once added) passes (lint, tests, build).
4. Request review; incorporate feedback.

## Deployment Promotion (Future)
- dev → stage → prod via pipeline; canary then linear ramp.

## Troubleshooting Quick Tips
- Stats mismatch: invoke rebuild-all-stats Lambda (scheduled job also runs every 6h).
- Elevated errors right after deploy: check canary function version; roll alias back if needed.
- Missing images: confirm S3 keys vs. trade item image list; look for orphan objects.

## Reference Files
- `template.yaml`: Infra definition.
- `docs/architecture-diagram.md`: High-level design.
- `docs/runbook.md`: Incident playbooks.
- `docs/api-endpoints.md`: Endpoint summary.

## Next Steps for New Contributor
- Pick an item from roadmap with `[ ]` or `[~]` needing refinement.
- Open an issue describing approach before large changes.

Welcome aboard!
