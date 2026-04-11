<# deploy-dev.ps1 v2 simplified #>
Param(
  [string]$StageName = "dev",
  [string]$Environment = "dev",
  [string]$ApiVersion = "v1",
  [int]$LogRetentionDays = 7,
  [string]$GeminiApiKeyParamName = "/trading-journal/geminiApiKey",
  [string]$RazorpayWebhookSecretParamName = "/tradequt/razorpayWebhookSecret",
  [string]$CustomDomainName = "api-dev.tradequt.com",
  [string]$CertificateArn = "arn:aws:acm:us-east-1:675016865482:certificate/46a1a4e3-507c-4e7c-a5cf-36bab5be4f2a",
  [string]$HostedZoneId = "Z00955773GZIPKHCD66GR",
  [string]$AllowedOrigins = "https://dev.tradequt.com"
)

$ErrorActionPreference = 'Stop'
$stackName = "trading-journal-backend-$StageName"

$paramOverrides = "StageName=$StageName Environment=$Environment ApiVersion=$ApiVersion GeminiApiKeyParamName=$GeminiApiKeyParamName RazorpayWebhookSecretParamName=$RazorpayWebhookSecretParamName LogRetentionDays=$LogRetentionDays UseExistingResources=false CustomDomainName=$CustomDomainName CertificateArn=$CertificateArn HostedZoneId=$HostedZoneId AllowedOrigins=$AllowedOrigins"

Write-Host "Deploying..." -ForegroundColor Cyan
sam deploy `
  --stack-name $stackName `
  --s3-bucket tradequt-sam-artifacts `
  --s3-prefix tradequt-backend `
  --no-confirm-changeset `
  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM `
  --parameter-overrides $paramOverrides
if ($LASTEXITCODE -ne 0) { throw "deployment failed" }

Write-Host "Outputs:" -ForegroundColor Green
aws cloudformation describe-stacks --stack-name $stackName --query "Stacks[0].Outputs"

Write-Host "API Base URL:" -ForegroundColor Green
aws cloudformation describe-stacks --stack-name $stackName --query "Stacks[0].Outputs[?OutputKey=='ApiBaseUrl'].OutputValue" --output text
