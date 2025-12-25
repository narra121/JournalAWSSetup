# Razorpay Subscription Flow Refactor: Checkout → Payment Link (Hosted) Model

## Objective

Refactor the existing Razorpay Checkout-based subscription flow to a Payment Link–based subscription flow, where:

- Subscriptions are created only on the backend
- Razorpay generates a hosted payment link (`short_url`)
- The frontend opens the link in a new window/tab
- No Razorpay Checkout SDK is loaded on the frontend
- Webhooks remain the single source of truth

This change removes:
- Domain/app validation issues
- Razorpay Checkout dependency
- Frontend payment verification logic

## 1. High-Level Change Description

### Current State (Before)
1. Frontend loads `window.Razorpay`
2. Subscription is created in backend
3. Frontend opens Razorpay Checkout modal using `subscription_id`
4. Frontend waits for success handler
5. Webhook updates DB asynchronously

### Target State (After)
1. Backend creates Razorpay subscription with metadata
2. Backend receives `short_url` from Razorpay
3. Backend returns `paymentLink` to frontend
4. Frontend opens `paymentLink` in a new browser window
5. User completes payment on Razorpay-hosted page (`rzp.io`)
6. Webhook updates DB (no frontend verification)

## 2. Detailed Step-by-Step Changes

### A. Frontend Changes

#### 1. Remove Razorpay Checkout Usage
**Files affected:** `Frontend/src/hooks/useRazorpay.ts`
Any component loading `https://checkout.razorpay.com/v1/checkout.js`

**❌ Remove:**
- `window.Razorpay`
- `razorpayInstance.open()`
- `handler` callbacks
- `payment.failed` listeners
- Artificial delays (`setTimeout`) waiting for webhook

#### 2. Update Subscription Initiation Flow
**Current:**
`POST /subscriptions` → returns `subscriptionId` → initialize Razorpay Checkout

**New:**
`POST /subscriptions` → returns `paymentLink` (`short_url`) → open `paymentLink` in new window

**Example frontend logic:**
```javascript
const { paymentLink } = await api.createSubscription(planId);
window.open(paymentLink, "_blank");
```

**Benefits:**
- ✅ No SDK
- ✅ No domain validation
- ✅ Razorpay-hosted UI

#### 3. UI Responsibility Change
**Frontend should:**
- Show “Payment Pending” state
- Poll backend or refresh subscription status
- React to backend-driven status (active, pending, halted)

**Frontend should NOT:**
- Verify payments
- Assume success after redirect
- Enable access immediately

### B. Backend Changes

#### 4. Modify `/subscriptions` API Response
**Handler:** `create-razorpay-subscription`

**Current behavior:**
- Creates Razorpay subscription
- Stores DB record
- Returns `subscriptionId`

**New behavior:**
- Create Razorpay subscription
- Extract `short_url`
- Store subscription metadata
- Return `paymentLink` to frontend

**Razorpay API Call:**
```javascript
razorpay.subscriptions.create({
  plan_id,
  total_count,
  quantity: 1,
  customer_notify: 1,
  notes: {
    userId,
    app: "trading-journal"
  }
});
```

**Response to frontend:**
```json
{
  "subscriptionId": "sub_XXXX",
  "paymentLink": "https://rzp.io/i/XXXX"
}
```

#### 5. Database Changes (Minimal)
No schema change required, but ensure:
- Initial status = `created`
- `subscriptionId` is stored
- `userId` comes only from backend auth
- Never trust frontend identifiers

**Optional (recommended):**
- Add `paymentLinkCreatedAt`
- Add `source = "payment_link"`

### C. Webhook Handling (Core Logic Remains)

#### 6. Webhook Becomes the ONLY Authority
No change to webhook endpoint structure.

**Webhook must:**
- Verify `x-razorpay-signature`
- Extract `subscription.notes.userId`
- Update DynamoDB record accordingly

**Important:**
- Ignore frontend success/failure completely
- Webhook drives all access control

#### 7. Events to Continue Handling
| Event | Purpose |
| :--- | :--- |
| `subscription.activated` | First successful mandate/payment |
| `subscription.charged` | Recurring billing |
| `subscription.pending` | Retry in progress |
| `subscription.halted` | Retries exhausted |
| `subscription.cancelled` | User/admin cancellation |
| `subscription.completed` | All cycles done |

No changes required here — only frontend assumptions change.

### D. One-Time Payment Flow (Optional)
You may:
- Keep existing one-time Checkout flow
- OR later refactor it to Payment Links as well

This change request applies only to subscriptions.

## 3. Final Architecture Summary

### What We Gain
- ✅ No domain/app approval dependency
- ✅ No frontend payment logic
- ✅ No Checkout SDK
- ✅ Cleaner security model
- ✅ Webhook-driven truth

### What We Remove
- ❌ Razorpay Checkout modal
- ❌ Frontend verification
- ❌ Domain validation errors

## 4. Success Criteria
- Frontend opens Razorpay link in new tab
- User completes payment on `rzp.io`
- Webhook activates subscription
- UI reflects status on refresh
- No Razorpay Checkout JS used

## 5. Final Note (Important)
This architecture is:
- Razorpay-approved
- Used by many SaaS products
- Safe for unapproved domains
- Fully compliant with subscription mandates
