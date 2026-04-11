import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import Razorpay from 'razorpay';
import { envelope, errorResponse, ErrorCodes } from '../../shared/validation';
import { getUserId } from '../../shared/auth';

let razorpay: Razorpay | null = null;

interface CreateOrderPayload {
  amount: number;
  currency?: string;
  notes?: Record<string, string>;
}

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {
    if (!razorpay) {
      if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
        console.error('Missing Razorpay credentials');
        return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Server configuration error');
      }
      razorpay = new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET,
      });
    }

    const { headers, multiValueHeaders, ...safeEvent } = event;
    console.log('Creating Razorpay order', { event: safeEvent });

    // Parse request body
    const body: CreateOrderPayload = JSON.parse(event.body || '{}');
    const { amount, currency = 'INR', notes = {} } = body;

    // Validate amount
    if (!amount || amount <= 0) {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Invalid amount. Amount must be greater than 0.');
    }

    // Get user ID from authorizer
    const userId = getUserId(event);
    if (!userId) {
      return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');
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

    return envelope({
      statusCode: 200,
      data: {
        orderId: order.id,
        amount: order.amount,
        currency: order.currency,
      },
      message: 'Order created successfully'
    });
  } catch (error: any) {
    console.error('Error creating Razorpay order', { error });

    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to create order', error.message);
  }
};
