# Phase 1 – Backend Infrastructure with AWS SAM

Goal: Define all backend resources in a single `template.yaml` using AWS SAM (versioned API + progressive deployments).

## Contract
- Inputs: template.yaml definitions
- Outputs: CloudFormation stack with Cognito, API Gateway (HTTP API), Lambda functions, DynamoDB tables, S3 bucket
- Success: `sam build` passes and resources synthesize without errors

## Initialize a SAM Project (interactive)

```powershell
sam init
# Choose: AWS Quick Start Templates
# Runtime: nodejs20.x (or python3.11)
# Package type: Zip
# Project name: trading-journal-backend
```

This creates a starter layout including a `template.yaml`.

## Author the Template

Key sections to include:

- Globals: runtime, memory, timeout, environment, layers (optional)
- Cognito: User Pool and App Client; optional Google IdP (store client secret in Secrets Manager)
- S3: Private bucket for images (e.g., `ImagesBucket`)
- DynamoDB:
  - `TradesTable` (PK: `userId`, SK: `tradeId`), Streams enabled
  - GSIs: `trades-by-date-gsi`, `user-symbol-date-gsi`, `user-status-date-gsi`, `user-idempotency-gsi`
  - `TradeStatsTable` per user aggregates
- API Gateway: `AWS::Serverless::HttpApi` with Cognito authorizer; versioned path prefix via `ApiVersion` parameter (e.g. `/v1`).
- Lambda functions:
  - Trades: Create, Get, List (with filtering & pagination), Update (partial closes), Delete
  - Images: GenerateUploadUrl
  - Stats: UpdateStats (stream full rebuild) + RebuildAllStats (6h schedule)
  - Auth: signup, confirm-signup, login, refresh, forgot / confirm forgot password, account delete, export, logout-all
  - OpenAPI: spec + docs (public)
  All functions use `AutoPublishAlias: live` with CodeDeploy `DeploymentPreference` (e.g. `Canary10Percent5Minutes`).
- IAM Policies: Per-function least privilege (still pending full tightening for some wildcard actions).

## Example Resource Stubs (pseudocode)

```yaml
Globals:
  Function:
    Runtime: nodejs20.x
    Timeout: 10
    MemorySize: 256
    Environment:
      Variables:
        TRADES_TABLE: !Ref TradesTable
        TRADE_STATS_TABLE: !Ref TradeStatsTable
        IMAGES_BUCKET: !Ref ImagesBucket
Resources:
  TradesTable:
    Type: AWS::DynamoDB::Table
    Properties:
      BillingMode: PAY_PER_REQUEST
      AttributeDefinitions:
        - AttributeName: userId
          AttributeType: S
        - AttributeName: tradeId
          AttributeType: S
        - AttributeName: openDate
          AttributeType: S
        - AttributeName: symbolOpenDate
          AttributeType: S
        - AttributeName: statusOpenDate
          AttributeType: S
        - AttributeName: idempotencyKey
          AttributeType: S
      KeySchema:
        - AttributeName: userId
          KeyType: HASH
        - AttributeName: tradeId
          KeyType: RANGE
      GlobalSecondaryIndexes:
        - IndexName: trades-by-date-gsi
          KeySchema:
            - AttributeName: userId
              KeyType: HASH
            - AttributeName: openDate
              KeyType: RANGE
          Projection:
            ProjectionType: ALL
        - IndexName: user-symbol-date-gsi
          KeySchema:
            - AttributeName: userId
              KeyType: HASH
            - AttributeName: symbolOpenDate
              KeyType: RANGE
          Projection:
            ProjectionType: ALL
        - IndexName: user-status-date-gsi
          KeySchema:
            - AttributeName: userId
              KeyType: HASH
            - AttributeName: statusOpenDate
              KeyType: RANGE
          Projection:
            ProjectionType: ALL
        - IndexName: user-idempotency-gsi
          KeySchema:
            - AttributeName: userId
              KeyType: HASH
            - AttributeName: idempotencyKey
              KeyType: RANGE
          Projection:
            ProjectionType: ALL
      StreamSpecification:
        StreamViewType: NEW_AND_OLD_IMAGES
```

Continue with Cognito User Pool, HttpApi (authorizer + `/v1` paths), Functions (include alias + deployment preference), SQS DLQ for stream errors, and scheduled stats rebuild.

## Validating the Template

```powershell
sam validate
```

## Next

- Implement function code in [Phase 2 – Develop Lambda Functions](./phase-2-develop-lambda-functions.md).
