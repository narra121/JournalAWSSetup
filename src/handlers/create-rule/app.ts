import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { ddb } from '../../shared/dynamo';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuid } from 'uuid';
import { errorResponse, envelope, ErrorCodes } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';

const RULES_TABLE = process.env.RULES_TABLE!;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const rc: any = event.requestContext as any;
  const claims = rc?.authorizer?.jwt?.claims || {};
  const userId = claims.sub;
  const log = makeLogger({ requestId: event.requestContext.requestId, userId });
  
  log.info('create-rule invoked');
  
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

  if (!data.rule || typeof data.rule !== 'string' || data.rule.trim().length === 0) {
    log.warn('invalid rule text');
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Rule text is required');
  }

  try {
    const ruleId = uuid();
    const now = new Date().toISOString();

    const rule = {
      userId,
      ruleId,
      rule: data.rule.trim(),
      completed: false,
      isActive: true,
      createdAt: now,
      updatedAt: now
    };

    await ddb.send(new PutCommand({
      TableName: RULES_TABLE,
      Item: rule
    }));

    log.info('rule created', { ruleId });
    
    return {
      statusCode: 201,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope({ statusCode: 201, data: { rule } }))
    };
  } catch (error: any) {
    log.error('failed to create rule', { error: error.message });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to create rule');
  }
};

