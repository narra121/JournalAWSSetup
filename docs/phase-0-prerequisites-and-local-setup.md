# Phase 0 – Prerequisites and Local Setup

Goal: Set up your local environment to build and deploy with AWS SAM and (optionally) Amplify.

## Install Tooling

- Node.js LTS and npm
- AWS CLI v2
- AWS SAM CLI
- Amplify CLI (optional, for frontend wiring)
- VS Code + AWS Toolkit (optional)

## Verify Installations (Windows PowerShell)

```powershell
node -v
npm -v
aws --version
sam --version
amplify -v   # optional
```

## Configure AWS Credentials

```powershell
aws configure
# Enter: AWS Access Key ID, Secret Access Key, Default region name (e.g. us-east-1), Default output format (json)
```

- Ensure your IAM user/role has permissions for CloudFormation, S3, Lambda, API Gateway, DynamoDB, Cognito, and IAM pass-role.

## Folder Structure (suggested)

```
.
├─ template.yaml         # AWS SAM template (infra as code)
├─ src/                  # Lambda source code (by function)
└─ docs/                 # These documentation files
```

## Next

Proceed to [Phase 1 – Backend Infrastructure with AWS SAM](./phase-1-sam-backend-infrastructure.md).
