import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import Stripe from 'stripe';
import { ddb } from '../../shared/dynamo';

const ssmClient = new SSMClient({});
const SUBSCRIPTIONS_TABLE = process.env.SUBSCRIPTIONS_TABLE!;
const STRIPE_WEBHOOK_SECRET_PARAM = process.env.STRIPE_WEBHOOK_SECRET_PARAM!;
const STRIPE_SECRET_KEY_PARAM = process.env.STRIPE_SECRET_KEY_PARAM!;

// Cache SSM parameters in module scope
let cachedWebhookSecret: string | null = null;
let cachedStripeSecretKey: string | null = null;
let stripeClient: Stripe | null = null;

async function getSSMParameter(name: string): Promise<string> {
  const response = await ssmClient.send(
    new GetParameterCommand({ Name: name, WithDecryption: true })
  );
  return response.Parameter?.Value || '';
}

async function getWebhookSecret(): Promise<string> {
  if (!cachedWebhookSecret) {
    cachedWebhookSecret = await getSSMParameter(STRIPE_WEBHOOK_SECRET_PARAM);
  }
  return cachedWebhookSecret;
}

async function getStripeClient(): Promise<Stripe> {
  if (!stripeClient) {
    if (!cachedStripeSecretKey) {
      cachedStripeSecretKey = await getSSMParameter(STRIPE_SECRET_KEY_PARAM);
    }
    stripeClient = new Stripe(cachedStripeSecretKey);
  }
  return stripeClient;
}

function unixToISO(unix: number): string {
  return new Date(unix * 1000).toISOString();
}

/* ---------- Event handlers ---------- */

async function handleCheckoutSessionCompleted(
  session: Stripe.Checkout.Session,
  stripe: Stripe
): Promise<void> {
  const userId = session.metadata?.userId;
  if (!userId) {
    console.warn('checkout.session.completed: no userId in metadata');
    return;
  }

  const subscriptionId = session.subscription as string;
  const customerId = session.customer as string;

  if (!subscriptionId) {
    console.warn('checkout.session.completed: no subscription on session');
    return;
  }

  // Retrieve full subscription from Stripe for period details
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);

  // Safety net: ensure subscription has userId in metadata for future webhook events
  if (!subscription.metadata?.userId) {
    await stripe.subscriptions.update(subscriptionId, {
      metadata: { userId },
    });
  }

  const priceId = subscription.items.data[0]?.price.id;
  const currentStart = unixToISO(subscription.current_period_start);
  const currentEnd = unixToISO(subscription.current_period_end);
  const timestamp = new Date().toISOString();

  await ddb.send(
    new UpdateCommand({
      TableName: SUBSCRIPTIONS_TABLE,
      Key: { userId },
      UpdateExpression:
        'SET stripeSubscriptionId = :subId, stripeCustomerId = :custId, #status = :status, planId = :planId, currentStart = :currentStart, currentEnd = :currentEnd, chargeAt = :chargeAt, updatedAt = :updatedAt',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':subId': subscriptionId,
        ':custId': customerId,
        ':status': 'active',
        ':planId': priceId,
        ':currentStart': currentStart,
        ':currentEnd': currentEnd,
        ':chargeAt': currentEnd,
        ':updatedAt': timestamp,
      },
    })
  );

  console.log('checkout.session.completed processed', {
    userId,
    subscriptionId,
    customerId,
    priceId,
  });
}

async function handleInvoicePaid(
  invoice: Stripe.Invoice,
  stripe: Stripe
): Promise<void> {
  const subscriptionId = invoice.subscription as string;
  if (!subscriptionId) {
    console.warn('invoice.paid: no subscription on invoice');
    return;
  }

  // Skip initial subscription creation invoice — handleCheckoutSessionCompleted handles that
  if (invoice.billing_reason === 'subscription_create') {
    console.log('invoice.paid: skipping subscription_create invoice (handled by checkout)', { subscriptionId });
    return;
  }

  // Retrieve subscription to get metadata.userId and current period
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const userId = subscription.metadata?.userId;

  if (!userId) {
    console.warn('invoice.paid: no userId in subscription metadata', { subscriptionId });
    return;
  }

  const currentStart = unixToISO(subscription.current_period_start);
  const currentEnd = unixToISO(subscription.current_period_end);
  const timestamp = new Date().toISOString();
  const invoiceId = invoice.id;

  // Use ConditionExpression to prevent double-counting on Stripe retries
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: SUBSCRIPTIONS_TABLE,
        Key: { userId },
        UpdateExpression:
          'SET paidCount = if_not_exists(paidCount, :zero) + :inc, currentStart = :currentStart, currentEnd = :currentEnd, chargeAt = :chargeAt, #status = :status, updatedAt = :updatedAt, lastInvoiceId = :invoiceId',
        ConditionExpression: 'attribute_not_exists(lastInvoiceId) OR lastInvoiceId <> :invoiceId',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':zero': 0,
          ':inc': 1,
          ':currentStart': currentStart,
          ':currentEnd': currentEnd,
          ':chargeAt': currentEnd,
          ':status': 'active',
          ':updatedAt': timestamp,
          ':invoiceId': invoiceId,
        },
      })
    );

    console.log('invoice.paid processed', { userId, subscriptionId, invoiceId });
  } catch (err: any) {
    if (err.name === 'ConditionalCheckFailedException') {
      console.log('invoice.paid: duplicate event skipped', { userId, invoiceId });
      return;
    }
    throw err;
  }
}

async function handleInvoicePaymentFailed(
  invoice: Stripe.Invoice,
  stripe: Stripe
): Promise<void> {
  const subscriptionId = invoice.subscription as string;
  if (!subscriptionId) {
    console.warn('invoice.payment_failed: no subscription on invoice');
    return;
  }

  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const userId = subscription.metadata?.userId;

  if (!userId) {
    console.warn('invoice.payment_failed: no userId in subscription metadata', {
      subscriptionId,
    });
    return;
  }

  const timestamp = new Date().toISOString();

  await ddb.send(
    new UpdateCommand({
      TableName: SUBSCRIPTIONS_TABLE,
      Key: { userId },
      UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':status': 'past_due',
        ':updatedAt': timestamp,
      },
    })
  );

  console.log('invoice.payment_failed processed', { userId, subscriptionId });
}

async function handleSubscriptionUpdated(
  subscription: Stripe.Subscription
): Promise<void> {
  const userId = subscription.metadata?.userId;
  if (!userId) {
    console.warn('customer.subscription.updated: no userId in metadata');
    return;
  }

  const timestamp = new Date().toISOString();
  const updates: string[] = ['updatedAt = :updatedAt'];
  const names: Record<string, string> = {};
  const values: Record<string, any> = { ':updatedAt': timestamp };

  // Detect cancellation request (cancel at period end)
  if (subscription.cancel_at_period_end) {
    updates.push('#status = :status');
    names['#status'] = 'status';
    values[':status'] = 'cancellation_requested';
    console.log('Subscription cancellation requested', { userId });
  }

  // Detect pause
  if (subscription.pause_collection) {
    updates.push('#status = :status');
    names['#status'] = 'status';
    values[':status'] = 'paused';
    console.log('Subscription paused', { userId });
  }

  // Detect plan change
  const currentPriceId = subscription.items.data[0]?.price.id;
  if (currentPriceId) {
    updates.push('planId = :planId');
    values[':planId'] = currentPriceId;
  }

  // Update period info
  updates.push('currentStart = :currentStart');
  updates.push('currentEnd = :currentEnd');
  updates.push('chargeAt = :chargeAt');
  values[':currentStart'] = unixToISO(subscription.current_period_start);
  values[':currentEnd'] = unixToISO(subscription.current_period_end);
  values[':chargeAt'] = unixToISO(subscription.current_period_end);

  // If no status was set above (no cancel/pause), use subscription.status from Stripe
  if (!values[':status']) {
    updates.push('#status = :status');
    names['#status'] = 'status';
    values[':status'] = subscription.status === 'active' ? 'active' : subscription.status;
  }

  await ddb.send(
    new UpdateCommand({
      TableName: SUBSCRIPTIONS_TABLE,
      Key: { userId },
      UpdateExpression: `SET ${updates.join(', ')}`,
      ExpressionAttributeNames: Object.keys(names).length > 0 ? names : undefined,
      ExpressionAttributeValues: values,
    })
  );

  console.log('customer.subscription.updated processed', {
    userId,
    subscriptionId: subscription.id,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    pauseCollection: !!subscription.pause_collection,
    priceId: currentPriceId,
  });
}

async function handleSubscriptionDeleted(
  subscription: Stripe.Subscription
): Promise<void> {
  const userId = subscription.metadata?.userId;
  if (!userId) {
    console.warn('customer.subscription.deleted: no userId in metadata');
    return;
  }

  const timestamp = new Date().toISOString();

  await ddb.send(
    new UpdateCommand({
      TableName: SUBSCRIPTIONS_TABLE,
      Key: { userId },
      UpdateExpression:
        'SET #status = :status, endedAt = :endedAt, updatedAt = :updatedAt',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':status': 'cancelled',
        ':endedAt': timestamp,
        ':updatedAt': timestamp,
      },
    })
  );

  console.log('customer.subscription.deleted processed', {
    userId,
    subscriptionId: subscription.id,
  });
}

/* ---------- Main handler ---------- */

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {
    console.log('Stripe webhook received', {
      httpMethod: event.httpMethod,
      path: event.path,
    });

    // Get raw body for signature verification (handle API Gateway base64 encoding)
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body || '', 'base64').toString('utf-8')
      : (event.body || '');
    const signature =
      event.headers['stripe-signature'] || event.headers['Stripe-Signature'] || '';

    if (!signature) {
      console.error('Missing stripe-signature header');
      return {
        statusCode: 400,
        body: JSON.stringify({
          data: null,
          error: { code: 'MISSING_SIGNATURE', message: 'Missing stripe-signature header' },
          meta: null,
        }),
      };
    }

    // Fetch secrets and construct Stripe event
    const [webhookSecret, stripe] = await Promise.all([
      getWebhookSecret(),
      getStripeClient(),
    ]);

    let stripeEvent: Stripe.Event;
    try {
      stripeEvent = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    } catch (err: any) {
      console.error('Webhook signature verification failed', { error: err.message });
      return {
        statusCode: 400,
        body: JSON.stringify({
          data: null,
          error: { code: 'INVALID_SIGNATURE', message: 'Webhook signature verification failed' },
          meta: null,
        }),
      };
    }

    console.log('Processing Stripe event', {
      type: stripeEvent.type,
      id: stripeEvent.id,
    });

    // Route events to handlers
    switch (stripeEvent.type) {
      case 'checkout.session.completed': {
        const session = stripeEvent.data.object as Stripe.Checkout.Session;
        await handleCheckoutSessionCompleted(session, stripe);
        break;
      }

      case 'invoice.paid': {
        const invoice = stripeEvent.data.object as Stripe.Invoice;
        await handleInvoicePaid(invoice, stripe);
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = stripeEvent.data.object as Stripe.Invoice;
        await handleInvoicePaymentFailed(invoice, stripe);
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = stripeEvent.data.object as Stripe.Subscription;
        await handleSubscriptionUpdated(subscription);
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = stripeEvent.data.object as Stripe.Subscription;
        await handleSubscriptionDeleted(subscription);
        break;
      }

      default:
        console.log('Unhandled Stripe event type', { type: stripeEvent.type });
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        data: { message: 'Webhook processed successfully' },
        error: null,
        meta: null,
      }),
    };
  } catch (error: any) {
    console.error('Error processing Stripe webhook:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        data: null,
        error: { code: 'WEBHOOK_PROCESSING_FAILED', message: 'Failed to process webhook' },
        meta: null,
      }),
    };
  }
};
