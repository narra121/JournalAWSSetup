#!/usr/bin/env python3
"""
Initialize Razorpay subscription plans via API.
This script creates the required subscription plans in Razorpay.
Usage: python init-subscription-plans.py <environment>
Environment: dev or prod
"""

import os
import sys
import json
import requests
from typing import Dict, List, Optional

# Plan definitions
PLANS = [
    {
        "period": "monthly",
        "interval": 1,
        "item": {
            "name": "TradeFlow Basic - Monthly",
            "amount": 29900,  # $299 in cents
            "currency": "USD",
            "description": "Basic trading journal with essential features"
        }
    },
    {
        "period": "yearly",
        "interval": 1,
        "item": {
            "name": "TradeFlow Basic - Yearly",
            "amount": 299900,  # $2999 in cents (save ~17%)
            "currency": "USD",
            "description": "Basic trading journal with essential features - yearly billing"
        }
    },
    {
        "period": "monthly",
        "interval": 1,
        "item": {
            "name": "TradeFlow Pro - Monthly",
            "amount": 59900,  # $599 in cents
            "currency": "USD",
            "description": "Professional trading journal with advanced analytics"
        }
    },
    {
        "period": "yearly",
        "interval": 1,
        "item": {
            "name": "TradeFlow Pro - Yearly",
            "amount": 599900,  # $5999 in cents (save ~17%)
            "currency": "USD",
            "description": "Professional trading journal with advanced analytics - yearly billing"
        }
    }
]


def get_credentials(environment: str) -> tuple[str, str]:
    """Get Razorpay credentials from environment variables."""
    if environment == "dev":
        key_id = os.getenv("RAZORPAY_KEY_ID_DEV")
        key_secret = os.getenv("RAZORPAY_KEY_SECRET_DEV")
    elif environment == "prod":
        key_id = os.getenv("RAZORPAY_KEY_ID_PROD")
        key_secret = os.getenv("RAZORPAY_KEY_SECRET_PROD")
    else:
        raise ValueError(f"Invalid environment: {environment}. Must be 'dev' or 'prod'")
    
    if not key_id or not key_secret:
        raise ValueError(f"Missing Razorpay credentials for {environment} environment")
    
    return key_id, key_secret


def create_plan(plan_data: Dict, auth: tuple[str, str]) -> Optional[Dict]:
    """Create a subscription plan in Razorpay."""
    url = "https://api.razorpay.com/v1/plans"
    
    try:
        response = requests.post(
            url,
            json=plan_data,
            auth=auth,
            headers={"Content-Type": "application/json"}
        )
        response.raise_for_status()
        return response.json()
    except requests.exceptions.RequestException as e:
        print(f"Error creating plan '{plan_data['item']['name']}': {e}")
        if hasattr(e, 'response') and e.response is not None:
            print(f"Response: {e.response.text}")
        return None


def list_existing_plans(auth: tuple[str, str]) -> List[Dict]:
    """List all existing plans in Razorpay."""
    url = "https://api.razorpay.com/v1/plans"
    
    try:
        response = requests.get(url, auth=auth)
        response.raise_for_status()
        data = response.json()
        return data.get("items", [])
    except requests.exceptions.RequestException as e:
        print(f"Error listing plans: {e}")
        return []


def store_plan_ids_in_ssm(environment: str, plans: List[Dict]) -> None:
    """Store plan IDs in AWS Systems Manager Parameter Store."""
    import boto3
    
    ssm = boto3.client('ssm')
    
    for plan in plans:
        plan_name = plan['item']['name']
        plan_id = plan['id']
        
        # Create parameter name based on plan type
        if 'Basic' in plan_name:
            tier = 'basic'
        elif 'Pro' in plan_name:
            tier = 'pro'
        else:
            tier = 'unknown'
        
        if 'Monthly' in plan_name:
            billing = 'monthly'
        elif 'Yearly' in plan_name:
            billing = 'yearly'
        else:
            billing = 'unknown'
        
        param_name = f"/tradeflow/{environment}/razorpay/plan/{tier}_{billing}"
        
        try:
            ssm.put_parameter(
                Name=param_name,
                Value=plan_id,
                Type='String',
                Overwrite=True,
                Description=f"Razorpay plan ID for {plan_name}"
            )
            print(f"✓ Stored {param_name} = {plan_id}")
        except Exception as e:
            print(f"✗ Failed to store {param_name}: {e}")


def main():
    if len(sys.argv) != 2:
        print("Usage: python init-subscription-plans.py <environment>")
        print("Environment: dev or prod")
        sys.exit(1)
    
    environment = sys.argv[1].lower()
    
    if environment not in ["dev", "prod"]:
        print(f"Error: Invalid environment '{environment}'. Must be 'dev' or 'prod'")
        sys.exit(1)
    
    print(f"🚀 Initializing subscription plans for {environment.upper()} environment...")
    print()
    
    # Get credentials
    try:
        key_id, key_secret = get_credentials(environment)
        auth = (key_id, key_secret)
    except ValueError as e:
        print(f"❌ Error: {e}")
        sys.exit(1)
    
    # Check existing plans
    print("📋 Checking existing plans...")
    existing_plans = list_existing_plans(auth)
    existing_plan_names = {plan['item']['name'] for plan in existing_plans}
    print(f"   Found {len(existing_plans)} existing plan(s)")
    print()
    
    # Create plans
    created_plans = []
    skipped_plans = []
    
    for plan_data in PLANS:
        plan_name = plan_data['item']['name']
        
        if plan_name in existing_plan_names:
            print(f"⏭️  Skipping '{plan_name}' (already exists)")
            # Find the existing plan
            existing_plan = next(p for p in existing_plans if p['item']['name'] == plan_name)
            skipped_plans.append(existing_plan)
            continue
        
        print(f"➕ Creating '{plan_name}'...")
        result = create_plan(plan_data, auth)
        
        if result:
            print(f"   ✓ Created with ID: {result['id']}")
            created_plans.append(result)
        else:
            print(f"   ✗ Failed to create")
        print()
    
    # Store plan IDs in SSM
    all_plans = created_plans + skipped_plans
    
    if all_plans:
        print("💾 Storing plan IDs in AWS Systems Manager...")
        try:
            store_plan_ids_in_ssm(environment, all_plans)
        except Exception as e:
            print(f"⚠️  Warning: Could not store plan IDs in SSM: {e}")
            print("   Plan IDs will need to be manually configured")
        print()
    
    # Summary
    print("=" * 60)
    print("📊 Summary:")
    print(f"   Created: {len(created_plans)} plan(s)")
    print(f"   Skipped: {len(skipped_plans)} plan(s)")
    print(f"   Total:   {len(all_plans)} plan(s)")
    print("=" * 60)
    
    if created_plans or skipped_plans:
        print()
        print("✅ Subscription plans initialized successfully!")
        sys.exit(0)
    else:
        print()
        print("❌ No plans were created or found")
        sys.exit(1)


if __name__ == "__main__":
    main()
