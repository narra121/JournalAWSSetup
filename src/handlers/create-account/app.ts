import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { ddb } from '../../shared/dynamo';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuid } from 'uuid';
import { errorResponse, envelope, ErrorCodes, formatErrors, getValidator } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';

const ACCOUNTS_TABLE = process.env.ACCOUNTS_TABLE!;

const accountSchema = {
  type: 'object',
  required: ['name', 'broker', 'type', 'status', 'balance', 'initialBalance', 'currency'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    broker: { type: 'string', minLength: 1, maxLength: 100 },
    type: { type: 'string', enum: ['prop_challenge', 'prop_funded', 'personal', 'demo'] },
    status: { type: 'string', enum: ['active', 'breached', 'passed', 'withdrawn', 'inactive'] },
    balance: { type: 'number' },
    initialBalance: { type: 'number' },
    currency: { type: 'string', minLength: 3, maxLength: 3 },
    notes: { type: 'string', maxLength: 1000 }
  }
};

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const rc: any = event.requestContext as any;
  const claims = rc?.authorizer?.jwt?.claims || {};
  const userId = claims.sub;
  const log = makeLogger({ requestId: event.requestContext.requestId, userId });
  
  log.info('create-account invoked');
  
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

  const validate = getValidator(accountSchema, 'account');
  const valid = validate(data);
  if (!valid) {
    const details = formatErrors(validate.errors);
    log.warn('validation failed', { details });
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Invalid request body', details);
  }

  try {
    const accountId = uuid();
    const now = new Date().toISOString();

    const account = {
      userId,
      accountId,
      name: data.name,
      broker: data.broker,
      type: data.type,
      status: data.status,
      balance: data.balance,
      initialBalance: data.initialBalance,
      currency: data.currency,
      notes: data.notes || null,
      createdAt: now,
      updatedAt: now
    };

    await ddb.send(new PutCommand({
      TableName: ACCOUNTS_TABLE,
      Item: account
    }));

    log.info('account created', { accountId });
    
    return envelope({ statusCode: 201, data: { account } });
  } catch (error: any) {
    log.error('failed to create account', { error: error.message });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to create account');
  }
};

