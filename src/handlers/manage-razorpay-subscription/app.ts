import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import Razorpay from 'razorpay';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
});

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);
const SUBSCRIPTIONS_TABLE = process.env.SUBSCRIPTIONS_TABLE!;

/**
 * Manage Razorpay subscriptions: cancel, pause, resume
 * Supports GET (fetch details), PUT (pause/resume), DELETE (cancel)
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
        body: JSON.stringify({ message: 'Unauthorized' }),
      };
    }

    const method = event.httpMethod;

    // GET: Fetch subscription details
    if (method === 'GET') {
      const result = await docClient.send(
        new GetCommand({
          TableName: SUBSCRIPTIONS_TABLE,
          Key: { userId },
        })
      );

      if (!result.Item) {
        return {
          statusCode: 404,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: 'No subscription found' }),
        };
      }

      // Fetch latest details from Razorpay
      const subscriptionId = result.Item.subscriptionId;
      if (subscriptionId) {
        try {
          const razorpaySubscription = await razorpay.subscriptions.fetch(subscriptionId);
          
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ...result.Item,
              razorpayDetails: {
                status: razorpaySubscription.status,
                paidCount: razorpaySubscription.paid_count,
                remainingCount: razorpaySubscription.remaining_count,
                currentStart: razorpaySubscription.current_start,
                currentEnd: razorpaySubscription.current_end,
                chargeAt: razorpaySubscription.charge_at,
                endedAt: razorpaySubscription.ended_at,
              },
            }),
          };
        } catch (error) {
          console.log('Could not fetch from Razorpay, returning DB data', error);
        }
      }

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(result.Item),
      };
    }

    // PUT: Pause or Resume subscription
    if (method === 'PUT') {
      const body = JSON.parse(event.body || '{}');
      const { action } = body; // 'pause' or 'resume'

      if (!['pause', 'resume'].includes(action)) {
        return {
          statusCode: 400,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: 'Invalid action. Must be "pause" or "resume"',
          }),
        };
      }

      // Get subscription ID from DB
      const result = await docClient.send(
        new GetCommand({
          TableName: SUBSCRIPTIONS_TABLE,
          Key: { userId },
        })
      );

      if (!result.Item || !result.Item.subscriptionId) {
        return {
          statusCode: 404,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: 'No subscription found' }),
        };
      }

      const subscriptionId = result.Item.subscriptionId;

      // Pause or resume in Razorpay
      if (action === 'pause') {
        await razorpay.subscriptions.pause(subscriptionId, {
          pause_at: body.pauseAt || 'now', // 'now' or Unix timestamp
        });

        // Update status in DynamoDB
        await docClient.send(
          new UpdateCommand({
            TableName: SUBSCRIPTIONS_TABLE,
            Key: { userId },
            UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':status': 'paused',
              ':updatedAt': new Date().toISOString(),
            },
          })
        );

        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: 'Subscription paused successfully',
            subscriptionId,
          }),
        };
      } else {
        // Resume
        await razorpay.subscriptions.resume(subscriptionId, {
          resume_at: body.resumeAt || 'now', // 'now' or Unix timestamp
        });

        await docClient.send(
          new UpdateCommand({
            TableName: SUBSCRIPTIONS_TABLE,
            Key: { userId },
            UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':status': 'active',
              ':updatedAt': new Date().toISOString(),
            },
          })
        );

        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: 'Subscription resumed successfully',
            subscriptionId,
          }),
        };
      }
    }

    // DELETE: Cancel subscription
    if (method === 'DELETE') {
      const body = JSON.parse(event.body || '{}');
      const { cancelAtCycleEnd = false } = body;

      // Get subscription ID from DB
      const result = await docClient.send(
        new GetCommand({
          TableName: SUBSCRIPTIONS_TABLE,
          Key: { userId },
        })
      );

      if (!result.Item || !result.Item.subscriptionId) {
        return {
          statusCode: 404,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: 'No subscription found' }),
        };
      }

      const subscriptionId = result.Item.subscriptionId;

      // Cancel in Razorpay
      if (cancelAtCycleEnd) {
        // @ts-ignore - Razorpay types may be incorrect
        await razorpay.subscriptions.cancel(subscriptionId, {
          cancel_at_cycle_end: 1,
        });
      } else {
        await razorpay.subscriptions.cancel(subscriptionId);
      }

      // Update status in DynamoDB
      await docClient.send(
        new UpdateCommand({
          TableName: SUBSCRIPTIONS_TABLE,
          Key: { userId },
          UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':status': cancelAtCycleEnd ? 'cancelling' : 'cancelled',
            ':updatedAt': new Date().toISOString(),
          },
        })
      );

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: cancelAtCycleEnd
            ? 'Subscription will be cancelled at end of billing cycle'
            : 'Subscription cancelled immediately',
          subscriptionId,
        }),
      };
    }

    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Method not allowed' }),
    };
  } catch (error: any) {
    console.error('Error managing subscription:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Failed to manage subscription',
        error: error.message,
      }),
    };
  }
};
