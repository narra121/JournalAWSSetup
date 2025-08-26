Param(
  [string]$StageName = "prod",
  [string]$ApiVersion = "v1",
  [int]$LogRetentionDays = 14,
  [string]$GeminiApiKeyParamName = "/trading-journal/geminiApiKey"
)

$ErrorActionPreference = 'Stop'
$stackName = "trading-journal-backend-$StageName"

$paramOverrides = @(
  "StageName=$StageName",
  "ApiVersion=$ApiVersion",
  "GeminiApiKeyParamName=$GeminiApiKeyParamName",
  "LogRetentionDays=$LogRetentionDays",
  "UseExistingResources=false"
)

Write-Host "Deploying..." -ForegroundColor Cyan
sam deploy `
  --stack-name $stackName `
  --no-confirm-changeset `
  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM `
  --parameter-overrides $paramOverrides
if ($LASTEXITCODE -ne 0) { throw "deployment failed" }

Write-Host "Outputs:" -ForegroundColor Green
aws cloudformation describe-stacks --stack-name $stackName --query "Stacks[0].Outputs"

Write-Host "API Base URL:" -ForegroundColor Green
aws cloudformation describe-stacks --stack-name $stackName --query "Stacks[0].Outputs[?OutputKey=='ApiBaseUrl'].OutputValue" --output text
