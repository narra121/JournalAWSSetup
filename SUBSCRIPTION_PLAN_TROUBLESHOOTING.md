# Subscription Plan Troubleshooting Guide

## Issue: "No subscription found" Error

### Root Cause
Subscription plans are automatically created during backend deployment via a CloudFormation Custom Resource. If you're seeing "No subscription found" errors, it means the plans haven't been initialized in Razorpay and stored in AWS Systems Manager Parameter Store.

### Why This Happens
1. **First deployment**: The custom resource might not have executed successfully
2. **Deployment skipped**: The stack was deployed without the custom resource trigger
3. **Resource failure**: The CloudFormation custom resource encountered an error during execution

---

## Solution Options

### Option 1: Redeploy the Stack (Recommended)

This will trigger the custom resource automatically:

```powershell
# For development environment
cd Backend
.\deploy-dev.ps1

# For production environment
.\deploy-prod.ps1 -StageName prod
```

The deployment will:
- Execute the `InitSubscriptionPlansFunction` Lambda via CloudFormation Custom Resource
- Create all 6 subscription plans in Razorpay
- Store plan IDs in SSM Parameter Store at paths like:
  - `/tradeflow/dev/razorpay/plan/monthly-99`
  - `/tradeflow/dev/razorpay/plan/monthly-299`
  - `/tradeflow/dev/razorpay/plan/monthly-499`
  - `/tradeflow/dev/razorpay/plan/yearly-999`
  - `/tradeflow/dev/razorpay/plan/yearly-2999`
  - `/tradeflow/dev/razorpay/plan/yearly-4999`

---

### Option 2: Manual Initialization (If Deployment Can't Be Run)

If you can't redeploy the entire stack, use the manual initialization script:

```powershell
cd Backend\scripts
.\init-subscription-plans.ps1 -StageName dev
```

This script will:
1. Locate the `InitSubscriptionPlansFunction` Lambda
2. Invoke it manually with a CloudFormation-like event
3. Verify that all plans were created and stored in SSM
4. Display the CloudWatch logs for debugging

---

### Option 3: Verify Custom Resource Execution

Check if the custom resource has already been executed:

#### 1. Check SSM Parameters
```powershell
# List all subscription plan parameters
aws ssm get-parameters-by-path `
  --path "/tradeflow/dev/razorpay/plan" `
  --query 'Parameters[*].[Name,Value]' `
  --output table
```

If you see 6 parameters (3 monthly + 3 yearly), the plans are already created.

#### 2. Check CloudWatch Logs
```powershell
# View the logs from the initialization function
aws logs tail "/aws/lambda/trading-journal-backend-dev-InitSubscriptionPlansFunction" --follow
```

Look for log entries showing:
- ✓ "Created plan: plan_xxxxx"
- ✓ "Stored plan ID in SSM"
- ✓ "All plans initialized"

#### 3. Check CloudFormation Events
```powershell
# View stack events to see if custom resource executed
aws cloudformation describe-stack-events `
  --stack-name trading-journal-backend-dev `
  --query 'StackEvents[?ResourceType==`Custom::InitSubscriptionPlans`]' `
  --output table
```

---

## Verification Steps

After running one of the solutions above, verify the plans are available:

### 1. Test the API Endpoint
```powershell
# Get the API URL from CloudFormation outputs
$apiUrl = aws cloudformation describe-stacks `
  --stack-name trading-journal-backend-dev `
  --query "Stacks[0].Outputs[?OutputKey=='SubscriptionPlansEndpoint'].OutputValue" `
  --output text

# Test the endpoint (requires authentication)
curl $apiUrl
```

Expected response:
```json
{
  "data": {
    "plans": [
      {
        "planId": "plan_xxxxx",
        "period": "monthly",
        "amount": 99,
        "tier": "supporter",
        "name": "TradeFlow Supporter Monthly",
        ...
      },
      ...
    ]
  },
  "error": null,
  "meta": null
}
```

### 2. Verify in Razorpay Dashboard
1. Log in to [Razorpay Dashboard](https://dashboard.razorpay.com/)
2. Navigate to **Subscriptions → Plans**
3. You should see 6 plans with names starting with "TradeFlow"

### 3. Test Frontend Integration
1. Open your frontend application
2. Navigate to the Profile/Subscription page
3. You should see all available subscription plans (no error message)
4. Plans should be selectable and clickable

---

## Default Plans Created

| Plan Name | Amount | Period | Tier |
|-----------|--------|--------|------|
| TradeFlow Supporter Monthly | ₹99 | Monthly | supporter |
| TradeFlow Enthusiast Monthly | ₹299 | Monthly | enthusiast |
| TradeFlow Champion Monthly | ₹499 | Monthly | champion |
| TradeFlow Supporter Yearly | ₹999 | Yearly | supporter |
| TradeFlow Enthusiast Yearly | ₹2,999 | Yearly | enthusiast |
| TradeFlow Champion Yearly | ₹4,999 | Yearly | champion |

**Note:** All plans include the same features. Higher tiers are to support development.

---

## Common Errors and Solutions

### Error: "Lambda function not found"
**Solution:** Deploy the backend first:
```powershell
.\deploy-dev.ps1
```

### Error: "ParameterNotFound" from SSM
**Solution:** Plans haven't been initialized. Run Option 1 or Option 2 above.

### Error: "RazorpayError: Key/secret mismatch"
**Solution:** Check your Razorpay credentials in the deployment:
```powershell
# Verify the parameters
aws cloudformation describe-stacks --stack-name trading-journal-backend-dev --query "Stacks[0].Parameters"
```

Make sure `RazorpayKeyId` and `RazorpayKeySecret` are set correctly.

### Error: "Selected plan is not available"
**Solution:** This means the plan exists in the UI but not in Razorpay. The frontend filtered plans properly, but backend initialization is incomplete. Run Option 1 or 2.

---

## Preventing This Issue

### Always Deploy via SAM
Don't manually create Lambda functions or skip the deployment process. Always use:
```powershell
sam deploy
```

### Monitor CloudFormation Custom Resources
During deployment, watch for custom resource events:
```powershell
aws cloudformation describe-stack-events --stack-name trading-journal-backend-dev
```

### Set Up CloudWatch Alarms
Create an alarm for the `InitSubscriptionPlansFunction` Lambda to notify you of failures.

---

## Need More Help?

1. **Check the logs**: 
   ```powershell
   aws logs tail "/aws/lambda/trading-journal-backend-dev-InitSubscriptionPlansFunction" --follow
   ```

2. **Review the code**: 
   - Custom resource handler: `Backend/src/handlers/init-subscription-plans/app.ts`
   - Plans retrieval: `Backend/src/handlers/get-subscription-plans/app.ts`

3. **CloudFormation template**: 
   - Resource definition: `Backend/template.yaml` (lines 1831-1873)

4. **Documentation**:
   - Full guide: `Backend/docs/subscription-plan-initialization.md`
