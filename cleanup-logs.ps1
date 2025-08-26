<#
Purpose: Delete existing CloudWatch log groups for the trading-journal-backend stack
Reason: Prevent CloudFormation AlreadyExists conflicts when explicit LogGroup resources are managed in template.

Safe: Uses only AWS CLI describe/delete for targeted lambda log groups.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

$stackName = 'trading-journal-backend'

# Functions (keep in sync with template logical names WITHOUT random suffix)
$functionNames = @(
    'CreateTradeFunction',
    'GetTradeFunction',
    'ListTradesFunction',
    'UpdateTradeFunction',
    'DeleteTradeFunction',
    'GenerateUploadUrlFunction',
    'UpdateStatsFunction',
    'GetStatsFunction',
    'RebuildAllStatsFunction',
    'AuthSignUpFunction',
    'AuthConfirmSignUpFunction',
    'AuthLoginFunction',
    'AuthRefreshFunction',
    'AuthForgotPasswordFunction',
    'AuthConfirmForgotPasswordFunction',
    'AuthDeleteAccountFunction',
    'AuthExportAccountFunction',
    'AuthGlobalSignOutFunction',
    'OpenApiSpecFunction',
    'OpenApiDocsFunction',
    'ExtractTradesFunction'
)

Write-Host 'Cleaning CloudWatch log groups (if any)...' -ForegroundColor Yellow

function Get-LogGroups([string]$functionName) {
    $prefix = "/aws/lambda/$stackName-$functionName-"
    $raw = aws logs describe-log-groups --log-group-name-prefix $prefix --query "logGroups[].logGroupName" --output json 2>$null
    if (-not $raw -or $raw -eq 'null') { return @() }
    try {
        $parsed = $raw | ConvertFrom-Json
        # If AWS returns a single string, ConvertFrom-Json yields a [string]; wrap it.
        if ($parsed -is [string]) { return @($parsed) }
        # If it's already an array, force array context
        return @($parsed)
    } catch {
        return @()
    }
}

$deleted = 0
$notFound = 0
$failed = 0

foreach ($fn in $functionNames) {
    $groups = Get-LogGroups -functionName $fn
        if (-not $groups -or $groups.Length -eq 0) {
        $notFound++
        continue
    }
    foreach ($g in $groups) {
        Write-Host "Deleting: $g" -ForegroundColor Red
        aws logs delete-log-group --log-group-name $g 2>$null
        if ($LASTEXITCODE -eq 0) {
            $deleted++
        } else {
            Write-Host "Failed: $g" -ForegroundColor DarkYellow
            $failed++
        }
    }
}

Write-Host ''
Write-Host ('Summary -> Deleted: {0}  Failed: {1}  FunctionsWithNoGroups: {2}' -f $deleted,$failed,$notFound) -ForegroundColor Cyan
if ($failed -eq 0) {
    Write-Host 'Log group cleanup complete.' -ForegroundColor Green
} else {
    Write-Host 'Cleanup completed with some failures (see above).' -ForegroundColor DarkYellow
    exit 1
}
