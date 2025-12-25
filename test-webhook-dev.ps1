# Test Razorpay Webhook in Dev Environment
# This script sends a test webhook event to verify the handler works correctly

Write-Host "Testing Razorpay Webhook Handler (Dev Environment)" -ForegroundColor Cyan

# Get the API base URL from CloudFormation stack outputs
Write-Host "`nFetching API URL from stack..." -ForegroundColor Yellow
$apiUrl = aws cloudformation describe-stacks `
    --stack-name tradeflow-dev `
    --query "Stacks[0].Outputs[?OutputKey=='ApiBaseUrl'].OutputValue" `
    --output text

if (-not $apiUrl) {
    Write-Host "Error: Could not retrieve API URL from CloudFormation stack" -ForegroundColor Red
    exit 1
}

Write-Host "API URL: $apiUrl" -ForegroundColor Green

# Webhook endpoint
$webhookUrl = "$apiUrl/payments/webhook"
Write-Host "Webhook URL: $webhookUrl" -ForegroundColor Green

# Get webhook secret from SSM Parameter Store
Write-Host "`nFetching webhook secret from SSM..." -ForegroundColor Yellow
$webhookSecret = aws ssm get-parameter `
    --name "/tradeflow/razorpayWebhookSecret" `
    --with-decryption `
    --query "Parameter.Value" `
    --output text

if (-not $webhookSecret) {
    Write-Host "Error: Could not retrieve webhook secret from SSM" -ForegroundColor Red
    Write-Host "Make sure the parameter '/tradeflow/razorpayWebhookSecret' exists" -ForegroundColor Yellow
    exit 1
}

Write-Host "Webhook secret retrieved successfully" -ForegroundColor Green

# Create a test webhook payload (subscription.activated event)
$testPayload = @{
    event = "subscription.activated"
    payload = @{
        subscription = @{
            entity = @{
                id = "sub_test_" + (Get-Random -Maximum 999999)
                plan_id = "plan_test_123"
                status = "active"
                quantity = 1
                total_count = 120
                paid_count = 1
                remaining_count = 119
                current_start = [int][double]::Parse((Get-Date -UFormat %s))
                current_end = [int][double]::Parse(((Get-Date).AddMonths(1) | Get-Date -UFormat %s))
                charge_at = [int][double]::Parse(((Get-Date).AddMonths(1) | Get-Date -UFormat %s))
                notes = @{
                    userId = "test-user-" + (Get-Random -Maximum 99999)
                }
            }
        }
    }
    created_at = [int][double]::Parse((Get-Date -UFormat %s))
} | ConvertTo-Json -Depth 10

Write-Host "`nTest Payload:" -ForegroundColor Yellow
Write-Host $testPayload

# Generate HMAC SHA256 signature
$hmac = New-Object System.Security.Cryptography.HMACSHA256
$hmac.Key = [System.Text.Encoding]::UTF8.GetBytes($webhookSecret)
$signature = [System.BitConverter]::ToString(
    $hmac.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($testPayload))
).Replace("-", "").ToLower()

Write-Host "`nGenerated Signature: $sigwebnature" -ForegroundColor Green

# Send webhook request
Write-Host "`nSending webhook request..." -ForegroundColor Yellow

try {
    $response = Invoke-WebRequest `
        -Uri $webhookUrl `
        -Method POST `
        -Headers @{
            "Content-Type" = "application/json"
            "x-razorpay-signature" = $signature
        } `
        -Body $testPayload `
        -UseBasicParsing

    Write-Host "`n✅ SUCCESS!" -ForegroundColor Green
    Write-Host "Status Code: $($response.StatusCode)" -ForegroundColor Green
    Write-Host "Response:" -ForegroundColor Cyan
    Write-Host $response.Content
} catch {
    Write-Host "`n❌ FAILED!" -ForegroundColor Red
    Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
    
    if ($_.Exception.Response) {
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        $responseBody = $reader.ReadToEnd()
        Write-Host "`nResponse Body:" -ForegroundColor Yellow
        Write-Host $responseBody
    }
    
    exit 1
}

Write-Host ""
Write-Host "Check CloudWatch Logs for detailed execution logs:" -ForegroundColor Cyan
Write-Host 'aws logs tail /aws/lambda/tradeflow-dev-RazorpayWebhookFunction --follow' -ForegroundColor White
