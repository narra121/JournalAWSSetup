# Razorpay Integration - Deployment Guide

## Overview
This guide covers deploying the Razorpay payment gateway integration for the Trading Journal application.

## Prerequisites

1. **Razorpay Account**: Sign up at [https://razorpay.com](https://razorpay.com)
2. **Razorpay API Keys**: 
   - Navigate to Settings → API Keys in Razorpay Dashboard
   - Generate Test/Live API keys (Key ID & Key Secret)
3. **Webhook Secret**: 
   - Go to Settings → Webhooks
   - Create a webhook endpoint (will be created after deployment)
   - Save the webhook secret

## Architecture

### Backend (AWS Lambda)
- **CreateOrderRazorpay**: Creates Razorpay orders with amount and currency
- **VerifyPaymentRazorpay**: Verifies payment signature and updates subscription
- **RazorpayWebhook**: Handles async payment events (captured, failed)

### Frontend (React)
- **useRazorpay Hook**: Manages payment flow with Razorpay Checkout
- **ProfileView**: Subscription UI with payment integration
- **API Client**: Axios-based client for backend communication

### Payment Flow
1. User clicks subscription amount → Frontend calls `/payments/create-order`
2. Backend creates Razorpay order → Returns `orderId`
3. Frontend opens Razorpay Checkout modal → User completes payment
4. On success → Frontend calls `/payments/verify` with signature
5. Backend verifies HMAC SHA256 signature → Updates subscription in DynamoDB
6. Webhook handles async events → Updates subscription status

## Deployment Steps

### 1. Install Dependencies

```bash
cd Backend
npm install
```

This will install the `razorpay` package (^2.9.2) added to `package.json`.

### 2. Configure Environment Variables

#### For AWS Deployment

Add parameters to your SAM deployment:

```bash
sam deploy \
  --parameter-overrides \
    RazorpayKeyId="rzp_live_xxxxxxxxxx" \
    RazorpayKeySecret="your_secret_key" \
    RazorpayWebhookSecret="your_webhook_secret"
```

Or use `samconfig.toml`:

```toml
[default.deploy.parameters]
parameter_overrides = [
  "RazorpayKeyId=rzp_test_xxxxxxxxxx",
  "RazorpayKeySecret=your_secret_key",
  "RazorpayWebhookSecret=your_webhook_secret"
]
```

**Security Note**: For production, store secrets in AWS Systems Manager Parameter Store or AWS Secrets Manager instead of direct parameters.

#### For Local Development

Copy `.env.example` to `.env` and fill in values:

```bash
cp .env.example .env
# Edit .env with your Razorpay credentials
```

### 3. Build and Deploy Backend

```bash
cd Backend
sam build
sam deploy --guided  # First time deployment
# OR
sam deploy  # Subsequent deployments
```

This will:
- Create 3 new Lambda functions
- Set up API Gateway endpoints:
  - `POST /v1/payments/create-order`
  - `POST /v1/payments/verify`
  - `POST /v1/payments/webhook`
- Grant DynamoDB permissions to Lambda functions

### 4. Configure Razorpay Webhook

After deployment, get your API Gateway URL from outputs:

```bash
sam deploy --no-confirm-changeset | grep ApiBaseUrl
# Example output: https://xxxxxxxxxx.execute-api.us-east-1.amazonaws.com/prod/v1
```

1. Go to Razorpay Dashboard → Settings → Webhooks
2. Click "Create Webhook"
3. Set URL: `https://your-api-gateway-url/v1/payments/webhook`
4. Select events:
   - `payment.captured`
   - `payment.failed`
5. Copy the webhook secret and update your deployment parameters

### 5. Configure Frontend

Update Frontend `.env`:

```bash
cd ../Frontend
# Create/update .env
echo "VITE_API_URL=https://your-api-gateway-url" > .env
echo "VITE_RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxx" >> .env
```

### 6. Build and Deploy Frontend

```bash
npm install
npm run build
# Deploy to your hosting service (Vercel, Netlify, S3+CloudFront, etc.)
```

## Testing

### Test Mode (Development)

1. Use test API keys from Razorpay Dashboard
2. Test payments with Razorpay test card numbers:
   - Success: `4111 1111 1111 1111`
   - CVV: Any 3 digits
   - Expiry: Any future date

### Production Mode

1. Switch to live API keys in Razorpay Dashboard
2. Update deployment parameters with live keys
3. Verify webhook configuration with live endpoint
4. Test with real payment methods

## Security Considerations

1. **API Keys**: Never commit API keys to version control
2. **Webhook Signature**: Always verify webhook signatures to prevent tampering
3. **HTTPS**: Ensure all endpoints use HTTPS
4. **Environment Variables**: Use AWS Systems Manager Parameter Store for production secrets
5. **CORS**: Configure API Gateway CORS to restrict origin domains
6. **Rate Limiting**: Implement rate limiting for payment endpoints

## Monitoring

### CloudWatch Logs

Monitor Lambda function logs:

```bash
sam logs -n CreateOrderRazorpayFunction --stack-name your-stack-name --tail
sam logs -n VerifyPaymentRazorpayFunction --stack-name your-stack-name --tail
sam logs -n RazorpayWebhookFunction --stack-name your-stack-name --tail
```

### Razorpay Dashboard

- Monitor payments in real-time
- View webhook delivery status
- Check failed payments and errors

## Troubleshooting

### Payment Verification Fails

- Check HMAC signature generation in `verify-payment-razorpay/app.ts`
- Verify `RAZORPAY_KEY_SECRET` matches Razorpay Dashboard
- Check CloudWatch logs for signature mismatch details

### Webhook Not Receiving Events

- Verify webhook URL is publicly accessible
- Check Razorpay Dashboard → Webhooks → Logs for delivery attempts
- Ensure webhook secret matches deployment parameter
- Check Lambda function permissions and CloudWatch logs

### Order Creation Fails

- Verify amount is in correct format (paise for INR, cents for USD)
- Check `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` are correct
- Review CloudWatch logs for Razorpay API errors

### Frontend Payment Modal Not Opening

- Verify Razorpay script is loaded in `index.html`
- Check `VITE_RAZORPAY_KEY_ID` environment variable
- Open browser console for JavaScript errors
- Ensure `window.Razorpay` is defined

## Cost Estimation

### AWS Costs (Approximate)
- Lambda invocations: ~$0.20 per 1M requests
- API Gateway: ~$1.00 per 1M requests
- DynamoDB: Pay-per-request pricing (~$1.25 per 1M writes)

### Razorpay Fees
- India: 2% + ₹0 per transaction
- International: Check [Razorpay pricing](https://razorpay.com/pricing/)

## Support Resources

- **Razorpay Docs**: https://razorpay.com/docs/
- **AWS SAM Docs**: https://docs.aws.amazon.com/serverless-application-model/
- **GitHub Issues**: File issues in your repository
- **Razorpay Support**: https://razorpay.com/support/

## Next Steps

1. Test payment flow in test mode
2. Implement subscription management UI
3. Add payment history in ProfileView
4. Set up email notifications for successful payments
5. Implement subscription cancellation flow
6. Add refund handling (if needed)
