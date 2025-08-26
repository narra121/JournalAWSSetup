# Phase 5 – Continuous Integration & Deployment (CI/CD)

Goal: Fully automate build and deploy for both backend (SAM) and frontend.

## Source Control

- Commit SAM template, Lambda code, frontend code, and these docs

## GitHub Actions (example)

- Backend workflow `.github/workflows/backend.yml` (sketch):

```yaml
name: backend
on:
  push:
    branches: [ main ]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/setup-sam@v2
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: us-east-1
        - run: npm ci
        - run: npm run build  # typecheck/bundle (add script)
        - run: sam validate
        - run: sam build
        - run: sam deploy --no-confirm-changeset --no-fail-on-empty-changeset --stack-name trading-journal-backend --parameter-overrides ApiVersion=v1 StageName=prod
```

- Frontend workflow `.github/workflows/frontend.yml` (sketch):

```yaml
name: frontend
on:
  push:
    branches: [ main ]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm run build
      - name: Deploy to S3/CloudFront or Amplify Hosting
        run: echo "Upload build output here (aws s3 sync / amplify hosting)"
```

## AWS CodePipeline (alternative)

- Source: GitHub or CodeCommit
- Build: CodeBuild projects for backend and frontend
- Deploy: CloudFormation (SAM) + S3/CloudFront or Amplify Hosting

## Secrets & Config

- Store AWS creds and API base URL as encrypted repo secrets
- Use environment-specific stacks (e.g., `trading-journal-backend-dev`, `-prod`)

## Quality Gates

- Lint, Typecheck, Unit tests on PR / push
- `sam validate` every push
- (Planned) Integration tests against ephemeral stack before prod promotion

## Next

Multi-Stage: Use separate `samconfig.toml` named profiles (e.g., dev/stage/prod) with distinct `StageName` + potentially `ApiVersion` for version promotions.

Return to [README](../README.md) for the overview.
