# Phase 3 – Deploy the Backend (Programmatic)

Goal: Build and deploy all resources via AWS SAM (CloudFormation) with versioned API (`/v1`) and canary-capable Lambda aliases.

## Build

```powershell
sam build
```

- Packages Lambda code and prepares artifacts.

## First-time Guided Deploy

```powershell
sam deploy --guided
```

Prompts (typical):
- Stack Name: `trading-journal-backend`
- AWS Region: e.g., `us-east-1`
- Confirm changes before deploy: `y`
- Allow SAM CLI to create roles: `y`
- Save arguments to configuration file: `y` (creates `samconfig.toml`)

## Subsequent Deploys

```powershell
sam deploy
```

## Outputs

- ApiBaseUrl (already includes stage + version suffix, e.g. `.../prod/v1`)
- Cognito User Pool Id & Client Id
- DynamoDB table names (Trades, TradeStats, AuthRateLimit)
- Images bucket name

Record these in a `.env` or pass to the frontend config.

## Deployment Preferences & Rollbacks

- Each function with `AutoPublishAlias: live` + CodeDeploy `DeploymentPreference` (e.g., Canary10Percent5Minutes) allows phased traffic shifting.
- Add CloudWatch alarms (errors, throttles, latency) to enable automatic rollback (future enhancement—currently partial).
- Failed CloudFormation stacks auto-rollback.
- To delete stack: console or CLI:

```powershell
aws cloudformation delete-stack --stack-name trading-journal-backend
```

## Next

Proceed to [Phase 4 – Frontend and Authentication (Amplify)](./phase-4-frontend-and-auth-amplify.md).
