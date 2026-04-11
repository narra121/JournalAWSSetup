import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import Razorpay from 'razorpay';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { envelope, errorResponse, ErrorCodes } from '../../shared/validation';
import { getUserId } from '../../shared/auth';

let razorpay: Razorpay | null = null;

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);
const SUBSCRIPTIONS_TABLE = process.env.SUBSCRIPTIONS_TABLE!;

/**
 * Create a Razorpay subscription for a customer
 * This initiates the authentication transaction and sets up recurring billing
 */
export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  const { headers, multiValueHeaders, ...safeEvent } = event;
  console.log('Event:', JSON.stringify(safeEvent, null, 2));

  try {
    if (!razorpay) {
      console.log('Initializing Razorpay client...');
      if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
        console.error('Missing Razorpay credentials');
        return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Server configuration error');
      }
      razorpay = new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET,
      });
    }

    // Get userId from Cognito authorizer
    const userId = getUserId(event);
    if (!userId) {
      return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');
    }

    // Check if user already has an active subscription
    const existingSubscription = await docClient.send(
      new GetCommand({
        TableName: SUBSCRIPTIONS_TABLE,
        Key: { userId },
      })
    );

    if (existingSubscription.Item) {
      const status = existingSubscription.Item.status;
      
      // If user has a pending payment subscription, return the existing payment link
      if (status === 'created') {
        console.log('User has pending payment subscription, returning existing payment link');
        return envelope({
          statusCode: 200,
          data: {
            subscriptionId: existingSubscription.Item.subscriptionId,
            planId: existingSubscription.Item.planId,
            status: existingSubscription.Item.status,
            shortUrl: existingSubscription.Item.paymentLink,
            paymentLink: existingSubscription.Item.paymentLink,
            authAttempts: existingSubscription.Item.authAttempts || 0,
          },
          message: 'Using existing pending subscription'
        });
      }
      
      // Block if user has active, authenticated, or cancellation_requested subscription
      if (['active', 'authenticated', 'cancellation_requested'].includes(status)) {
        return errorResponse(
          400, 
          ErrorCodes.VALIDATION_ERROR, 
          `You already have a ${status} subscription. Please manage your existing subscription instead of creating a new one.`
        );
      }
    }

    const body = JSON.parse(event.body || '{}');
    const {
      planId,
      totalCount,
      quantity = 1,
      startAt,
      customerNotify = 1,
      notes = {},
    } = body;

    // Validate required fields
    if (!planId) {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Missing required field: planId');
    }

    // Create subscription in Razorpay
    const subscriptionData: any = {
      plan_id: planId,
      quantity,
      customer_notify: customerNotify,
      notes: {
        ...notes,
        userId,
      },
      // Set total billing cycles. Default to 120 (10 years) for long-term subscriptions
      // This can be overridden by passing totalCount in the request
      total_count: totalCount || 120,
    };

    // Remove total_count if explicitly passed as null or 0
    if (totalCount === null || totalCount === 0) {
      delete subscriptionData.total_count;
    }

    // Optional: Schedule subscription to start in the future (Unix timestamp)
    if (startAt) {
      subscriptionData.start_at = startAt;
    }

    const subscription = await razorpay.subscriptions.create(subscriptionData);

    console.log('Subscription created:', subscription);

    // Store initial subscription record in DynamoDB with payment link
    await docClient.send(
      new PutCommand({
        TableName: SUBSCRIPTIONS_TABLE,
        Item: {
          userId,
          subscriptionId: subscription.id,
          planId: subscription.plan_id,
          status: subscription.status, // 'created' initially
          quantity: subscription.quantity,
          totalCount: subscription.total_count || null,
          startAt: subscription.start_at || null,
          endAt: subscription.end_at || null,
          chargeAt: subscription.charge_at || null,
          currentStart: subscription.current_start || null,
          currentEnd: subscription.current_end || null,
          paidCount: subscription.paid_count || 0,
          remainingCount: subscription.remaining_count || null,
          paymentLink: subscription.short_url, // Save payment link for reuse
          authAttempts: subscription.auth_attempts || 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      })
    );

    return envelope({
      statusCode: 200,
      data: {
        subscriptionId: subscription.id,
        planId: subscription.plan_id,
        status: subscription.status,
        shortUrl: subscription.short_url,
        paymentLink: subscription.short_url, // Explicitly return as paymentLink per refactor plan
        authAttempts: subscription.auth_attempts,
      },
      message: 'Subscription created successfully'
    });
  } catch (error: any) {
    console.error('Error creating subscription:', error);
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to create subscription', error.message);
  }
};
