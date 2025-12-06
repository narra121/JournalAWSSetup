# Automatic Subscription Plan Initialization

## Overview

When you deploy the backend for the first time, subscription plans are automatically created in Razorpay and stored in AWS Systems Manager Parameter Store. This eliminates the need for manual plan creation.

## Default Plans Created

**Note:** All plans include the same features. Higher tiers are for users who want to provide extra support for development.

### Monthly Plans
1. **TradeFlow Supporter Monthly**
   - Amount: ₹99/month
   - Tier: Supporter
   - Description: All features included. Support the developer!

2. **TradeFlow Enthusiast Monthly**
   - Amount: ₹299/month
   - Tier: Enthusiast
   - Description: All features included. Extra support for continued development!

3. **TradeFlow Champion Monthly**
   - Amount: ₹499/month
   - Tier: Champion
   - Description: All features included. Help fund new features and improvements!

### Yearly Plans
1. **TradeFlow Supporter Yearly**
   - Amount: ₹999/year (saves ~16% vs monthly)
   - Tier: Supporter
   - Description: All features included. Support the developer!

2. **TradeFlow Enthusiast Yearly**
   - Amount: ₹2,999/year (saves ~16% vs monthly)
   - Tier: Enthusiast
   - Description: All features included. Extra support for continued development!

3. **TradeFlow Champion Yearly**
   - Amount: ₹4,999/year (saves ~16% vs monthly)
   - Tier: Champion
   - Description: All features included. Help fund new features and improvements!

## How It Works

### 1. CloudFormation Custom Resource
The `InitSubscriptionPlansFunction` Lambda is triggered automatically during stack deployment via a CloudFormation Custom Resource.

### 2. Plan Creation
- Creates plans in Razorpay using the Razorpay API
- Stores plan IDs in SSM Parameter Store at:
  - `/tradeflow/{stage}/razorpay/plan/monthly`
  - `/tradeflow/{stage}/razorpay/plan/yearly`

### 3. Plan Retrieval
The `GetSubscriptionPlansFunction` retrieves available plans from SSM and returns them via:
```
GET /v1/subscriptions/plans
```

## API Endpoints

### Get Available Plans
```bash
GET https://{api-url}/v1/subscriptions/plans
```

**Response:**
```json
{
  "data": {
    "plans": [
      {
        "planId": "plan_xxxxxxxxxxxxx",
        "name": "TradeFlow Basic Monthly",
        "amount": 99,
        "currency": "INR",
        "period": "monthly",
        "tier": "basic",
        "interval": 1,
        "description": "Basic monthly plan with essential trading journal features"
      },
      {
        "planId": "plan_yyyyyyyyyyyyy",
        "name": "TradeFlow Pro Monthly",
        "amount": 299,
        "currency": "INR",
        "period": "monthly",
        "tier": "pro",
        "interval": 1,
        "description": "Pro monthly plan with advanced features and analytics"
      },
      {
        "planId": "plan_zzzzzzzzzzzzz",
        "name": "TradeFlow Premium Monthly",
        "amount": 499,
        "currency": "INR",
        "period": "monthly",
        "tier": "premium",
        "interval": 1,
        "description": "Premium monthly plan with all features and priority support"
      },
      {
        "planId": "plan_aaaaaaaaaaaaa",
        "name": "TradeFlow Basic Yearly",
        "amount": 999,
        "currency": "INR",
        "period": "yearly",
        "tier": "basic",
        "interval": 1,
        "description": "Basic yearly plan with essential trading journal features",
        "savings": "16%",
        "monthlyEquivalent": 99
      },
      {
        "planId": "plan_bbbbbbbbbbbbb",
        "name": "TradeFlow Pro Yearly",
        "amount": 2999,
        "currency": "INR",
        "period": "yearly",
        "tier": "pro",
        "interval": 1,
        "description": "Pro yearly plan with advanced features and analytics",
        "savings": "16%",
        "monthlyEquivalent": 299
      },
      {
        "planId": "plan_ccccccccccccc",
        "name": "TradeFlow Premium Yearly",
        "amount": 4999,
        "currency": "INR",
        "period": "yearly",
        "tier": "premium",
const DEFAULT_PLANS = [
  // Monthly Plans
  {
    name: 'TradeFlow Supporter Monthly',
    amount: 99, // in rupees
    currency: 'INR',
    period: 'monthly' as const,
    interval: 1,
    description: 'Monthly subscription - All features included. Support the developer!',
  },
  {
    name: 'TradeFlow Enthusiast Monthly',
    amount: 299, // in rupees
    currency: 'INR',
    period: 'monthly' as const,
    interval: 1,
    description: 'Monthly subscription - All features included. Extra support for continued development!',
  },
  // Add more plans...
];`

### Create Subscription
```bash
POST https://{api-url}/v1/subscriptions
Authorization: Bearer {token}
Content-Type: application/json

{
  "planId": "plan_xxxxxxxxxxxxx",
  "quantity": 1,
  "customerNotify": 1
}
```

## Deployment

### First Time Deployment
```bash
sam build
sam deploy --guided
```

During deployment:
1. The stack creates all resources
2. The Custom Resource triggers `InitSubscriptionPlansFunction`
3. Plans are created in Razorpay
4. Plan IDs are stored in SSM Parameter Store

### Subsequent Deployments
On updates, the Custom Resource can optionally recreate plans or skip if they already exist.

## Customizing Plans

To modify default plans, edit `src/handlers/init-subscription-plans/app.ts`:

```typescript
const DEFAULT_PLANS = [
  {
    name: 'TradeFlow Pro Monthly',
    amount: 99, // in rupees
    currency: 'INR',
    period: 'monthly' as const,
### View Plan IDs
```bash
# Monthly plans
aws ssm get-parameter --name "/tradeflow/dev/razorpay/plan/monthly-99"
aws ssm get-parameter --name "/tradeflow/dev/razorpay/plan/monthly-299"
aws ssm get-parameter --name "/tradeflow/dev/razorpay/plan/monthly-499"

# Yearly plans
aws ssm get-parameter --name "/tradeflow/dev/razorpay/plan/yearly-999"
aws ssm get-parameter --name "/tradeflow/dev/razorpay/plan/yearly-2999"
aws ssm get-parameter --name "/tradeflow/dev/razorpay/plan/yearly-4999"
```Troubleshooting

### View Plan IDs
```bash
# Monthly plan
aws ssm get-parameter --name "/tradeflow/dev/razorpay/plan/monthly"

# Yearly plan
aws ssm get-parameter --name "/tradeflow/dev/razorpay/plan/yearly"
```

### CloudWatch Logs
Check logs for plan initialization:
```bash
aws logs tail /aws/lambda/{stack-name}-InitSubscriptionPlansFunction --follow
```

### Manual Plan Creation
If automatic initialization fails, you can manually create plans:
```bash
POST https://{api-url}/v1/subscriptions/plans
Content-Type: application/json

{
  "name": "TradeFlow Pro Monthly",
  "amount": 499,
  "period": "monthly",
  "currency": "INR",
  "description": "Monthly subscription"
}
```

## Architecture

```
Deployment
    ↓
CloudFormation Stack
    ↓
Custom Resource: SubscriptionPlansInitializer
    ↓
Lambda: InitSubscriptionPlansFunction
    ↓
    ├── Create Plans in Razorpay
    └── Store Plan IDs in SSM Parameter Store
    
Frontend
    ↓
GET /v1/subscriptions/plans
    ↓
Lambda: GetSubscriptionPlansFunction
    ↓
Read Plan IDs from SSM
    ↓
Return Available Plans
```

## Security

- Plan IDs are stored in SSM Parameter Store (not encrypted by default)
- Razorpay credentials are passed as CloudFormation parameters
- The GET plans endpoint is public (no authentication required)
- Creating subscriptions requires authentication

## Notes

- Plans are NOT deleted from Razorpay when the stack is deleted
- Plan IDs remain in SSM unless manually removed
- Each stage (dev, prod) has separate plans in SSM
- Plans can be shared across multiple environments by reusing plan IDs
