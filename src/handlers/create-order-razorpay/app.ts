import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import Razorpay from 'razorpay';

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
});

interface CreateOrderPayload {
  amount: number;
  currency?: string;
  notes?: Record<string, string>;
}

export const lambdaHandler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {
    console.log('Creating Razorpay order', { event });

    // Parse request body
    const body: CreateOrderPayload = JSON.parse(event.body || '{}');
    const { amount, currency = 'INR', notes = {} } = body;

    // Validate amount
    if (!amount || amount <= 0) {
      return {
        statusCode: 400,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
        body: JSON.stringify({
          error: { message: 'Invalid amount. Amount must be greater than 0.' },
        }),
      };
    }

    // Get user ID from authorizer
    const userId = event.requestContext.authorizer?.claims?.sub;
    if (!userId) {
      return {
        statusCode: 401,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
        body: JSON.stringify({
          error: { message: 'Unauthorized' },
        }),
      };
    }

    // Create order with Razorpay
    const options = {
      amount: amount * 100, // Convert to smallest currency unit (paise)
      currency,
      receipt: `receipt_${Date.now()}`,
      notes: {
        ...notes,
        userId,
      },
    };

    const order = await razorpay.orders.create(options);

    console.log('Razorpay order created successfully', { orderId: order.id });

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({
        orderId: order.id,
        amount: order.amount,
        currency: order.currency,
      }),
    };
  } catch (error) {
    console.error('Error creating Razorpay order', { error });

    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({
        error: { message: 'Failed to create order' },
      }),
    };
  }
};
