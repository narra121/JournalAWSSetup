import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { ddb } from '../../shared/dynamo';
import { UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { errorResponse, envelope, ErrorCodes, formatErrors, getValidator } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';

const ACCOUNTS_TABLE = process.env.ACCOUNTS_TABLE!;

const accountUpdateSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    broker: { type: 'string', minLength: 1, maxLength: 100 },
    type: { type: 'string', enum: ['prop_challenge', 'prop_funded', 'personal', 'demo'] },
    status: { type: 'string', enum: ['active', 'breached', 'passed', 'withdrawn', 'inactive'] },
    balance: { type: 'number' },
    initialBalance: { type: 'number' },
    currency: { type: 'string', minLength: 3, maxLength: 3 },
    notes: { type: ['string', 'null'], maxLength: 1000 }
  }
};

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const rc: any = event.requestContext as any;
  const claims = rc?.authorizer?.jwt?.claims || {};
  const userId = claims.sub;
  const log = makeLogger({ requestId: event.requestContext.requestId, userId });
  
  const accountId = event.pathParameters?.accountId;
  log.info('update-account invoked', { accountId });
  
  if (!userId) {
    log.warn('unauthorized request');
    return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');
  }

  if (!accountId) {
    log.warn('missing accountId');
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Missing accountId');
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

  const validate = getValidator(accountUpdateSchema, 'accountUpdate');
  const valid = validate(data);
  if (!valid) {
    const details = formatErrors(validate.errors);
    log.warn('validation failed', { details });
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Invalid request body', details);
  }

  try {
    // Verify account exists and belongs to user
    const existing = await ddb.send(new GetCommand({
      TableName: ACCOUNTS_TABLE,
      Key: { userId, accountId }
    }));

    if (!existing.Item) {
      log.warn('account not found', { accountId });
      return errorResponse(404, ErrorCodes.NOT_FOUND, 'Account not found');
    }

    const now = new Date().toISOString();
    const updateExpressions: string[] = [];
    const expressionAttributeNames: any = {};
    const expressionAttributeValues: any = {};
    
    let index = 0;
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) {
        const attrName = `#attr${index}`;
        const attrValue = `:val${index}`;
        updateExpressions.push(`${attrName} = ${attrValue}`);
        expressionAttributeNames[attrName] = key;
        expressionAttributeValues[attrValue] = value;
        index++;
      }
    }

    updateExpressions.push(`#updatedAt = :updatedAt`);
    expressionAttributeNames['#updatedAt'] = 'updatedAt';
    expressionAttributeValues[':updatedAt'] = now;

    const result = await ddb.send(new UpdateCommand({
      TableName: ACCOUNTS_TABLE,
      Key: { userId, accountId },
      UpdateExpression: `SET ${updateExpressions.join(', ')}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW'
    }));

    log.info('account updated', { accountId });
    
    return envelope({ statusCode: 200, data: { account: result.Attributes } });
  } catch (error: any) {
    log.error('failed to update account', { error: error.message });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to update account');
  }
};
