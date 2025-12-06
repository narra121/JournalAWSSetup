import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { ddb } from '../../shared/dynamo';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { errorResponse, envelope, ErrorCodes } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';

const SUBSCRIPTIONS_TABLE = process.env.SUBSCRIPTIONS_TABLE!;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const rc: any = event.requestContext as any;
  const claims = rc?.authorizer?.jwt?.claims || {};
  const userId = claims.sub;
  const log = makeLogger({ requestId: event.requestContext.requestId, userId });
  
  log.info('create-subscription invoked');
  
  if (!userId) {
    log.warn('unauthorized request');
    return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');
  }

  if (!event.body) {
    log.warn('missing body');
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Missing body');
  }

  let data: any;
  try {
    data = JSON.parse(event.body);
  } catch (e) {
    log.warn('invalid json', { error: (e as any)?.message });
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Invalid JSON');
  }

  if (!data.amount || !data.billingCycle) {
    log.warn('missing required fields');
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Amount and billingCycle are required');
  }

  try {
    const now = new Date();
    const nextBilling = new Date(now);
    if (data.billingCycle === 'annual') {
      nextBilling.setFullYear(nextBilling.getFullYear() + 1);
    } else {
      nextBilling.setMonth(nextBilling.getMonth() + 1);
    }

    const subscription = {
      userId,
      status: 'active',
      plan: data.amount >= 60 ? 'champion' : data.amount >= 36 ? 'supporter' : 'basic',
      amount: data.amount,
      billingCycle: data.billingCycle,
      nextBillingDate: nextBilling.toISOString(),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    };

    await ddb.send(new PutCommand({
      TableName: SUBSCRIPTIONS_TABLE,
      Item: subscription
    }));

    // In a real implementation, you would integrate with a payment processor here
    // and return a payment URL
    const paymentUrl = `https://payment-processor.example.com/checkout?userId=${userId}&amount=${data.amount}`;

    log.info('subscription created', { amount: data.amount, billingCycle: data.billingCycle });
    
    return envelope({ statusCode: 201, data: { subscription, paymentUrl } });
  } catch (error: any) {
    log.error('failed to create subscription', { error: error.message });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to create subscription');
  }
};

