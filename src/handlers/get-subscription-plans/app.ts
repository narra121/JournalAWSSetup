import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const ssmClient = new SSMClient({});
const STAGE_NAME = process.env.STAGE_NAME || 'dev';

/**
 * Get available subscription plans
 * Returns the pre-configured plans with their Razorpay plan IDs
 */
export const handler = async (
  event: APIGatewayProxyEvent | any
): Promise<APIGatewayProxyResult> => {
  console.log('Event:', JSON.stringify(event, null, 2));

  try {
    // Retrieve all plan IDs from SSM Parameter Store
    const plans = await Promise.all([
      // Basic tier
      getPlanDetails('basic', 'monthly', 99),
      getPlanDetails('basic', 'yearly', 999),
      // Pro tier
      getPlanDetails('pro', 'monthly', 299),
      getPlanDetails('pro', 'yearly', 2999),
    ]);

    const availablePlans = plans.filter(p => p !== null);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: {
          plans: availablePlans,
        },
        error: null,
        meta: null,
      }),
    };
  } catch (error: any) {
    console.error('Error fetching plans:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: null,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to fetch subscription plans',
          details: error.message,
        },
        meta: null,
      }),
    };
  }
};

async function getPlanDetails(tier: 'basic' | 'pro', period: 'monthly' | 'yearly', amount: number): Promise<any | null> {
  try {
    const planKey = `${tier}_${period}`;
    const paramName = `/tradeflow/${STAGE_NAME}/razorpay/plan/${planKey}`;
    const result = await ssmClient.send(
      new GetParameterCommand({ Name: paramName })
    );

    const planId = result.Parameter?.Value;
    if (!planId) return null;

    // Return plan details based on tier, period and amount
    const planDetails: any = {
      planId,
      tier,
      period,
      amount,
      currency: 'INR',
      interval: 1,
    };

    // Basic tier
    if (tier === 'basic' && period === 'monthly') {
      planDetails.name = 'TradeFlow Basic Monthly';
      planDetails.description = 'Monthly subscription - All features included';
    } else if (tier === 'basic' && period === 'yearly') {
      planDetails.name = 'TradeFlow Basic Yearly';
      planDetails.description = 'Yearly subscription - All features included. Save 17%!';
      planDetails.savings = '17%';
      planDetails.monthlyEquivalent = 99;
    }
    // Pro tier
    else if (tier === 'pro' && period === 'monthly') {
      planDetails.name = 'TradeFlow Pro Monthly';
      planDetails.description = 'Monthly subscription - All features included. Support development!';
    } else if (tier === 'pro' && period === 'yearly') {
      planDetails.name = 'TradeFlow Pro Yearly';
      planDetails.description = 'Yearly subscription - All features included. Save 17% and support development!';
      planDetails.savings = '17%';
      planDetails.monthlyEquivalent = 299;
    }

    return planDetails;
  } catch (error: any) {
    if (error.name === 'ParameterNotFound') {
      console.log(`Plan not found for ${tier} ${period}`);
      return null;
    }
    throw error;
  }
}
