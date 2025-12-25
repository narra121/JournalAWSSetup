import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import Razorpay from 'razorpay';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { envelope, errorResponse, ErrorCodes } from '../../shared/validation';

let razorpay: Razorpay | null = null;

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
          
          // Also fetch all subscriptions to check if user has multiple
          // Razorpay API returns subscriptions sorted by created_at DESC by default
          let latestSubscription = razorpaySubscription;
          try {
            const allSubscriptions = await razorpay.subscriptions.all({
              count: 10, // Get last 10 subscriptions
            });
            
            // Filter subscriptions by userId in notes and find latest active/created one
            const userSubscriptions = allSubscriptions.items.filter((sub: any) => 
              sub.notes?.userId === userId
            );
            
            if (userSubscriptions.length > 0) {
              // Find the most recent non-cancelled subscription
              const activeSubscription = userSubscriptions.find((sub: any) => 
                ['active', 'authenticated', 'created', 'halted', 'paused'].includes(sub.status)
              );
              
              if (activeSubscription && activeSubscription.id !== subscriptionId) {
                console.log(`Found newer subscription ${activeSubscription.id}, updating DB from ${subscriptionId}`);
                latestSubscription = activeSubscription;
              }
            }
          } catch (error) {
            console.log('Could not fetch all subscriptions, using current one:', error);
          }
          
          // Determine the correct status:
          // - If DB shows cancellation_requested and Razorpay shows active, keep cancellation_requested
          // - Otherwise, use Razorpay's status as source of truth
          let status = latestSubscription.status;
          if (result.Item.status === 'cancellation_requested' && 
              latestSubscription.id === subscriptionId && 
              latestSubscription.status === 'active') {
            status = 'cancellation_requested';
          }
          
          // Update DB with latest subscription data if subscription ID or status changed
          if (latestSubscription.id !== subscriptionId || status !== result.Item.status) {
            await docClient.send(
              new UpdateCommand({
                TableName: SUBSCRIPTIONS_TABLE,
                Key: { userId },
                UpdateExpression: 'SET subscriptionId = :subscriptionId, planId = :planId, #status = :status, paidCount = :paidCount, remainingCount = :remainingCount, paymentLink = :paymentLink, updatedAt = :updatedAt',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: {
                  ':subscriptionId': latestSubscription.id,
                  ':planId': latestSubscription.plan_id,
                  ':status': status,
                  ':paidCount': latestSubscription.paid_count || 0,
                  ':remainingCount': latestSubscription.remaining_count,
                  ':paymentLink': latestSubscription.short_url,
                  ':updatedAt': new Date().toISOString(),
                },
              })
            );
          }
          
          return envelope({
            statusCode: 200,
            data: {
              ...result.Item,
              subscriptionId: latestSubscription.id,
              planId: latestSubscription.plan_id,
              status, // Use synchronized status
              paidCount: latestSubscription.paid_count || 0,
              remainingCount: latestSubscription.remaining_count,
              totalCount: latestSubscription.total_count,
              authAttempts: latestSubscription.auth_attempts || 0,
              paymentLink: latestSubscription.short_url,
              shortUrl: latestSubscription.short_url,
              quantity: latestSubscription.quantity,
              currentStart: latestSubscription.current_start ? new Date(latestSubscription.current_start * 1000).toISOString() : null,
              currentEnd: latestSubscription.current_end ? new Date(latestSubscription.current_end * 1000).toISOString() : null,
              chargeAt: latestSubscription.charge_at ? new Date(latestSubscription.charge_at * 1000).toISOString() : null,
              startAt: latestSubscription.start_at ? new Date(latestSubscription.start_at * 1000).toISOString() : null,
              endAt: latestSubscription.end_at ? new Date(latestSubscription.end_at * 1000).toISOString() : null,
              razorpayDetails: {
                status: latestSubscription.status,
                paidCount: latestSubscription.paid_count,
                remainingCount: latestSubscription.remaining_count,
                currentStart: latestSubscription.current_start,
                currentEnd: latestSubscription.current_end,
                chargeAt: latestSubscription.charge_at,
                endedAt: latestSubscription.ended_at,
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
    // PATCH: Undo cancellation (reactivate subscription scheduled for cancellation)
    if (method === 'PATCH') {
      const body = JSON.parse(event.body || '{}');
      const { action } = body;

      if (action !== 'undo_cancellation') {
        return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Invalid action. Must be "undo_cancellation"');
      }

      // Get subscription from DB
      const result = await docClient.send(
        new GetCommand({
          TableName: SUBSCRIPTIONS_TABLE,
          Key: { userId },
        })
      );

      if (!result.Item || !result.Item.subscriptionId) {
        return errorResponse(404, ErrorCodes.NOT_FOUND, 'No subscription found');
      }

      if (result.Item.status !== 'cancellation_requested') {
        return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Subscription is not scheduled for cancellation');
      }

      const subscriptionId = result.Item.subscriptionId;

      // Fetch current status from Razorpay
      const razorpaySubscription = await razorpay.subscriptions.fetch(subscriptionId);

      // Verify subscription is still active in Razorpay
      if (razorpaySubscription.status !== 'active') {
        return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Subscription is no longer active in Razorpay');
      }

      // Update status in DynamoDB back to active
      await docClient.send(
        new UpdateCommand({
          TableName: SUBSCRIPTIONS_TABLE,
          Key: { userId },
          UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt REMOVE cancelAt',
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
          message: 'Cancellation undone. Your subscription will continue and you will be charged on the next billing date.',
          subscriptionId,
          status: 'active',
        }
      });
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

      // Check if already cancelled or scheduled for cancellation
      if (result.Item.status === 'cancellation_requested') {
        return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Subscription is already scheduled for cancellation');
      }

      if (result.Item.status === 'cancelled') {
        return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Subscription is already cancelled');
      }

      const subscriptionId = result.Item.subscriptionId;

      // Cancel in Razorpay
      try {
        if (cancelAtCycleEnd) {
          // @ts-ignore - Razorpay types may be incorrect
          await razorpay.subscriptions.cancel(subscriptionId, {
            cancel_at_cycle_end: 1,
          });
        } else {
          await razorpay.subscriptions.cancel(subscriptionId);
        }
      } catch (error: any) {
        console.error('Razorpay cancellation error:', error);
        // If Razorpay returns an error, return a more specific error message
        if (error.statusCode === 400 && error.error?.description) {
          return errorResponse(400, ErrorCodes.VALIDATION_ERROR, error.error.description);
        }
        throw error;
      }

      // Update status in DynamoDB
      await docClient.send(
        new UpdateCommand({
          TableName: SUBSCRIPTIONS_TABLE,
          Key: { userId },
          UpdateExpression: 'SET #status = :status, cancelAt = :cancelAt, updatedAt = :updatedAt',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':status': cancelAtCycleEnd ? 'cancellation_requested' : 'cancelled',
            ':cancelAt': cancelAtCycleEnd ? 'cycle_end' : 'immediate',
            ':updatedAt': new Date().toISOString(),
          },
        })
      );

      return envelope({
        statusCode: 200,
        data: {
          status: cancelAtCycleEnd ? 'cancellation_requested' : 'cancelled',
          message: cancelAtCycleEnd
            ? 'Your subscription will remain active until the end of the current billing period.'
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
