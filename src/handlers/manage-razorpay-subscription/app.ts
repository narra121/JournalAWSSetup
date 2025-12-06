import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import Razorpay from 'razorpay';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { envelope, errorResponse, ErrorCodes } from '../../shared/validation';

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
  event: APIGatewayProxyEvent | any
): Promise<APIGatewayProxyResult> => {
  console.log('Event:', JSON.stringify(event, null, 2));

  try {
    // Get userId from Cognito authorizer
    const userId = event.requestContext?.authorizer?.jwt?.claims?.sub;
    if (!userId) {
      return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');
    }

    // Handle both v1 and v2 event structures for method
    const method = event.httpMethod || event.requestContext?.http?.method;

    // GET: Fetch subscription details
    if (method === 'GET') {
      const result = await docClient.send(
        new GetCommand({
          TableName: SUBSCRIPTIONS_TABLE,
          Key: { userId },
        })
      );

      if (!result.Item) {
        return errorResponse(404, ErrorCodes.NOT_FOUND, 'No subscription found');
      }

      // Fetch latest details from Razorpay
      const subscriptionId = result.Item.subscriptionId;
      if (subscriptionId) {
        try {
          const razorpaySubscription = await razorpay.subscriptions.fetch(subscriptionId);
          
          return envelope({
            statusCode: 200,
            data: {
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
            }
          });
        } catch (error) {
          console.log('Could not fetch from Razorpay, returning DB data', error);
        }
      }

      return envelope({ statusCode: 200, data: result.Item });
    }

    // PUT: Pause or Resume subscription
    if (method === 'PUT') {
      const body = JSON.parse(event.body || '{}');
      const { action } = body; // 'pause' or 'resume'

      if (!['pause', 'resume'].includes(action)) {
        return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Invalid action. Must be "pause" or "resume"');
      }

      // Get subscription ID from DB
      const result = await docClient.send(
        new GetCommand({
          TableName: SUBSCRIPTIONS_TABLE,
          Key: { userId },
        })
      );

      if (!result.Item || !result.Item.subscriptionId) {
        return errorResponse(404, ErrorCodes.NOT_FOUND, 'No subscription found');
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

        return envelope({
          statusCode: 200,
          data: {
            message: 'Subscription paused successfully',
            subscriptionId,
          }
        });
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

        return envelope({
          statusCode: 200,
          data: {
            message: 'Subscription resumed successfully',
            subscriptionId,
          }
        });
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
        return errorResponse(404, ErrorCodes.NOT_FOUND, 'No subscription found');
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

      return envelope({
        statusCode: 200,
        data: {
          message: cancelAtCycleEnd
            ? 'Subscription will be cancelled at end of billing cycle'
            : 'Subscription cancelled immediately',
          subscriptionId,
        }
      });
    }

    return errorResponse(405, ErrorCodes.VALIDATION_ERROR, 'Method not allowed');
  } catch (error: any) {
    console.error('Error managing subscription:', error);
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to manage subscription', error.message);
  }
};
