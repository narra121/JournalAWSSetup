# Razorpay Subscriptions - Automatic Recurring Payments

## Overview

Razorpay Subscriptions has been fully integrated into TradeFlow, replacing one-time payments with **automatic recurring billing**. Once a customer subscribes, Razorpay automatically deducts payments on their billing cycle, and webhooks notify your backend in real-time to update the database.

## Key Benefits

✅ **Automatic Charging**: Razorpay automatically debits customer accounts each billing cycle  
✅ **Smart Retries**: Failed payments are automatically retried using Razorpay's intelligent retry schedule  
✅ **Real-time Updates**: Webhooks update your database immediately when payments succeed/fail  
✅ **Subscription Management**: Customers can pause, resume, or cancel subscriptions  
✅ **No Manual Intervention**: Backend handles everything automatically via webhooks  

## Architecture

### Flow Diagram

```
┌────────────────────────────────────────────────────────────────┐
│                     SUBSCRIPTION CREATION                       │
└────────────────────────────────────────────────────────────────┘
                              │
  User clicks "Subscribe" ────┤
                              │
                              ▼
       ┌─────────────────────────────────────┐
       │  Frontend: initiateSubscription()   │
       │  - POST /subscriptions              │
       │  - Include planId                   │
       └──────────────┬──────────────────────┘
                      │
                      ▼
       ┌─────────────────────────────────────┐
       │  Backend: CreateRazorpaySubscription│
       │  - Call Razorpay API                │
       │  - Create subscription              │
       │  - Save to DynamoDB                 │
       │  - Return subscriptionId            │
       └──────────────┬──────────────────────┘
                      │
                      ▼
       ┌─────────────────────────────────────┐
       │  Razorpay Checkout Opens            │
       │  - Customer authorizes payment      │
       │  - Authentication transaction       │
       └──────────────┬──────────────────────┘
                      │
                      ▼
       ┌─────────────────────────────────────┐
       │  Webhook: subscription.activated    │
       │  - Update DynamoDB status='active'  │
       │  - Set currentStart, currentEnd     │
       └─────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│                     RECURRING PAYMENTS                          │
└────────────────────────────────────────────────────────────────┘
                              │
  Billing cycle triggers ─────┤
                              │
                              ▼
       ┌─────────────────────────────────────┐
       │  Razorpay Auto-Deducts Payment      │
       │  - No user action required          │
       │  - Automatic charge                 │
       └──────────────┬──────────────────────┘
                      │
          ┌───────────┴───────────┐
          │                       │
    SUCCESS                   FAILURE
          │                       │
          ▼                       ▼
┌──────────────────┐    ┌──────────────────┐
│ Webhook:         │    │ Webhook:         │
│ subscription.    │    │ subscription.    │
│ charged          │    │ pending          │
│                  │    │                  │
│ Update DB:       │    │ Update DB:       │
│ - paidCount++    │    │ - status=pending │
│ - Extend access  │    │                  │
│ - Update dates   │    │ Razorpay retries │
└──────────────────┘    │ automatically    │
                        └─────────┬────────┘
                                  │
                    ┌─────────────┴─────────────┐
                    │                           │
              Still Fails              Eventually Success
                    │                           │
                    ▼                           ▼
          ┌──────────────────┐        ┌──────────────────┐
          │ Webhook:         │        │ Webhook:         │
          │ subscription.    │        │ subscription.    │
          │ halted           │        │ charged          │
          │                  │        │                  │
          │ Suspend service  │        │ Reactivate       │
          └──────────────────┘        └──────────────────┘
```

## Implementation Details

### Backend Components

#### 1. Lambda: Create Subscription Plan
**File**: `Backend/src/handlers/create-subscription-plan-razorpay/app.ts`  
**Endpoint**: `POST /v1/subscriptions/plans`  
**Purpose**: Create subscription plans with defined billing cycles

**Request:**
```json
{
  "name": "Monthly Support",
  "amount": 5,
  "period": "monthly",
  "interval": 1,
  "currency": "INR"
}
```

**Response:**
```json
{
  "planId": "plan_xxxxx",
  "period": "monthly",
  "interval": 1,
  "amount": 5,
  "currency": "INR",
  "name": "Monthly Support"
}
```

#### 2. Lambda: Create Subscription
**File**: `Backend/src/handlers/create-razorpay-subscription/app.ts`  
**Endpoint**: `POST /v1/subscriptions`  
**Purpose**: Create a subscription for a customer

**Request:**
```json
{
  "planId": "plan_xxxxx",
  "totalCount": 12,
  "quantity": 1
}
```

**Response:**
```json
{
  "subscriptionId": "sub_xxxxx",
  "planId": "plan_xxxxx",
  "status": "created",
  "shortUrl": "https://rzp.io/...",
  "authAttempts": 0
}
```

**What Happens:**
1. Creates subscription in Razorpay
2. Saves initial record to DynamoDB
3. Returns payment link for authentication transaction
4. User completes authentication via Razorpay Checkout
5. Webhook `subscription.activated` updates status to active

#### 3. Lambda: Webhook Handler (Enhanced)
**File**: `Backend/src/handlers/razorpay-webhook/app.ts`  
**Endpoint**: `POST /v1/payments/webhook`  
**Purpose**: Handle all subscription lifecycle events

**Webhook Events Handled:**

| Event | Description | Action |
|-------|-------------|--------|
| `subscription.activated` | First payment successful | Set status='active', save billing dates |
| `subscription.charged` | Recurring payment succeeded | Increment paidCount, extend access period |
| `subscription.pending` | Payment failed, retrying | Set status='pending' |
| `subscription.halted` | All retries failed | Set status='halted', suspend service |
| `subscription.cancelled` | User cancelled subscription | Set status='cancelled', log end date |
| `subscription.completed` | All billing cycles done | Set status='completed' |

**Webhook Security:**
- Verifies HMAC SHA256 signature
- Rejects requests with invalid signatures
- Prevents replay attacks

**Example Webhook Payload:**
```json
{
  "event": "subscription.charged",
  "payload": {
    "subscription": {
      "entity": {
        "id": "sub_xxxxx",
        "plan_id": "plan_xxxxx",
        "status": "active",
        "paid_count": 3,
        "remaining_count": 9,
        "current_start": 1701878400,
        "current_end": 1704556800,
        "charge_at": 1704556800,
        "notes": {
          "userId": "user-123"
        }
      }
    }
  }
}
```

#### 4. Lambda: Manage Subscription
**File**: `Backend/src/handlers/manage-razorpay-subscription/app.ts`  
**Endpoints**: 
- `GET /v1/subscriptions` - Fetch subscription details
- `PUT /v1/subscriptions` - Pause/Resume subscription
- `DELETE /v1/subscriptions` - Cancel subscription

**Pause Example:**
```json
POST /v1/subscriptions
{
  "action": "pause",
  "pauseAt": "now"
}
```

**Cancel Example:**
```json
DELETE /v1/subscriptions
{
  "cancelAtCycleEnd": true
}
```

### Frontend Components

#### 1. API Client
**File**: `Frontend/src/lib/api/razorpay.ts`

**Key Functions:**
- `createPlan()` - Create subscription plan
- `createSubscription()` - Start new subscription
- `getSubscription()` - Fetch current subscription
- `pauseSubscription()` - Pause recurring billing
- `resumeSubscription()` - Resume recurring billing
- `cancelSubscription()` - Cancel subscription

#### 2. React Hook
**File**: `Frontend/src/hooks/useRazorpay.ts`

**Key Function:**
```typescript
const { initiateSubscription, loading, error } = useRazorpay();

await initiateSubscription({
  planId: 'plan_xxxxx',
  name: 'TradeFlow Subscription',
  description: 'Monthly subscription - $5',
  onSuccess: (subscriptionId) => {
    // Subscription created successfully
  },
  onFailure: (error) => {
    // Handle error
  },
});
```

#### 3. ProfileView Component
**File**: `Frontend/src/components/views/ProfileView.tsx`

**Features:**
- Display current subscription status
- Show next billing date
- Display paid/remaining cycles
- Pause/Resume buttons
- Cancel subscription options
- Real-time status updates

**UI States:**
- **Active**: Green badge, pause/cancel buttons visible
- **Paused**: Yellow badge, resume button visible
- **Halted**: Red badge, payment failed message
- **No Subscription**: Prompt to choose a plan

## Subscription Lifecycle

### 1. Creation Phase
```
User → Select Plan → Frontend creates subscription → 
Backend calls Razorpay → Returns subscriptionId → 
Open Razorpay Checkout → User authorizes → 
Webhook (subscription.activated) → Status='active'
```

### 2. Active Phase (Recurring)
```
Billing date arrives → Razorpay auto-charges → 
Webhook (subscription.charged) → Update paidCount → 
Extend access → User continues using service
```

### 3. Payment Failure
```
Auto-charge fails → Webhook (subscription.pending) → 
Razorpay retries (smart schedule) → 
Eventually succeeds OR halts → 
Webhook updates status accordingly
```

### 4. Cancellation
```
User requests cancel → Backend calls Razorpay API → 
Webhook (subscription.cancelled) → 
Stop future charges → Service ends at cycle end
```

## Environment Variables

### Backend (Lambda)
```bash
RAZORPAY_KEY_ID=rzp_live_xxxxx
RAZORPAY_KEY_SECRET=secret_xxxxx
RAZORPAY_WEBHOOK_SECRET=webhook_secret_xxxxx
SUBSCRIPTIONS_TABLE=trading-journal-subscriptions-prod
```

### Frontend (React)
```bash
VITE_API_URL=https://api.tradeflow.com
VITE_RAZORPAY_KEY_ID=rzp_live_xxxxx
```

## Database Schema (DynamoDB)

**Table**: `SubscriptionsTable`  
**Partition Key**: `userId`

**Attributes:**
```typescript
{
  userId: string;              // Partition key
  subscriptionId: string;      // Razorpay subscription ID
  planId: string;              // Razorpay plan ID
  status: string;              // active|paused|halted|cancelled|completed
  paidCount: number;           // Number of successful charges
  remainingCount?: number;     // Remaining billing cycles
  totalCount?: number;         // Total billing cycles (null = unlimited)
  currentStart?: string;       // Current period start (ISO 8601)
  currentEnd?: string;         // Current period end (ISO 8601)
  chargeAt?: string;           // Next charge date (ISO 8601)
  endedAt?: string;            // Cancellation/completion date
  createdAt: string;           // Subscription creation date
  updatedAt: string;           // Last update timestamp
}
```

## Testing Guide

### 1. Create Subscription Plans (One-time Setup)

```bash
curl -X POST https://api.tradeflow.com/v1/subscriptions/plans \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{
    "name": "Monthly $5 Support",
    "amount": 5,
    "period": "monthly",
    "interval": 1
  }'
```

**Create plans for:**
- Monthly: $1, $5, $10
- Annual: $12, $60, $120

**Save the returned `planId` values** - you'll need them in the frontend.

### 2. Test Subscription Flow

1. **Frontend**: Click "Subscribe" button with desired amount
2. **Razorpay Modal Opens**: Use test card `4111 1111 1111 1111`
3. **Check DynamoDB**: Verify subscription created with status='active'
4. **Check Logs**: CloudWatch should show webhook `subscription.activated`

### 3. Test Recurring Payments

**Option A**: Wait for actual billing cycle  
**Option B**: Use Razorpay Dashboard to trigger test charge

1. Go to Razorpay Dashboard → Subscriptions
2. Find your test subscription
3. Click "Charge Now" (test mode only)
4. Verify webhook `subscription.charged` fires
5. Check DynamoDB: `paidCount` should increment

### 4. Test Payment Failure

1. **Razorpay Dashboard**: Simulate failed payment
2. Webhook `subscription.pending` should fire
3. DynamoDB status changes to `pending`
4. Razorpay automatically retries
5. After retries exhausted: webhook `subscription.halted`

### 5. Test Management Actions

**Pause:**
```bash
curl -X PUT https://api.tradeflow.com/v1/subscriptions \
  -H "Authorization: Bearer <token>" \
  -d '{"action": "pause", "pauseAt": "now"}'
```

**Resume:**
```bash
curl -X PUT https://api.tradeflow.com/v1/subscriptions \
  -H "Authorization: Bearer <token>" \
  -d '{"action": "resume", "resumeAt": "now"}'
```

**Cancel:**
```bash
curl -X DELETE https://api.tradeflow.com/v1/subscriptions \
  -H "Authorization: Bearer <token>" \
  -d '{"cancelAtCycleEnd": true}'
```

## Razorpay Dashboard Configuration

### 1. Create Webhook

1. Login to [Razorpay Dashboard](https://dashboard.razorpay.com)
2. Go to **Settings** → **Webhooks**
3. Click **+ Add New Webhook**
4. Enter your webhook URL: `https://api.tradeflow.com/v1/payments/webhook`
5. Select events:
   - ✅ subscription.activated
   - ✅ subscription.charged
   - ✅ subscription.pending
   - ✅ subscription.halted
   - ✅ subscription.cancelled
   - ✅ subscription.completed
6. Save the **Webhook Secret** (you'll need it for env vars)

### 2. Enable Subscriptions

1. Go to **Products** → **Subscriptions**
2. Click **Enable**
3. Configure retry settings:
   - **Retry Attempts**: 4
   - **Retry Schedule**: Smart retry (recommended)

### 3. Test Mode vs Live Mode

**Test Mode:**
- Use `rzp_test_` keys
- Test card: `4111 1111 1111 1111`
- CVV: Any 3 digits
- Expiry: Any future date
- No real charges

**Live Mode:**
- Use `rzp_live_` keys
- Real payment methods
- Actual charges to customers
- PCI compliance required

## Deployment Checklist

- [ ] Create subscription plans via API (save planIds)
- [ ] Update frontend PLAN_IDS constant with actual planIds
- [ ] Configure webhook in Razorpay Dashboard
- [ ] Set environment variables (RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET)
- [ ] Deploy backend with `sam build && sam deploy`
- [ ] Deploy frontend with updated env vars
- [ ] Test subscription creation end-to-end
- [ ] Test webhook delivery (check CloudWatch logs)
- [ ] Test payment failure scenario
- [ ] Test pause/resume/cancel actions
- [ ] Monitor first real recurring charge
- [ ] Set up CloudWatch alarms for webhook failures

## Monitoring & Troubleshooting

### CloudWatch Logs

**Lambda Function Logs:**
- `/aws/lambda/CreateRazorpaySubscriptionFunction`
- `/aws/lambda/ManageRazorpaySubscriptionFunction`
- `/aws/lambda/RazorpayWebhookFunction`

**What to Monitor:**
- Webhook signature verification failures
- Subscription creation errors
- DynamoDB update failures
- Razorpay API errors

### Razorpay Dashboard

**Subscriptions Tab:**
- View all active subscriptions
- Check payment history
- See failed charges
- Monitor retry attempts

**Webhooks Tab:**
- View webhook delivery status
- Retry failed webhooks
- Check payload/response

### Common Issues

**Issue**: Webhook not firing  
**Solution**: Check webhook URL, verify it's publicly accessible, check firewall rules

**Issue**: Signature verification failing  
**Solution**: Verify RAZORPAY_WEBHOOK_SECRET matches Razorpay Dashboard

**Issue**: Subscription not activating  
**Solution**: Check authentication transaction succeeded, verify webhook received

**Issue**: Auto-charge failing  
**Solution**: Check customer payment method, verify card not expired, check Razorpay retry settings

## Cost Considerations

**Razorpay Pricing:**
- **Standard**: 2% + ₹0 per transaction
- **Subscriptions**: No additional fee beyond standard rates
- **Webhooks**: Free
- **Retries**: Free (included)

**AWS Lambda Costs:**
- ~$0.0000002 per request (first 1M requests free)
- Negligible for webhook handling

**DynamoDB Costs:**
- Pay per request or provisioned capacity
- Very low for subscription management

## Production Best Practices

1. **Always verify webhook signatures** - Prevents fraudulent requests
2. **Log all webhook events** - Essential for debugging and auditing
3. **Handle idempotency** - Webhooks may be delivered multiple times
4. **Monitor failed payments** - Send email notifications to users
5. **Set up alerts** - CloudWatch alarms for webhook failures
6. **Test retry logic** - Ensure halted subscriptions suspend service
7. **Graceful degradation** - If webhook fails, allow manual sync
8. **Keep Razorpay SDK updated** - Security patches and new features
9. **Use exponential backoff** - If Razorpay API calls fail
10. **Document plan IDs** - Keep a registry of all created plans

## Support & Resources

- **Razorpay Subscriptions Docs**: https://razorpay.com/docs/payments/subscriptions/
- **Webhook Documentation**: https://razorpay.com/docs/webhooks/
- **Razorpay Support**: https://razorpay.com/support/
- **API Reference**: https://razorpay.com/docs/api/subscriptions/

## Summary

✅ **Fully Automated**: Razorpay handles charging, retries, and notifications  
✅ **Real-time Updates**: Webhooks keep your database in sync instantly  
✅ **Customer-Friendly**: Easy subscription management (pause/resume/cancel)  
✅ **Reliable**: Smart retries minimize failed payments  
✅ **Secure**: Signature verification prevents fraud  
✅ **Scalable**: Handle unlimited subscriptions with Lambda + DynamoDB  

---

**Status**: ✅ Implementation Complete  
**Integration Type**: Razorpay Subscriptions (Recurring Billing)  
**Auto-Deduction**: Yes - Razorpay manages the schedule  
**Webhook-Driven**: Yes - Backend updates via webhooks  
**Customer Control**: Pause, Resume, Cancel anytime  
