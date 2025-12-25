import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import crypto from 'crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);
const ssmClient = new SSMClient({});
const SUBSCRIPTIONS_TABLE = process.env.SUBSCRIPTIONS_TABLE!;
const WEBHOOK_SECRET_PARAM = process.env.RAZORPAY_WEBHOOK_SECRET_PARAM!;

// Cache the webhook secret
let cachedWebhookSecret: string | null = null;

async function getWebhookSecret(): Promise<string> {
  if (cachedWebhookSecret) {
    return cachedWebhookSecret;
  }

  try {
    const response = await ssmClient.send(
      new GetParameterCommand({
        Name: WEBHOOK_SECRET_PARAM,
        WithDecryption: true,
      })
    );
    cachedWebhookSecret = response.Parameter?.Value || '';
    return cachedWebhookSecret;
  } catch (error) {
    console.error('Failed to fetch webhook secret from SSM:', error);
    throw new Error('Failed to retrieve webhook secret');
  }
}

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
    payout?: {
      entity: {
        id: string;
        entity: string;
        fund_account_id?: string;
        amount: number;
        currency: string;
        status: string;
        purpose?: string;
        mode?: string;
        reference_id?: string;
        narration?: string;
        created_at?: number;
        notes?: Record<string, string>;
      };
    };
  };
  created_at: number;
}

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {
    console.log('Received Razorpay webhook', JSON.stringify(event, null, 2));

    // Handle case-insensitive headers (API Gateway normalizes to lowercase)
    const webhookSignature = event.headers['x-razorpay-signature'] || event.headers['X-Razorpay-Signature'] || '';
    
    if (!webhookSignature) {
      console.error('Missing webhook signature header');
      return {
        statusCode: 400,
        body: JSON.stringify({
          data: null,
          error: {
            code: 'MISSING_SIGNATURE',
            message: 'Missing webhook signature',
          },
          meta: null,
        }),
      };
    }

    const webhookSecret = await getWebhookSecret();
    
    if (!webhookSecret) {
      console.error('Missing webhook secret');
      return {
        statusCode: 500,
        body: JSON.stringify({
          data: null,
          error: {
            code: 'SERVER_ERROR',
            message: 'Server configuration error',
          },
          meta: null,
        }),
      };
    }

    // Verify webhook signature
    const expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(event.body || '')
      .digest('hex');

    if (webhookSignature !== expectedSignature) {
      console.error('Webhook signature verification failed');
      return {
        statusCode: 400,
        body: JSON.stringify({
          data: null,
          error: {
            code: 'INVALID_SIGNATURE',
            message: 'Invalid signature',
          },
          meta: null,
        }),
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

      case 'subscription.authenticated': {
        // Initial authentication transaction successful
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
              'SET #status = :status, authAttempts = :authAttempts, updatedAt = :updatedAt',
            ExpressionAttributeNames: {
              '#status': 'status',
            },
            ExpressionAttributeValues: {
              ':status': 'authenticated',
              ':authAttempts': subscription.auth_attempts || 0,
              ':updatedAt': timestamp,
            },
          })
        );

        console.log('Subscription authenticated', {
          userId,
          subscriptionId: subscription.id,
        });
        break;
      }

      case 'subscription.paused': {
        // Subscription paused by merchant or customer
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
              ':status': 'paused',
              ':updatedAt': timestamp,
            },
          })
        );

        console.log('Subscription paused', {
          userId,
          subscriptionId: subscription.id,
        });
        break;
      }

      case 'subscription.resumed': {
        // Subscription resumed after pause
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
              ':status': 'active',
              ':updatedAt': timestamp,
            },
          })
        );

        console.log('Subscription resumed', {
          userId,
          subscriptionId: subscription.id,
        });
        break;
      }

      case 'subscription.updated': {
        // Subscription details updated (plan, quantity, etc.)
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
              'SET planId = :planId, quantity = :quantity, totalCount = :totalCount, remainingCount = :remainingCount, updatedAt = :updatedAt',
            ExpressionAttributeValues: {
              ':planId': subscription.plan_id,
              ':quantity': subscription.quantity,
              ':totalCount': subscription.total_count || null,
              ':remainingCount': subscription.remaining_count || null,
              ':updatedAt': timestamp,
            },
          })
        );

        console.log('Subscription updated', {
          userId,
          subscriptionId: subscription.id,
        });
        break;
      }

      // Payout events
      case 'payout.initiated': {
        // Payout initiated
        const payout = webhookPayload.payout?.entity;
        if (!payout) break;

        console.log('Payout initiated', {
          payoutId: payout.id,
          amount: payout.amount / 100,
          currency: payout.currency,
          status: payout.status,
        });
        break;
      }

      case 'payout.processed': {
        // Payout successfully processed
        const payout = webhookPayload.payout?.entity;
        if (!payout) break;

        console.log('Payout processed', {
          payoutId: payout.id,
          amount: payout.amount / 100,
          currency: payout.currency,
          status: payout.status,
        });
        break;
      }

      case 'payout.reversed': {
        // Payout reversed (failed after processing)
        const payout = webhookPayload.payout?.entity;
        if (!payout) break;

        console.log('Payout reversed', {
          payoutId: payout.id,
          amount: payout.amount / 100,
          currency: payout.currency,
          status: payout.status,
        });
        break;
      }

      case 'payout.rejected': {
        // Payout rejected
        const payout = webhookPayload.payout?.entity;
        if (!payout) break;

        console.log('Payout rejected', {
          payoutId: payout.id,
          amount: payout.amount / 100,
          currency: payout.currency,
          status: payout.status,
        });
        break;
      }

      case 'payout.pending': {
        // Payout pending
        const payout = webhookPayload.payout?.entity;
        if (!payout) break;

        console.log('Payout pending', {
          payoutId: payout.id,
          amount: payout.amount / 100,
          currency: payout.currency,
          status: payout.status,
        });
        break;
      }

      case 'payout.updated': {
        // Payout details updated
        const payout = webhookPayload.payout?.entity;
        if (!payout) break;

        console.log('Payout updated', {
          payoutId: payout.id,
          amount: payout.amount / 100,
          currency: payout.currency,
          status: payout.status,
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
        body: JSON.stringify({
          data: { message: 'No payment data' },
          error: null,
          meta: null,
        }),
      };
      const payment = webhookPayload.payment.entity;
      console.log('Payment failed', {
        paymentId: payment.id,
        orderId: payment.order_id,
      });
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        data: { message: 'Webhook processed successfully' },
        error: null,
        meta: null,
      }),
    };
  } catch (error) {
    console.error('Error processing Razorpay webhook:', error);

    return {
      statusCode: 500,
      body: JSON.stringify({
        data: null,
        error: {
          code: 'WEBHOOK_PROCESSING_FAILED',
          message: 'Failed to process webhook',
        },
        meta: null,
      }),
    };
  }
};
