# Script to remove accountIds field from all trades in DynamoDB
# This cleans up legacy accountIds field that should no longer exist

param(
    [string]$TableName = "Trades-dev-v1",
    [string]$Profile = "default",
    [switch]$DryRun = $false
)

Write-Host "Cleaning up accountIds field from table: $TableName" -ForegroundColor Cyan
Write-Host "Profile: $Profile" -ForegroundColor Cyan
Write-Host "Dry Run: $DryRun" -ForegroundColor Cyan
Write-Host ""

# Scan the table to get all items
Write-Host "Scanning table for trades with accountIds field..." -ForegroundColor Yellow

$scanCommand = "aws dynamodb scan --table-name $TableName --profile $Profile --filter-expression `"attribute_exists(accountIds)`" --projection-expression `"userId,tradeId,accountIds`""

$result = Invoke-Expression $scanCommand | ConvertFrom-Json

$items = $result.Items
$count = $items.Count

Write-Host "Found $count trades with accountIds field" -ForegroundColor Green

if ($count -eq 0) {
    Write-Host "No trades to update. Exiting." -ForegroundColor Green
    exit 0
}

# Update each item to remove accountIds
$updated = 0
$failed = 0

foreach ($item in $items) {
    $userId = $item.userId.S
    $tradeId = $item.tradeId.S
    $accountIds = $item.accountIds.L
    
    Write-Host "Processing trade: $tradeId (user: $userId)" -ForegroundColor Cyan
    Write-Host "  Current accountIds: $($accountIds | ConvertTo-Json -Compress)" -ForegroundColor Gray
    
    if (-not $DryRun) {
        try {
            # Remove the accountIds attribute
            $updateCommand = "aws dynamodb update-item --table-name $TableName --profile $Profile --key `"{```"userId```":{```"S```":`"`"$userId`"`"},```"tradeId```":{```"S```":`"`"$tradeId`"`"}}`" --update-expression `"REMOVE accountIds`""
            
            Invoke-Expression $updateCommand | Out-Null
            
            Write-Host "  Success: Removed accountIds" -ForegroundColor Green
            $updated++
        }
        catch {
            Write-Host "  Failed: $_" -ForegroundColor Red
            $failed++
        }
    }
    else {
        Write-Host "  [DRY RUN] Would remove accountIds" -ForegroundColor Yellow
        $updated++
    }
}

Write-Host ""
Write-Host "==================== Summary ====================" -ForegroundColor Cyan
Write-Host "Total trades found: $count" -ForegroundColor White
Write-Host "Updated: $updated" -ForegroundColor Green
if ($failed -gt 0) {
    Write-Host "Failed: $failed" -ForegroundColor Red
}
if ($DryRun) {
    Write-Host ""
    Write-Host "This was a DRY RUN. No changes were made" -ForegroundColor Yellow
    Write-Host "Run without -DryRun parameter to apply changes" -ForegroundColor Yellow
}
