import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { envelope, errorResponse, ErrorCodes } from '../../shared/validation';

const ssmClient = new SSMClient({});
const STAGE_NAME = process.env.STAGE_NAME || 'dev';

/**
 * Get available subscription plans
 * Returns Stripe Price IDs grouped by currency (INR or USD).
 * Query param: ?currency=INR|USD (defaults to USD)
 */
export const handler = async (
  event: APIGatewayProxyEvent | any
): Promise<APIGatewayProxyResult> => {
  const { headers, multiValueHeaders, ...safeEvent } = event;
  console.log('Event:', JSON.stringify(safeEvent, null, 2));

  try {
    // Get requested currency from query params
    const queryParams = event.queryStringParameters || {};
    const currency = (queryParams.currency || 'USD').toUpperCase();

    if (currency !== 'INR' && currency !== 'USD') {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Invalid currency. Use INR or USD.');
    }

    const suffix = currency.toLowerCase(); // 'inr' or 'usd'

    // Fetch plans for the requested currency
    const plans = await Promise.all([
      getPlanDetails('monthly', suffix, currency),
      getPlanDetails('yearly', suffix, currency),
    ]);

    const availablePlans = plans.filter(p => p !== null);

    return envelope({
      statusCode: 200,
      data: { plans: availablePlans, currency },
      message: 'Subscription plans retrieved',
    });
  } catch (error: any) {
    console.error('Error fetching plans:', error);
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to fetch subscription plans', error.message);
  }
};

const PLAN_CONFIG: Record<string, Record<string, { amount: number; name: string; description: string; savings?: string; monthlyEquivalent?: number }>> = {
  inr: {
    monthly: {
      amount: 99,
      name: 'TradeQut Pro Monthly',
      description: 'Monthly subscription — full access to all features',
    },
    yearly: {
      amount: 999,
      name: 'TradeQut Pro Annual',
      description: 'Annual subscription — full access, save 17%',
      savings: '17%',
      monthlyEquivalent: 83,
    },
  },
  usd: {
    monthly: {
      amount: 199, // $1.99 stored in cents
      name: 'TradeQut Pro Monthly',
      description: 'Monthly subscription — full access to all features',
    },
    yearly: {
      amount: 1999, // $19.99 stored in cents
      name: 'TradeQut Pro Annual',
      description: 'Annual subscription — full access, save 17%',
      savings: '17%',
      monthlyEquivalent: 167, // $1.67 in cents
    },
  },
};

async function getPlanDetails(
  period: 'monthly' | 'yearly',
  suffix: string,
  currency: string,
): Promise<any | null> {
  try {
    const paramName = `/tradequt/${STAGE_NAME}/stripe/price/${period}_${suffix}`;
    console.log(`Fetching SSM parameter: ${paramName}`);
    const result = await ssmClient.send(
      new GetParameterCommand({ Name: paramName })
    );

    const planId = result.Parameter?.Value;
    if (!planId) return null;

    const config = PLAN_CONFIG[suffix]?.[period];
    if (!config) return null;

    // For display: INR amounts are in rupees, USD amounts stored in cents but displayed as dollars
    const displayAmount = currency === 'USD' ? config.amount / 100 : config.amount;
    const displayMonthlyEquivalent = config.monthlyEquivalent
      ? currency === 'USD' ? config.monthlyEquivalent / 100 : config.monthlyEquivalent
      : undefined;

    return {
      planId,
      period,
      amount: displayAmount,
      currency,
      interval: 1,
      name: config.name,
      description: config.description,
      savings: config.savings,
      monthlyEquivalent: displayMonthlyEquivalent,
    };
  } catch (error: any) {
    console.error(`Error fetching plan ${period} ${suffix}:`, error.name, error.message);
    if (error.name === 'ParameterNotFound') {
      console.log(`Plan not found for ${period}_${suffix}`);
      return null;
    }
    throw error;
  }
}
