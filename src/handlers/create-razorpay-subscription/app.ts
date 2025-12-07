import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import Razorpay from 'razorpay';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
});

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
  console.log('Event:', JSON.stringify(event, null, 2));

  try {
    // Get userId from Cognito authorizer
    const userId = event.requestContext?.authorizer?.jwt?.claims?.sub;
    if (!userId) {
      return {
        statusCode: 401,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data: null,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Unauthorized',
          },
          meta: null,
        }),
      };
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
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Missing required field: planId',
        }),
      };
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

    // Store initial subscription record in DynamoDB
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
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      })
    );

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: {
          subscriptionId: subscription.id,
          planId: subscription.plan_id,
          status: subscription.status,
          shortUrl: subscription.short_url, // Payment link for customer
          authAttempts: subscription.auth_attempts,
        },
        error: null,
        meta: null,
      }),
    };
  } catch (error: any) {
    console.error('Error creating subscription:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: null,
        error: {
          code: 'SUBSCRIPTION_CREATE_FAILED',
          message: 'Failed to create subscription',
          details: error.message,
        },
        meta: null,
      }),
    };
  }
};
