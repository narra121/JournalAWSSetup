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

## Phase Index

- Phase 0 – Prerequisites and Local Setup: [docs/phase-0-prerequisites-and-local-setup.md](docs/phase-0-prerequisites-and-local-setup.md)
- Phase 1 – Backend Infrastructure with AWS SAM: [docs/phase-1-sam-backend-infrastructure.md](docs/phase-1-sam-backend-infrastructure.md)
- Phase 2 – Develop Lambda Function Code: [docs/phase-2-develop-lambda-functions.md](docs/phase-2-develop-lambda-functions.md)
- Phase 3 – Deploy the Backend (Programmatic): [docs/phase-3-deploy-backend.md](docs/phase-3-deploy-backend.md)
- Phase 4 – Frontend and Authentication (Amplify): [docs/phase-4-frontend-and-auth-amplify.md](docs/phase-4-frontend-and-auth-amplify.md)
- Phase 5 – Continuous Integration & Deployment (CI/CD): [docs/phase-5-ci-cd.md](docs/phase-5-ci-cd.md)

## Usage Notes

- Commands are shown for Windows PowerShell 5.1+.
- Replace placeholders like <YOUR_REGION>, <YOUR_BUCKET>, <STACK_NAME> with your values.
- Keep the docs and code in sync; treat `template.yaml` as the single source of truth for infrastructure.

## API Documentation

Primary trade endpoints and behavior (create, bulk create, get, list, update, single & bulk delete, hybrid PnL logic, idempotency) are documented in `docs/api/trades.md`.
