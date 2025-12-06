# Razorpay Subscriptions - Quick Start & Deployment Guide

## Prerequisites

- Razorpay account (test or live mode)
- AWS account with SAM CLI installed
- Node.js 20.x
- Backend and Frontend repositories

## Step 1: Create Subscription Plans

Before customers can subscribe, you need to create plans. Plans define the billing cycle and amount.

### Option A: Via Razorpay Dashboard

1. Login to [Razorpay Dashboard](https://dashboard.razorpay.com)
2. Go to **Products** → **Subscriptions** → **Plans**
3. Click **Create Plan**
4. Fill in details:
   - **Plan Name**: `Monthly $5 Support`
   - **Amount**: `500` (in paise, so 500 = $5)
   - **Currency**: `INR`
   - **Billing Interval**: `1 month`
5. Save and note the `plan_id`

### Option B: Via API (Recommended)

Once your backend is deployed, create plans programmatically:

```bash
# Monthly ₹99
curl -X POST https://your-api-url.com/v1/subscriptions/plans \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "name": "Monthly ₹99 Support",
    "amount": 99,
    "period": "monthly",
    "interval": 1,
    "description": "Basic monthly support"
  }'

# Monthly ₹299
curl -X POST https://your-api-url.com/v1/subscriptions/plans \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "name": "Monthly ₹299 Support",
    "amount": 299,
    "period": "monthly",
    "interval": 1,
    "description": "Supporter monthly plan"
  }'

# Monthly ₹499
curl -X POST https://your-api-url.com/v1/subscriptions/plans \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "name": "Monthly ₹499 Support",
    "amount": 499,
    "period": "monthly",
    "interval": 1,
    "description": "Champion monthly support"
  }'

# Annual ₹999
curl -X POST https://your-api-url.com/v1/subscriptions/plans \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "name": "Annual ₹999 Support",
    "amount": 999,
    "period": "yearly",
    "interval": 1,
    "description": "Basic annual support"
  }'

# Annual ₹2999
curl -X POST https://your-api-url.com/v1/subscriptions/plans \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "name": "Annual ₹2999 Support",
    "amount": 2999,
    "period": "yearly",
    "interval": 1,
    "description": "Supporter annual plan"
  }'

# Annual ₹4999
curl -X POST https://your-api-url.com/v1/subscriptions/plans \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "name": "Annual ₹4999 Support",
    "amount": 4999,
    "period": "yearly",
    "interval": 1,
    "description": "Champion annual support"
  }'
```

**Save all returned `planId` values** - you'll need them for the frontend.

**Expected Plan IDs to configure:**
- `monthly_99`, `monthly_299`, `monthly_499`
- `annual_999`, `annual_2999`, `annual_4999`

## Step 2: Configure Razorpay Webhook

1. Login to [Razorpay Dashboard](https://dashboard.razorpay.com)
2. Go to **Settings** → **Webhooks**
3. Click **+ Add New Webhook**
4. Enter:
   - **Webhook URL**: `https://your-api-url.com/v1/payments/webhook`
   - **Alert Email**: Your email
5. Select **Active Events**:
   - ✅ `subscription.activated`
   - ✅ `subscription.charged`
   - ✅ `subscription.pending`
   - ✅ `subscription.halted`
   - ✅ `subscription.cancelled`
   - ✅ `subscription.completed`
6. Click **Create Webhook**
7. **IMPORTANT**: Copy the **Webhook Secret** (you'll need it for deployment)

## Step 3: Backend Deployment

### 3.1 Install Dependencies

```bash
cd Backend
npm install
```

This will install the `razorpay@^2.9.2` package and all other dependencies.

### 3.2 Set Environment Variables

Create or update `Backend/.env` for local testing:

```bash
RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxxxx
RAZORPAY_KEY_SECRET=your_secret_key_here
RAZORPAY_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxxx

AWS_REGION=us-east-1
TRADES_TABLE=trading-journal-trades-dev
SUBSCRIPTIONS_TABLE=trading-journal-subscriptions-dev
# ... other tables
```

### 3.3 Build and Deploy

```bash
cd Backend

# Build the SAM application
sam build

# Deploy with parameters
sam deploy \
  --parameter-overrides \
    RazorpayKeyId="rzp_test_xxxxxxxxxxxxxx" \
    RazorpayKeySecret="your_secret_key_here" \
    RazorpayWebhookSecret="whsec_xxxxxxxxxxxxxx" \
  --guided
```

**SAM Deploy Prompts:**
- Stack Name: `trading-journal-backend-dev`
- AWS Region: `us-east-1`
- Confirm changes: `Y`
- Allow SAM CLI IAM role creation: `Y`
- Save arguments to config file: `Y`

**Output:**
Note the `ApiBaseUrl` from the outputs - you'll need it for the frontend.

### 3.4 Verify Deployment

```bash
# Check Lambda functions
aws lambda list-functions --query 'Functions[?contains(FunctionName, `Razorpay`)].FunctionName'

# Expected output:
[
  "CreateOrderRazorpayFunction",
  "CreateSubscriptionPlanRazorpayFunction",
  "CreateRazorpaySubscriptionFunction",
  "ManageRazorpaySubscriptionFunction",
  "VerifyPaymentRazorpayFunction",
  "RazorpayWebhookFunction"
]
```

## Step 4: Frontend Configuration

### 4.1 Update Environment Variables

Edit `Frontend/.env`:

```bash
VITE_API_URL=https://xxxxxxxxxx.execute-api.us-east-1.amazonaws.com/prod/v1
VITE_RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxxxx
```

### 4.2 Update Plan IDs in ProfileView

Edit `Frontend/src/components/views/ProfileView.tsx`:

Find the `PLAN_IDS` constant and replace with your actual plan IDs:

```typescript
const PLAN_IDS = {
  monthly_99: 'plan_xxxxxx',    // Replace with actual plan ID
  monthly_299: 'plan_xxxxxx',   // Replace with actual plan ID
  monthly_499: 'plan_xxxxxx',   // Replace with actual plan ID
  annual_999: 'plan_xxxxxx',    // Replace with actual plan ID
  annual_2999: 'plan_xxxxxx',   // Replace with actual plan ID
  annual_4999: 'plan_xxxxxx',   // Replace with actual plan ID
};
```

### 4.3 Install and Build

```bash
cd Frontend
npm install
npm run build
```

### 4.4 Deploy Frontend

Deploy the `dist` folder to your hosting provider (Vercel, Netlify, S3, etc.).

## Step 5: Testing

### 5.1 Test Subscription Creation

1. Open your application in a browser
2. Navigate to Profile page
3. Click on a subscription amount
4. Razorpay Checkout should open
5. Use test card:
   - **Card Number**: `4111 1111 1111 1111`
   - **CVV**: `123`
   - **Expiry**: Any future date
   - **Name**: Any name
6. Click "Pay"
7. You should see success message

### 5.2 Verify in DynamoDB

```bash
aws dynamodb get-item \
  --table-name trading-journal-subscriptions-dev \
  --key '{"userId": {"S": "YOUR_USER_ID"}}'
```

Expected:
```json
{
  "Item": {
    "userId": {"S": "user-123"},
    "subscriptionId": {"S": "sub_xxxxxx"},
    "status": {"S": "active"},
    "paidCount": {"N": "1"},
    ...
  }
}
```

### 5.3 Check Webhook Logs

```bash
aws logs tail /aws/lambda/RazorpayWebhookFunction --follow
```

You should see:
```
Processing webhook event: subscription.activated
Subscription activated: { userId: 'xxx', subscriptionId: 'sub_xxx' }
```

### 5.4 Test Webhook Manually

```bash
# Get your webhook secret
WEBHOOK_SECRET="whsec_xxxxxxxxxxxxxx"

# Create test payload
PAYLOAD='{"event":"subscription.charged","payload":{"subscription":{"entity":{"id":"sub_test","status":"active","paid_count":2}}}}'

# Generate signature
SIGNATURE=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | cut -d ' ' -f2)

# Send webhook
curl -X POST https://your-api-url.com/v1/payments/webhook \
  -H "Content-Type: application/json" \
  -H "x-razorpay-signature: $SIGNATURE" \
  -d "$PAYLOAD"
```

### 5.5 Test Subscription Management

**Pause:**
1. Click "Pause Subscription" in Profile
2. Check DynamoDB: status should be `paused`
3. Verify in Razorpay Dashboard

**Resume:**
1. Click "Resume Subscription"
2. Check DynamoDB: status should be `active`

**Cancel:**
1. Click "Cancel at End of Cycle"
2. Check DynamoDB: status should be `cancelling` or `cancelled`

## Step 6: Monitor Recurring Payments

### 6.1 CloudWatch Logs

Monitor webhook execution:

```bash
# Webhook logs
aws logs tail /aws/lambda/RazorpayWebhookFunction --follow

# Subscription management logs
aws logs tail /aws/lambda/ManageRazorpaySubscriptionFunction --follow
```

### 6.2 Razorpay Dashboard

1. Go to **Subscriptions** tab
2. See all active subscriptions
3. View payment history
4. Check upcoming charges

### 6.3 Set Up CloudWatch Alarms

```bash
# Create alarm for webhook failures
aws cloudwatch put-metric-alarm \
  --alarm-name razorpay-webhook-errors \
  --alarm-description "Alert when webhook fails" \
  --metric-name Errors \
  --namespace AWS/Lambda \
  --statistic Sum \
  --period 300 \
  --threshold 5 \
  --comparison-operator GreaterThanThreshold \
  --evaluation-periods 1 \
  --dimensions Name=FunctionName,Value=RazorpayWebhookFunction
```

## Step 7: Going Live (Production)

### 7.1 Switch to Live Mode

1. Get live API keys from Razorpay Dashboard
   - Go to **Settings** → **API Keys**
   - Generate **Live Mode** keys
2. Update Backend env vars with live keys:
   - `RAZORPAY_KEY_ID=rzp_live_xxxxxx`
   - `RAZORPAY_KEY_SECRET=live_secret_xxx`
3. Update Frontend env var:
   - `VITE_RAZORPAY_KEY_ID=rzp_live_xxxxxx`
4. Update webhook URL in Razorpay Dashboard to production URL
5. Redeploy backend and frontend

### 7.2 Create Production Plans

Recreate all plans in **Live Mode** via API (they don't copy from test mode):

```bash
# Use production API URL and live keys
curl -X POST https://api.yourapp.com/v1/subscriptions/plans \
  -H "Authorization: Bearer PROD_TOKEN" \
  -d '{"name": "Monthly $5", "amount": 5, "period": "monthly", "interval": 1}'
```

### 7.3 Update Frontend Plan IDs

Replace `PLAN_IDS` in ProfileView with live plan IDs (for ₹99, ₹299, ₹499 monthly and ₹999, ₹2999, ₹4999 annual).

### 7.4 Final Verification

1. Make a small real subscription (₹99)
2. Verify charge appears in Razorpay Dashboard
3. Check DynamoDB for subscription record
4. Verify webhook logs show `subscription.activated`
5. Wait for next billing cycle (or trigger manual charge in dashboard)
6. Verify `subscription.charged` webhook fires
7. Confirm paidCount increments

## Troubleshooting

### Issue: Webhook not firing

**Check:**
1. Webhook URL is correct and publicly accessible
2. Lambda function has correct environment variables
3. API Gateway has `/v1/payments/webhook` route configured
4. Check Razorpay Dashboard → Webhooks → View logs

**Solution:**
```bash
# Test webhook endpoint directly
curl https://your-api.com/v1/payments/webhook

# Should return 400 (missing signature) not 404
```

### Issue: Signature verification failing

**Check:**
1. `RAZORPAY_WEBHOOK_SECRET` matches Dashboard
2. Secret includes `whsec_` prefix
3. No extra spaces or newlines in secret

**Solution:**
```bash
# Verify secret in Lambda
aws lambda get-function-configuration \
  --function-name RazorpayWebhookFunction \
  --query 'Environment.Variables.RAZORPAY_WEBHOOK_SECRET'
```

### Issue: Subscription not activating

**Check:**
1. Authentication transaction completed
2. Check Razorpay Dashboard → Subscriptions → Click subscription → View events
3. Look for `subscription.activated` event
4. Check CloudWatch logs for errors

**Solution:**
- Manually trigger webhook from Razorpay Dashboard
- Verify userId is correctly saved in subscription notes

### Issue: Recurring charge not happening

**Check:**
1. Subscription status is `active` in DynamoDB
2. Check Razorpay Dashboard for scheduled charge date
3. Verify customer payment method is still valid

**Solution:**
- Check Razorpay Dashboard → Subscriptions → View upcoming charges
- If card expired, customer needs to update payment method

## Cost Estimate

**Razorpay:**
- Standard rate: 2% + ₹0 per transaction
- Example: ₹499 subscription = ₹9.98 fee
- Webhooks: Free

**AWS:**
- Lambda: ~$0.20/1M requests (first 1M free)
- DynamoDB: ~$1.25/million writes
- API Gateway: ~$1/million requests

**Total Monthly Cost (1000 subscribers at ₹499):**
- Razorpay fees: ~₹9,980 (2% of ₹4,99,000 revenue)
- AWS: < $5 (~₹415)

## Support

- **Razorpay Docs**: https://razorpay.com/docs/payments/subscriptions/
- **Razorpay Support**: support@razorpay.com
- **AWS SAM Docs**: https://docs.aws.amazon.com/serverless-application-model/

## Next Steps

- [ ] Set up email notifications for subscription events
- [ ] Add payment history page for customers
- [ ] Implement proration for plan changes
- [ ] Add grace period for failed payments
- [ ] Create admin dashboard for subscription analytics
- [ ] Set up monitoring and alerts
- [ ] Document customer support procedures
- [ ] Create FAQ for subscription management

---

**Congratulations!** 🎉 Your Razorpay Subscriptions integration is complete!

Customers can now subscribe and Razorpay will automatically handle recurring billing. Your backend stays in sync via webhooks, and customers can manage their subscriptions through the Profile page.
