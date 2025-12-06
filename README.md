# Serverless Trading Journal – High-Level Flow

This documentation captures a complete, programmatic AWS backend plan using Infrastructure as Code (AWS SAM), with Cognito-authenticated API Gateway + Lambda, DynamoDB, and S3. A frontend can be wired via AWS Amplify.

Use the phase guides for hands-on steps. Each phase is a separate, detailed markdown file.

## Architecture (conceptual)

```
+----------------+      +-------------------+      +---------------------+      +------------------------+      +------------------+
|   Web Browser  |----->|   AWS Amplify     |----->|  Amazon API Gateway |----->|     AWS Lambda         |----->| Amazon DynamoDB  |
| (React/Vue/etc)|      | (UI & Auth Logic) |      | (Cognito Authorizer)|      | (Business Logic)       |      |   (Trades Table) |
+----------------+      +-------------------+      +---------------------+      +------------------------+      +------------------+
       |                        |                            |                          |                             |
       |                        |                            |                          |   (Streams)                 |
       +------------------------|----------------------------|--------------------------|-----------------------------+
                                |                            |                          |                             |
                       +--------------------+                |                      +------------------------+      +-------------------+
                       |  Amazon Cognito    |                |                      |  updateStats Lambda    |----->|  DynamoDB         |
                       |   (User Pools)     |                |                      |  (Triggered by Stream) |      | (TradeStats Table)|
                       +--------------------+                |                      +------------------------+      +-------------------+
                                                             |
                                                     +---------------------------+      +------------------+
                                                     | generateUploadUrl Lambda  |----->|    Amazon S3     |
                                                     | (Presigned URL Generator) |      |  (Image Storage) |
                                                     +---------------------------+      +------------------+
```

## Quick Start

For detailed setup and deployment instructions, refer to:
- **Roadmap** - Development phases: [docs/roadmap.md](docs/roadmap.md)
- **Runbook** - Deployment procedures: [docs/runbook.md](docs/runbook.md)
- **YAML Reference** - SAM template guide: [docs/yaml.md](docs/yaml.md)

## Documentation

### Complete Application Context
- **Copilot Context** - Comprehensive API & UI reference: [../COPILOT_CONTEXT.md](../COPILOT_CONTEXT.md)
- **Trades API** - Detailed trade endpoints: [docs/api/trades.md](docs/api/trades.md)
- **Roadmap** - Feature roadmap: [docs/roadmap.md](docs/roadmap.md)
- **Runbook** - Operational guide: [docs/runbook.md](docs/runbook.md)

### Migration & Updates
- **Backend Updates Summary** - Complete changelog of new features: [BACKEND_UPDATES_SUMMARY.md](BACKEND_UPDATES_SUMMARY.md)
- **Migration Guide** - Step-by-step upgrade instructions: [MIGRATION_GUIDE.md](MIGRATION_GUIDE.md)

### Quick Start

1. **New Deployment**:
   ```bash
   sam build
   sam deploy --guided
   ```

2. **Check Available Endpoints**:
   ```bash
   sam list stack-outputs --stack-name trading-journal-backend-prod
   ```

3. **Test New Features**:
   - Accounts: `/v1/accounts`
   - Goals & Rules: `/v1/goals`, `/v1/rules`
   - Analytics: `/v1/analytics/hourly`, `/v1/analytics/daily-win-rate`
   - User Profile: `/v1/user/profile`
   - Export: `/v1/export/trades?format=csv`

## What's New

### Latest Update (December 2024)
✅ **26 new Lambda functions** supporting enhanced UI
✅ **6 new DynamoDB tables** (Accounts, Goals, Rules, Preferences, Options, Subscriptions)
✅ **Enhanced trade model** with `accountIds` and `brokenRuleIds`
✅ **Analytics endpoints** for hourly, daily, symbol, and strategy analysis
✅ **User preferences** and profile management
✅ **Subscription** management (payment integration pending)
✅ **Export functionality** (CSV/JSON)

See [BACKEND_UPDATES_SUMMARY.md](BACKEND_UPDATES_SUMMARY.md) for complete details.

