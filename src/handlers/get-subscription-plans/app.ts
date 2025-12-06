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
      // Monthly plans
      getPlanDetails('monthly', 99),
      getPlanDetails('monthly', 299),
      getPlanDetails('monthly', 499),
      // Yearly plans
      getPlanDetails('yearly', 999),
      getPlanDetails('yearly', 2999),
      getPlanDetails('yearly', 4999),
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

async function getPlanDetails(period: 'monthly' | 'yearly', amount: number): Promise<any | null> {
  try {
    const planKey = `${period}-${amount}`;
    const paramName = `/tradeflow/${STAGE_NAME}/razorpay/plan/${planKey}`;
    const result = await ssmClient.send(
      new GetParameterCommand({ Name: paramName })
    );

    const planId = result.Parameter?.Value;
    if (!planId) return null;

    // Return plan details based on period and amount
    const planDetails: any = {
      planId,
      period,
      amount,
      currency: 'INR',
      interval: 1,
    };

    // Monthly plans
    if (period === 'monthly' && amount === 99) {
      planDetails.name = 'TradeFlow Supporter Monthly';
      planDetails.tier = 'supporter';
      planDetails.description = 'Monthly subscription - All features included. Support the developer!';
    } else if (period === 'monthly' && amount === 299) {
      planDetails.name = 'TradeFlow Enthusiast Monthly';
      planDetails.tier = 'enthusiast';
      planDetails.description = 'Monthly subscription - All features included. Extra support for continued development!';
    } else if (period === 'monthly' && amount === 499) {
      planDetails.name = 'TradeFlow Champion Monthly';
      planDetails.tier = 'champion';
      planDetails.description = 'Monthly subscription - All features included. Help fund new features and improvements!';
    }
    // Yearly plans
    else if (period === 'yearly' && amount === 999) {
      planDetails.name = 'TradeFlow Supporter Yearly';
      planDetails.tier = 'supporter';
      planDetails.description = 'Yearly subscription - All features included. Support the developer!';
      planDetails.savings = '16%';
      planDetails.monthlyEquivalent = 99;
    } else if (period === 'yearly' && amount === 2999) {
      planDetails.name = 'TradeFlow Enthusiast Yearly';
      planDetails.tier = 'enthusiast';
      planDetails.description = 'Yearly subscription - All features included. Extra support for continued development!';
      planDetails.savings = '16%';
      planDetails.monthlyEquivalent = 299;
    } else if (period === 'yearly' && amount === 4999) {
      planDetails.name = 'TradeFlow Champion Yearly';
      planDetails.tier = 'champion';
      planDetails.description = 'Yearly subscription - All features included. Help fund new features and improvements!';
      planDetails.savings = '16%';
      planDetails.monthlyEquivalent = 499;
    }

    return planDetails;
  } catch (error: any) {
    if (error.name === 'ParameterNotFound') {
      console.log(`Plan not found for period: ${period}`);
      return null;
    }
    throw error;
  }
}
