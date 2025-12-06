import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import crypto from 'crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);
const SUBSCRIPTIONS_TABLE = process.env.SUBSCRIPTIONS_TABLE!;

interface RazorpayWebhookPayload {
  event: string;
  payload: {
    payment?: {
      entity: {
        id: string;
        order_id?: string;
        amount: number;
        currency: string;
        status: string;
        email?: string;
        contact?: string;
        notes?: Record<string, string>;
      };
    };
    subscription?: {
      entity: {
        id: string;
        plan_id: string;
        status: string;
        quantity: number;
        total_count?: number;
        paid_count: number;
        remaining_count?: number;
        current_start?: number;
        current_end?: number;
        ended_at?: number;
        charge_at?: number;
        start_at?: number;
        end_at?: number;
        auth_attempts?: number;
        notes?: Record<string, string>;
      };
    };
  };
  created_at: number;
}

export const lambdaHandler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {
    console.log('Received Razorpay webhook', JSON.stringify(event, null, 2));

    const webhookSignature = event.headers['x-razorpay-signature'] || '';
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET!;

    // Verify webhook signature
    const expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(event.body || '')
      .digest('hex');

    if (webhookSignature !== expectedSignature) {
      console.error('Webhook signature verification failed');
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Invalid signature' }),
      };
    }

    // Parse webhook payload
    const payload: RazorpayWebhookPayload = JSON.parse(event.body || '{}');
    const { event: webhookEvent, payload: webhookPayload } = payload;

    console.log('Processing webhook event:', webhookEvent);

    const timestamp = new Date().toISOString();

    // Handle subscription events
    switch (webhookEvent) {
      case 'subscription.activated': {
        // Subscription has been activated after first successful payment
        const subscription = webhookPayload.subscription!.entity;
        const userId = subscription.notes?.userId;

        if (!userId) {
          console.warn('No userId found in subscription notes');
          break;
        }

        await docClient.send(
          new UpdateCommand({
            TableName: SUBSCRIPTIONS_TABLE,
            Key: { userId },
            UpdateExpression:
              'SET #status = :status, paidCount = :paidCount, currentStart = :currentStart, currentEnd = :currentEnd, chargeAt = :chargeAt, updatedAt = :updatedAt',
            ExpressionAttributeNames: {
              '#status': 'status',
            },
            ExpressionAttributeValues: {
              ':status': 'active',
              ':paidCount': subscription.paid_count,
              ':currentStart': subscription.current_start
                ? new Date(subscription.current_start * 1000).toISOString()
                : null,
              ':currentEnd': subscription.current_end
                ? new Date(subscription.current_end * 1000).toISOString()
                : null,
              ':chargeAt': subscription.charge_at
                ? new Date(subscription.charge_at * 1000).toISOString()
                : null,
              ':updatedAt': timestamp,
            },
          })
        );

        console.log('Subscription activated', {
          userId,
          subscriptionId: subscription.id,
        });
        break;
      }

      case 'subscription.charged': {
        // Recurring payment successful - auto-deducted by Razorpay
        const subscription = webhookPayload.subscription!.entity;
        const userId = subscription.notes?.userId;

        if (!userId) {
          console.warn('No userId found in subscription notes');
          break;
        }

        // Update paid count and extend service period
        await docClient.send(
          new UpdateCommand({
            TableName: SUBSCRIPTIONS_TABLE,
            Key: { userId },
            UpdateExpression:
              'SET #status = :status, paidCount = :paidCount, remainingCount = :remainingCount, currentStart = :currentStart, currentEnd = :currentEnd, chargeAt = :chargeAt, updatedAt = :updatedAt',
            ExpressionAttributeNames: {
              '#status': 'status',
            },
            ExpressionAttributeValues: {
              ':status': 'active',
              ':paidCount': subscription.paid_count,
              ':remainingCount': subscription.remaining_count || null,
              ':currentStart': subscription.current_start
                ? new Date(subscription.current_start * 1000).toISOString()
                : null,
              ':currentEnd': subscription.current_end
                ? new Date(subscription.current_end * 1000).toISOString()
                : null,
              ':chargeAt': subscription.charge_at
                ? new Date(subscription.charge_at * 1000).toISOString()
                : null,
              ':updatedAt': timestamp,
            },
          })
        );

        console.log('Recurring payment charged successfully', {
          userId,
          subscriptionId: subscription.id,
          paidCount: subscription.paid_count,
        });
        break;
      }

      case 'subscription.pending': {
        // Payment failed, Razorpay is retrying
        const subscription = webhookPayload.subscription!.entity;
        const userId = subscription.notes?.userId;

        if (!userId) {
          console.warn('No userId found in subscription notes');
          break;
        }

        await docClient.send(
          new UpdateCommand({
            TableName: SUBSCRIPTIONS_TABLE,
            Key: { userId },
            UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt',
            ExpressionAttributeNames: {
              '#status': 'status',
            },
            ExpressionAttributeValues: {
              ':status': 'pending',
              ':updatedAt': timestamp,
            },
          })
        );

        console.log('Subscription pending (payment retry)', {
          userId,
          subscriptionId: subscription.id,
        });
        break;
      }

      case 'subscription.halted': {
        // All retry attempts failed - suspend service
        const subscription = webhookPayload.subscription!.entity;
        const userId = subscription.notes?.userId;

        if (!userId) {
          console.warn('No userId found in subscription notes');
          break;
        }

        await docClient.send(
          new UpdateCommand({
            TableName: SUBSCRIPTIONS_TABLE,
            Key: { userId },
            UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt',
            ExpressionAttributeNames: {
              '#status': 'status',
            },
            ExpressionAttributeValues: {
              ':status': 'halted',
              ':updatedAt': timestamp,
            },
          })
        );

        console.log('Subscription halted (payment failed)', {
          userId,
          subscriptionId: subscription.id,
        });
        break;
      }

      case 'subscription.cancelled': {
        // Subscription was cancelled
        const subscription = webhookPayload.subscription!.entity;
        const userId = subscription.notes?.userId;

        if (!userId) {
          console.warn('No userId found in subscription notes');
          break;
        }

        await docClient.send(
          new UpdateCommand({
            TableName: SUBSCRIPTIONS_TABLE,
            Key: { userId },
            UpdateExpression:
              'SET #status = :status, endedAt = :endedAt, updatedAt = :updatedAt',
            ExpressionAttributeNames: {
              '#status': 'status',
            },
            ExpressionAttributeValues: {
              ':status': 'cancelled',
              ':endedAt': subscription.ended_at
                ? new Date(subscription.ended_at * 1000).toISOString()
                : timestamp,
              ':updatedAt': timestamp,
            },
          })
        );

        console.log('Subscription cancelled', {
          userId,
          subscriptionId: subscription.id,
        });
        break;
      }

      case 'subscription.completed': {
        // Subscription completed all billing cycles
        const subscription = webhookPayload.subscription!.entity;
        const userId = subscription.notes?.userId;

        if (!userId) {
          console.warn('No userId found in subscription notes');
          break;
        }

        await docClient.send(
          new UpdateCommand({
            TableName: SUBSCRIPTIONS_TABLE,
            Key: { userId },
            UpdateExpression:
              'SET #status = :status, endedAt = :endedAt, updatedAt = :updatedAt',
            ExpressionAttributeNames: {
              '#status': 'status',
            },
            ExpressionAttributeValues: {
              ':status': 'completed',
              ':endedAt': subscription.ended_at
                ? new Date(subscription.ended_at * 1000).toISOString()
                : timestamp,
              ':updatedAt': timestamp,
            },
          })
        );

        console.log('Subscription completed', {
          userId,
          subscriptionId: subscription.id,
          totalPaid: subscription.paid_count,
        });
        break;
      }

      // Legacy payment events (for one-time payments)
      case 'payment.captured': {
        if (!webhookPayload.payment) break;
        const payment = webhookPayload.payment.entity;
        if (!payment) break;
        const userId = payment.notes?.userId;

        if (!userId) {
          console.warn('No userId found in payment notes');
          break;
        }

        // One-time payment for non-subscription
        await docClient.send(
          new PutCommand({
            TableName: SUBSCRIPTIONS_TABLE,
            Item: {
              userId,
              status: 'active',
              paymentId: payment.id,
              orderId: payment.order_id,
              amount: payment.amount / 100,
              currency: payment.currency,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          })
        );

        console.log('One-time payment captured', {
          userId,
          paymentId: payment.id,
        });
        break;
      }

      case 'payment.failed': {
        const payment = webhookPayload.payment!.entity;
        console.log('Payment failed', {
          paymentId: payment.id,
          orderId: payment.order_id,
        });
        break;
      }

      default:
        console.log('Unhandled webhook event', { webhookEvent });
    }

    if (webhookEvent === 'payment.failed') {
      if (!webhookPayload.payment) return {
        statusCode: 200,
        body: JSON.stringify({ message: 'No payment data' }),
      };
      const payment = webhookPayload.payment.entity;
      console.log('Payment failed', {
        paymentId: payment.id,
        orderId: payment.order_id,
      });
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Webhook processed successfully' }),
    };
  } catch (error) {
    console.error('Error processing Razorpay webhook:', error);

    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to process webhook' }),
    };
  }
};
