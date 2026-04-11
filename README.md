# TradeQut Backend

Serverless trading journal API built with AWS SAM. Lambda + DynamoDB + Cognito + S3 + API Gateway.

## Architecture

```
Browser -> API Gateway (Cognito JWT) -> Lambda handlers -> DynamoDB / S3
                                                       -> DynamoDB Streams -> UpdateStats Lambda -> TradeStats + Account Balances
                                                       -> EventBridge (6h)  -> RebuildStats Lambda
```

**Resources**: 47 Lambda handlers, 8 DynamoDB tables, 1 S3 bucket, Cognito User Pool, Razorpay integration, Gemini AI (text enhance + trade extraction).

## Prerequisites

- [AWS CLI](https://aws.amazon.com/cli/) v2+
- [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html) v1.120+
- [Bun](https://bun.sh)
- AWS credentials configured (`aws configure`)
- [Razorpay](https://dashboard.razorpay.com/) account (test + live keys)
- [Google Gemini API key](https://aistudio.google.com/apikey)

## Local Development

### Prerequisites

1. **Docker Desktop** installed and running ([download](https://www.docker.com/products/docker-desktop/))
2. **AWS CLI** configured with valid credentials:
   ```powershell
   aws configure
   # Access Key ID, Secret Access Key, region: us-east-1
   aws sts get-caller-identity   # verify it works
   ```
3. **SAM CLI** installed ([install guide](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html))

### Setup (one-time)

```powershell
bun install
```

Edit `env-local.json` with your deployed dev resource names. Get them from:
```powershell
aws cloudformation describe-stacks --stack-name tradequt-dev --query "Stacks[0].Outputs" --output table
```

### Run backend locally

```powershell
sam build --parallel --cached        # first build is slow (~5-10 min on Windows)
sam local start-api --port 3001 --env-vars env-local.json
```

API available at `http://127.0.0.1:3001`. Lambda code runs in Docker containers locally but connects to **real AWS services** (DynamoDB, S3, Cognito).

After code changes, re-run `sam build` before restarting.

### Run with frontend

In a second terminal:
```powershell
cd ..\TradeQut
bun run dev:local                    # http://localhost:8080, API proxied to localhost:3001
```

## Deploy

### Dev (automatic on push to main)

```bash
# Manual deploy
sam build --parallel --cached
sam deploy --stack-name tradequt-dev --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM \
  --parameter-overrides StageName=tradequt-dev ApiVersion=v1 LogRetentionDays=7 \
  RazorpayKeyId=rzp_test_xxx RazorpayKeySecret=xxx RazorpayWebhookSecret=xxx
```

### Prod (manual trigger in GitHub Actions)

Go to Actions -> "Deploy to Production (Manual)" -> Run workflow -> type `deploy-to-production`.

### SSM Parameters (one-time)

```bash
aws ssm put-parameter --name "/tradequt/geminiApiKey" --value "YOUR_KEY" --type SecureString --overwrite
aws ssm put-parameter --name "/tradequt/razorpayWebhookSecret" --value "YOUR_SECRET" --type SecureString --overwrite
```

### GitHub Secrets (for CI/CD)

| Secret | Description |
|--------|-------------|
| `AWS_ACCESS_KEY_ID` | IAM access key |
| `AWS_SECRET_ACCESS_KEY` | IAM secret key |
| `GEMINI_API_KEY` | Google Gemini API key |
| `RAZORPAY_KEY_ID_DEV` / `_PROD` | Razorpay key IDs |
| `RAZORPAY_KEY_SECRET_DEV` / `_PROD` | Razorpay key secrets |
| `RAZORPAY_WEBHOOK_SECRET_DEV` / `_PROD` | Razorpay webhook secrets |

### Get Stack Outputs

```bash
aws cloudformation describe-stacks --stack-name tradequt-dev --query "Stacks[0].Outputs" --output table
```

## API Endpoints

All endpoints prefixed with `/v1`. Auth required unless noted.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/auth/signup` | Sign up (public) |
| POST | `/auth/confirm-signup` | Confirm email (public) |
| POST | `/auth/login` | Login (public) |
| POST | `/auth/refresh` | Refresh token (public) |
| POST | `/auth/forgot-password` | Forgot password (public) |
| POST | `/auth/confirm-forgot-password` | Reset password (public) |
| POST | `/trades` | Create trade(s) |
| GET | `/trades` | List trades (paginated, filterable) |
| PUT | `/trades/{tradeId}` | Update trade |
| DELETE | `/trades/{tradeId}` | Delete trade |
| POST | `/trades/bulk-delete` | Bulk delete trades |
| POST | `/trades/extract` | Extract trades from image (AI) |
| GET | `/images/{imageId+}` | Get trade image |
| POST | `/enhance-text` | AI text enhancement |
| GET | `/accounts` | List accounts |
| POST | `/accounts` | Create account |
| PUT | `/accounts/{accountId}` | Update account |
| PUT | `/accounts/{accountId}/status` | Update account status |
| DELETE | `/accounts/{accountId}` | Delete account + trades + goals |
| GET | `/rules-goals` | Get rules and goals |
| PUT | `/goals/{goalId}` | Update goal |
| GET | `/rules` | List rules |
| POST | `/rules` | Create rule |
| PUT | `/rules/{ruleId}` | Update rule |
| PUT | `/rules/{ruleId}/toggle` | Toggle rule |
| DELETE | `/rules/{ruleId}` | Delete rule |
| GET | `/analytics/hourly-stats` | Hourly performance |
| GET | `/analytics/daily-win-rate` | Daily win rate |
| GET | `/analytics/symbol-distribution` | Symbol breakdown |
| GET | `/analytics/strategy-distribution` | Strategy breakdown |
| GET | `/user/profile` | Get profile |
| PUT | `/user/profile` | Update profile |
| PUT | `/user/preferences` | Update preferences |
| PUT | `/user/notifications` | Update notifications |
| GET | `/options` | Get saved dropdown options |
| PUT | `/options` | Update saved options |
| GET | `/subscriptions/plans` | Get subscription plans (public) |
| POST | `/subscriptions` | Create subscription |
| GET/PUT/PATCH/DELETE | `/subscriptions` | Manage subscription |
| POST | `/payments/create-order` | Create Razorpay order |
| POST | `/payments/verify` | Verify payment |
| POST | `/payments/webhook` | Razorpay webhook (public) |

## DynamoDB Tables

| Table | Keys | Purpose |
|-------|------|---------|
| Trades | `userId` (PK), `tradeId` (SK) | Trade records, DynamoDB Streams enabled |
| TradeStats | `userId` (PK) | Aggregated user statistics |
| Accounts | `userId` (PK), `accountId` (SK) | Trading accounts with balance tracking |
| Goals | `userId` (PK), `goalId` (SK) | Trading goals |
| Rules | `userId` (PK), `ruleId` (SK) | Trading rules |
| UserPreferences | `userId` (PK) | User settings |
| SavedOptions | `userId` (PK) | Saved dropdown options |
| Subscriptions | `userId` (PK) | Subscription records |
| AuthRateLimit | `key` (PK) | Rate limiting with TTL |

## Project Structure

```
src/
  handlers/       # 47 Lambda handlers (one per endpoint)
  shared/         # Shared utilities (dynamo, s3, validation, logger)
  schemas/        # JSON Schema validation files
template.yaml     # SAM infrastructure-as-code
scripts/          # Subscription plan initialization
events/           # Sample Lambda test events
deploy-*.ps1      # PowerShell deployment scripts
```

## Useful Commands

```bash
bun run build          # sam build
bun run validate       # sam validate
bun run logs:dev       # Tail Lambda logs
bun run status:dev     # Stack status
bun run outputs:dev    # Stack outputs
bun run url:dev        # API URL
```

## Razorpay Webhook Setup

After deployment, configure the webhook in [Razorpay Dashboard](https://dashboard.razorpay.com/):

1. Go to Settings -> Webhooks -> Add New
2. URL: `{ApiBaseUrl}/payments/webhook`
3. Events: `subscription.activated`, `subscription.charged`, `subscription.completed`, `subscription.cancelled`, `subscription.paused`, `subscription.resumed`, `payment.captured`
4. Secret: Use the webhook secret stored in SSM

## Further Reference

- [docs/openapi.yaml](docs/openapi.yaml) - OpenAPI 3.0 spec
- [docs/yaml.md](docs/yaml.md) - SAM template reference
- [docs/runbook.md](docs/runbook.md) - Operations runbook
- [docs/roadmap.md](docs/roadmap.md) - Feature roadmap
