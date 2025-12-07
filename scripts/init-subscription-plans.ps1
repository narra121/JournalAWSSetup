# Manual script to initialize subscription plans
# Run this if the CloudFormation custom resource didn't execute properly

Param(
    [string]$StageName = "dev"
)

$ErrorActionPreference = 'Stop'

Write-Host "Initializing subscription plans for stage: $StageName" -ForegroundColor Cyan

# Get the Lambda function name
$functionName = "trading-journal-backend-$StageName-InitSubscriptionPlansFunction"

Write-Host "Lambda function: $functionName" -ForegroundColor Yellow

# Check if function exists
Write-Host "Checking if function exists..." -ForegroundColor Cyan
try {
    aws lambda get-function --function-name $functionName | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Function not found"
    }
} catch {
    Write-Host "ERROR: Lambda function not found. Have you deployed the backend?" -ForegroundColor Red
    Write-Host "Run deploy-dev.ps1 or deploy-prod.ps1 first" -ForegroundColor Yellow
    exit 1
}

# Invoke the Lambda function manually with a CloudFormation-like event
Write-Host "Invoking Lambda function to initialize plans..." -ForegroundColor Cyan

$event = @{
    RequestType = "Create"
    ResponseURL = "http://pre-signed-S3-url-for-response"
    StackId = "manual-invocation"
    RequestId = "manual-$(Get-Date -Format 'yyyyMMddHHmmss')"
    ResourceType = "Custom::InitSubscriptionPlans"
    LogicalResourceId = "SubscriptionPlansInitializer"
    ResourceProperties = @{
        ServiceToken = "manual"
    }
} | ConvertTo-Json -Depth 10

$eventFile = [System.IO.Path]::GetTempFileName()
Set-Content -Path $eventFile -Value $event

try {
    Write-Host "Event payload:" -ForegroundColor Gray
    Write-Host $event -ForegroundColor Gray
    
    $response = aws lambda invoke --function-name $functionName --payload file://$eventFile --cli-binary-format raw-in-base64-out response.json
    
    if ($LASTEXITCODE -ne 0) {
        throw "Lambda invocation failed"
    }
    
    Write-Host "`nLambda Response:" -ForegroundColor Green
    Get-Content response.json | ConvertFrom-Json | ConvertTo-Json -Depth 10
    
    Write-Host "`nChecking CloudWatch logs for details..." -ForegroundColor Cyan
    Start-Sleep -Seconds 3
    
    $logGroup = "/aws/lambda/$functionName"
    $streams = aws logs describe-log-streams --log-group-name $logGroup --order-by LastEventTime --descending --max-items 1 --query 'logStreams[0].logStreamName' --output text
    
    if ($streams -and $streams -ne "None") {
        Write-Host "`nRecent logs:" -ForegroundColor Yellow
        aws logs get-log-events --log-group-name $logGroup --log-stream-name $streams --limit 50 --query 'events[*].message' --output text
    }
    
    Write-Host "`nVerifying plans in SSM Parameter Store..." -ForegroundColor Cyan
    
    $planKeys = @("monthly-99", "monthly-299", "monthly-499", "yearly-999", "yearly-2999", "yearly-4999")
    
    Write-Host "`nStored Plan IDs:" -ForegroundColor Green
    foreach ($key in $planKeys) {
        $paramName = "/tradeflow/$StageName/razorpay/plan/$key"
        $planId = aws ssm get-parameter --name $paramName --query 'Parameter.Value' --output text 2>$null
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  ✓ $key : $planId" -ForegroundColor Green
        } else {
            Write-Host "  ✗ $key : NOT FOUND" -ForegroundColor Red
        }
    }
    
    Write-Host "`n✓ Subscription plans initialization complete!" -ForegroundColor Green
    Write-Host "You can now use the subscription plans in the frontend." -ForegroundColor Cyan
    
} finally {
    if (Test-Path $eventFile) {
        Remove-Item $eventFile -Force
    }
    if (Test-Path response.json) {
        Remove-Item response.json -Force
    }
}
