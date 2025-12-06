# TradeFlow Backend Deployment Guide

Complete guide for deploying the TradeFlow backend to AWS using SAM CLI and GitHub Actions.

---

## 📋 Prerequisites

### Required Tools
- **AWS CLI** (v2.x+): [Install Guide](https://aws.amazon.com/cli/)
- **AWS SAM CLI** (v1.120.0+): [Install Guide](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)
- **Node.js** (v20.x): [Download](https://nodejs.org/)
- **npm** (v10.x+)
- **PowerShell** (Windows) or Bash (Linux/Mac)

### AWS Account Setup
1. **AWS Account** with appropriate permissions
2. **IAM User** with the following permissions:
   - CloudFormation full access
   - Lambda full access
   - API Gateway full access
   - DynamoDB full access
   - S3 full access
   - Cognito full access
   - IAM role creation
   - CloudWatch Logs

3. **AWS Credentials Configured**:
   ```bash
   aws configure
   # Enter: Access Key ID, Secret Access Key, Region (us-east-1), Output format (json)
   ```

### Razorpay Account Setup
1. Sign up at [Razorpay Dashboard](https://dashboard.razorpay.com/)
2. Get API Keys:
   - Go to **Settings → API Keys**
   - Generate **Test Keys** (for dev): `rzp_test_xxxxx`
   - Generate **Live Keys** (for prod): `rzp_live_xxxxx`
3. Note down:
   - `Key ID` (public key)
   - `Key Secret` (private key - keep secure)
4. Generate Webhook Secret:
   - Go to **Settings → Webhooks**
   - Create webhook (URL will be added after deployment)
   - Copy the **Webhook Secret**

---

## 🚀 Local Deployment (Manual)

### Step 1: Install Dependencies
```bash
cd Backend
npm install
```

### Step 2: Create SSM Parameter for Gemini API Key
```bash
# Create SSM parameter for Gemini API key
aws ssm put-parameter \
  --name "/tradeflow/geminiApiKey" \
  --value "your-gemini-api-key" \
  --type "SecureString" \
  --region us-east-1
```

### Step 3: Build the Application
```bash
sam build
```

### Step 4: Deploy DEV Environment
```bash
sam deploy \
  --stack-name tradeflow-dev \
  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    StageName=tradeflow-dev \
    ApiVersion=v1 \
    LogRetentionDays=7 \
    GeminiApiKeyParamName=/tradeflow/geminiApiKey \
    UseExistingResources=false \
    RazorpayKeyId="rzp_test_xxxxxxxxxxxxx" \
    RazorpayKeySecret="your_test_secret_key" \
    RazorpayWebhookSecret="your_webhook_secret"
```

### Step 5: Get API Gateway URL
```bash
aws cloudformation describe-stacks \
  --stack-name tradeflow-dev \
  --query "Stacks[0].Outputs[?OutputKey=='ApiBaseUrl'].OutputValue" \
  --output text
```

**Save this URL** - you'll need it for:
- Frontend configuration (`.env.development`)
- Razorpay webhook configuration

### Step 6: Get Cognito User Pool Details
```bash
# Get User Pool ID
aws cloudformation describe-stacks \
  --stack-name tradeflow-dev \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" \
  --output text

# Get User Pool Client ID
aws cloudformation describe-stacks \
  --stack-name tradeflow-dev \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolClientId'].OutputValue" \
  --output text
```

### Step 7: Configure Razorpay Webhook

1. Go to [Razorpay Dashboard → Settings → Webhooks](https://dashboard.razorpay.com/app/webhooks)
2. Click **Create New Webhook**
3. Enter **Webhook URL**: `https://your-api-url.execute-api.us-east-1.amazonaws.com/tradeflow-dev/v1/webhook/razorpay`
4. Select Events:
   - ✅ `subscription.activated`
   - ✅ `subscription.charged`
   - ✅ `subscription.pending`
   - ✅ `subscription.halted`
   - ✅ `subscription.cancelled`
   - ✅ `subscription.completed`
5. Set **Active**: Yes
6. Save

### Step 8: Verify Subscription Plans

Subscription plans are **automatically created** during deployment. Verify they were created:

```bash
# Get available plans
curl https://your-api-url/tradeflow-dev/v1/subscriptions/plans

# Or check SSM Parameter Store
aws ssm get-parameter --name "/tradeflow/tradeflow-dev/razorpay/plan/monthly"
aws ssm get-parameter --name "/tradeflow/tradeflow-dev/razorpay/plan/yearly"
```

**Default Plans Created:**

_All plans include the same features. Higher tiers support continued development._

Monthly Plans:
- **TradeFlow Supporter**: ₹99/month
- **TradeFlow Enthusiast**: ₹299/month
- **TradeFlow Champion**: ₹499/month

Yearly Plans (save ~16% vs monthly):
- **TradeFlow Supporter**: ₹999/year
- **TradeFlow Enthusiast**: ₹2,999/year
- **TradeFlow Champion**: ₹4,999/year

**To customize plans**, edit `src/handlers/init-subscription-plans/app.ts` before deployment.

### Step 9: Manual Plan Creation (Optional)

If you need to create additional custom plans:

```bash
# Create Monthly ₹99 Plan
curl -X POST https://your-api-url/tradeflow-dev/v1/subscriptions/plans \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Starter Monthly",
    "amount": 99,
    "currency": "INR",
    "period": "monthly",
    "interval": 1,
    "description": "Starter plan - Monthly billing"
  }'

# Create Monthly ₹299 Plan
curl -X POST https://your-api-url/tradeflow-dev/v1/subscriptions/plans \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Professional Monthly",
    "amount": 299,
    "currency": "INR",
    "period": "monthly",
    "interval": 1,
    "description": "Professional plan - Monthly billing"
  }'

# Create Monthly ₹499 Plan
curl -X POST https://your-api-url/tradeflow-dev/v1/subscriptions/plans \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Premium Monthly",
    "amount": 499,
    "currency": "INR",
    "period": "monthly",
    "interval": 1,
    "description": "Premium plan - Monthly billing"
  }'

# Create Annual ₹999 Plan
curl -X POST https://your-api-url/tradeflow-dev/v1/subscriptions/plans \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Starter Annual",
    "amount": 999,
    "currency": "INR",
    "period": "yearly",
    "interval": 1,
    "description": "Starter plan - Annual billing"
  }'

# Create Annual ₹2999 Plan
curl -X POST https://your-api-url/tradeflow-dev/v1/subscriptions/plans \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Professional Annual",
    "amount": 2999,
    "currency": "INR",
    "period": "yearly",
    "interval": 1,
    "description": "Professional plan - Annual billing"
  }'

# Create Annual ₹4999 Plan
curl -X POST https://your-api-url/tradeflow-dev/v1/subscriptions/plans \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Premium Annual",
    "amount": 4999,
    "currency": "INR",
    "period": "yearly",
    "interval": 1,
    "description": "Premium plan - Annual billing"
  }'
```

**Save the returned `planId` values** - you'll need them for the Frontend.

### Step 9: Deploy PROD Environment

```bash
sam deploy \
  --stack-name tradeflow-prod \
  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    StageName=tradeflow-prod \
    ApiVersion=v1 \
    LogRetentionDays=14 \
    GeminiApiKeyParamName=/tradeflow/geminiApiKey \
    UseExistingResources=false \
    RazorpayKeyId="rzp_live_xxxxxxxxxxxxx" \
    RazorpayKeySecret="your_live_secret_key" \
    RazorpayWebhookSecret="your_webhook_secret"
```

Repeat Steps 5-8 for production with live Razorpay keys.

---

## 🤖 GitHub Actions Deployment (Automated)

### Step 1: Add GitHub Secrets

Go to: **Repository → Settings → Secrets and variables → Actions**

Click **New repository secret** and add:

#### AWS Credentials
- `AWS_ACCESS_KEY_ID`: Your AWS access key
- `AWS_SECRET_ACCESS_KEY`: Your AWS secret key

#### Razorpay DEV Credentials
- `RAZORPAY_KEY_ID_DEV`: `rzp_test_xxxxxxxxxxxxx`
- `RAZORPAY_KEY_SECRET_DEV`: Test secret key
- `RAZORPAY_WEBHOOK_SECRET_DEV`: Test webhook secret

#### Razorpay PROD Credentials
- `RAZORPAY_KEY_ID_PROD`: `rzp_live_xxxxxxxxxxxxx`
- `RAZORPAY_KEY_SECRET_PROD`: Live secret key
- `RAZORPAY_WEBHOOK_SECRET_PROD`: Live webhook secret

### Step 2: Push to GitHub

```bash
cd Backend
git add .
git commit -m "Deploy backend to AWS"
git push origin main
```

### Step 3: Monitor Deployment

1. Go to **Repository → Actions**
2. Click on the latest workflow run
3. Watch the deployment progress:
   - ✅ Build
   - ✅ Deploy to Dev
   - ✅ Deploy to Prod (after manual approval)

### Step 4: Approve Production Deployment

1. In GitHub Actions, wait for Dev deployment to complete
2. Click **Review deployments**
3. Select **prod** environment
4. Click **Approve and deploy**

---

## 🔍 Verification & Testing

### 1. Check CloudFormation Stacks
```bash
# List stacks
aws cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE

# Get stack outputs
aws cloudformation describe-stacks --stack-name tradeflow-dev --query "Stacks[0].Outputs"
```

### 2. Test API Health
```bash
curl https://your-api-url/tradeflow-dev/v1/health
```

### 3. Test Authentication
```bash
# Sign up new user
curl -X POST https://your-api-url/tradeflow-dev/v1/auth/signup \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "Test@123"
  }'
```

### 4. Check Lambda Logs
```bash
# List log groups
aws logs describe-log-groups --log-group-name-prefix /aws/lambda/tradeflow-dev

# Tail logs for a specific function
sam logs -n CreateTradeFunction --stack-name tradeflow-dev --tail
```

### 5. Test Razorpay Integration

Use Razorpay test cards:
- **Success**: `4111 1111 1111 1111`
- **Failure**: `4111 1111 1111 1112`
- CVV: Any 3 digits
- Expiry: Any future date

---

## 🔧 Troubleshooting

### Issue: SAM Build Fails
```bash
# Clean and rebuild
rm -rf .aws-sam
sam build --use-container
```

### Issue: Missing Permissions
```bash
# Verify AWS credentials
aws sts get-caller-identity

# Check IAM permissions
aws iam get-user
```

### Issue: Lambda Function Errors
```bash
# View recent errors
sam logs -n FunctionName --stack-name tradeflow-dev --filter "ERROR"

# Check environment variables
aws lambda get-function-configuration --function-name tradeflow-dev-CreateTradeFunction
```

### Issue: Razorpay Webhook Not Working
1. Verify webhook URL is correct in Razorpay Dashboard
2. Check webhook secret matches Lambda environment variable
3. Test webhook signature verification locally
4. Check CloudWatch logs for webhook Lambda

### Issue: DynamoDB Access Denied
```bash
# Verify Lambda has DynamoDB permissions
aws iam get-role-policy --role-name tradeflow-dev-CreateTradeFunction-Role --policy-name DynamoDBCrudPolicy
```

---

## 🗑️ Cleanup (Delete Stack)

### Delete DEV Stack
```bash
aws cloudformation delete-stack --stack-name tradeflow-dev
```

### Delete PROD Stack
```bash
aws cloudformation delete-stack --stack-name tradeflow-prod
```

### Delete SSM Parameters
```bash
aws ssm delete-parameter --name /tradeflow/geminiApiKey
```

### Note on S3 and DynamoDB
Due to `DeletionPolicy: Retain`, S3 buckets and DynamoDB tables are **NOT** deleted automatically. Delete manually if needed:

```bash
# Delete S3 bucket
aws s3 rb s3://bucket-name --force

# Delete DynamoDB tables
aws dynamodb delete-table --table-name Trades-tradeflow-dev
aws dynamodb delete-table --table-name TradeStats-tradeflow-dev
# ... repeat for all tables
```

---

## 📊 Monitoring & Logs

### CloudWatch Dashboards
- Go to [CloudWatch Console](https://console.aws.amazon.com/cloudwatch/)
- View Lambda metrics, API Gateway metrics, DynamoDB metrics

### Lambda Logs
```bash
# Tail logs in real-time
sam logs -n CreateTradeFunction --stack-name tradeflow-dev --tail

# Search for errors
sam logs -n CreateTradeFunction --stack-name tradeflow-dev --filter "ERROR" --start-time "1h ago"
```

### X-Ray Tracing
- Lambda functions have tracing enabled
- View traces in [X-Ray Console](https://console.aws.amazon.com/xray/)

---

## 🔐 Security Best Practices

1. **Never commit secrets** to Git
2. **Use IAM roles** with least privilege
3. **Enable MFA** on AWS root account
4. **Rotate Razorpay keys** regularly
5. **Monitor CloudTrail** for suspicious activity
6. **Use AWS Secrets Manager** for production secrets (future enhancement)
7. **Enable VPC** for Lambda functions (future enhancement)

---

## 📚 Additional Resources

- [AWS SAM Documentation](https://docs.aws.amazon.com/serverless-application-model/)
- [Razorpay Subscriptions API](https://razorpay.com/docs/api/subscriptions/)
- [API Gateway HTTP API](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api.html)
- [Lambda Best Practices](https://docs.aws.amazon.com/lambda/latest/dg/best-practices.html)

---

## 🆘 Support

For issues or questions:
1. Check CloudWatch Logs
2. Review API Gateway execution logs
3. Test locally with SAM Local: `sam local start-api`
4. Check [AWS Service Health Dashboard](https://status.aws.amazon.com/)
