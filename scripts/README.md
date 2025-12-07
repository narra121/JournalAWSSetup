# Subscription Plans Initialization Script

This script initializes Razorpay subscription plans for the TradeFlow application.

## Overview

The script creates 4 subscription plans in Razorpay:
1. **TradeFlow Basic - Monthly** ($299/month)
2. **TradeFlow Basic - Yearly** ($2999/year, ~17% savings)
3. **TradeFlow Pro - Monthly** ($599/month)
4. **TradeFlow Pro - Yearly** ($5999/year, ~17% savings)

After creating the plans, it stores the plan IDs in AWS Systems Manager Parameter Store for use by the Lambda functions.

## Usage

### GitHub Actions (Automatic)

The script runs automatically during deployment via GitHub Actions:
- **Dev environment**: Uses `RAZORPAY_KEY_ID_DEV` and `RAZORPAY_KEY_SECRET_DEV` secrets
- **Prod environment**: Uses `RAZORPAY_KEY_ID_PROD` and `RAZORPAY_KEY_SECRET_PROD` secrets

### Manual Execution

```bash
# Install dependencies
pip install requests boto3

# Set environment variables
export RAZORPAY_KEY_ID_DEV="your_key_id"
export RAZORPAY_KEY_SECRET_DEV="your_key_secret"

# For production
export RAZORPAY_KEY_ID_PROD="your_key_id"
export RAZORPAY_KEY_SECRET_PROD="your_key_secret"

# Configure AWS credentials
export AWS_ACCESS_KEY_ID="your_aws_key"
export AWS_SECRET_ACCESS_KEY="your_aws_secret"
export AWS_REGION="us-east-1"

# Run the script
python scripts/init-subscription-plans.py dev
# or
python scripts/init-subscription-plans.py prod
```

## Required GitHub Secrets

Add these secrets to your GitHub repository:

### Dev Environment
- `RAZORPAY_KEY_ID_DEV`: Razorpay test API key ID
- `RAZORPAY_KEY_SECRET_DEV`: Razorpay test API key secret

### Prod Environment
- `RAZORPAY_KEY_ID_PROD`: Razorpay live API key ID
- `RAZORPAY_KEY_SECRET_PROD`: Razorpay live API key secret

## How It Works

1. **Check Existing Plans**: Lists all existing plans in Razorpay to avoid duplicates
2. **Create New Plans**: Creates any missing plans with the defined configuration
3. **Store Plan IDs**: Saves plan IDs to AWS Systems Manager Parameter Store at:
   - `/tradeflow/{environment}/razorpay/plan/basic_monthly`
   - `/tradeflow/{environment}/razorpay/plan/basic_yearly`
   - `/tradeflow/{environment}/razorpay/plan/pro_monthly`
   - `/tradeflow/{environment}/razorpay/plan/pro_yearly`

## Plan Configuration

To modify plan pricing or add new plans, edit the `PLANS` array in `init-subscription-plans.py`:

```python
PLANS = [
    {
        "period": "monthly",
        "interval": 1,
        "item": {
            "name": "Plan Name",
            "amount": 29900,  # Amount in cents
            "currency": "USD",
            "description": "Plan description"
        }
    }
]
```

## Error Handling

- If a plan already exists, it will be skipped (not recreated)
- If SSM storage fails, the script will warn but not fail
- Network errors are logged with response details for debugging

## Testing

Test the script manually before deployment:

```bash
# Dry run (check what plans exist)
python scripts/init-subscription-plans.py dev

# Check Razorpay dashboard to verify plans were created
# Check AWS Systems Manager Parameter Store for stored plan IDs
```
