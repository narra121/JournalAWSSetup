import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import Razorpay from 'razorpay';

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
});

/**
 * Create a Razorpay subscription plan
 * Plans define the billing cycle and amount for recurring subscriptions
 */
export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  console.log('Event:', JSON.stringify(event, null, 2));

  try {
    const body = JSON.parse(event.body || '{}');
    const { name, amount, currency = 'INR', period, interval = 1, description } = body;

    // Validate required fields
    if (!name || !amount || !period) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Missing required fields: name, amount, period',
        }),
      };
    }

    // Validate period (monthly, yearly, weekly, daily)
    const validPeriods = ['daily', 'weekly', 'monthly', 'yearly'];
    if (!validPeriods.includes(period)) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `Invalid period. Must be one of: ${validPeriods.join(', ')}`,
        }),
      };
    }

    // Create plan in Razorpay
    // Note: amount is in paise (1 INR = 100 paise)
    const plan = await razorpay.plans.create({
      period,
      interval,
      item: {
        name,
        amount: Math.round(amount * 100), // Convert to paise
        currency,
        description: description || `${name} subscription plan`,
      },
    });

    console.log('Plan created:', plan);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        planId: plan.id,
        period: plan.period,
        interval: plan.interval,
        amount: Number(plan.item.amount) / 100, // Convert back to rupees
        currency: plan.item.currency,
        name: plan.item.name,
      }),
    };
  } catch (error: any) {
    console.error('Error creating plan:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Failed to create subscription plan',
        error: error.message,
      }),
    };
  }
};
