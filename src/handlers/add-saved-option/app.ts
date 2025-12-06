import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { ddb } from '../../shared/dynamo';
import { GetCommand, UpdateCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { errorResponse, envelope, ErrorCodes } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';

const SAVED_OPTIONS_TABLE = process.env.SAVED_OPTIONS_TABLE!;

const validCategories = ['symbols', 'strategies', 'sessions', 'marketConditions', 'newsEvents', 'mistakes', 'lessons', 'timeframes'];

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const rc: any = event.requestContext as any;
  const claims = rc?.authorizer?.jwt?.claims || {};
  const userId = claims.sub;
  const log = makeLogger({ requestId: event.requestContext.requestId, userId });
  
  const category = event.pathParameters?.category;
  log.info('add-saved-option invoked', { category });
  
  if (!userId) {
    log.warn('unauthorized request');
    return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');
  }

  if (!category || !validCategories.includes(category)) {
    log.warn('invalid category', { category });
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Invalid category');
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

  if (!data.value || typeof data.value !== 'string') {
    log.warn('invalid value');
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Value is required');
  }

  try {
    // Get current options
    const result = await ddb.send(new GetCommand({
      TableName: SAVED_OPTIONS_TABLE,
      Key: { userId }
    }));

    const options = result.Item || {
      userId,
      symbols: [],
      strategies: [],
      sessions: [],
      marketConditions: [],
      newsEvents: [],
      mistakes: [],
      lessons: [],
      timeframes: []
    };

    // Add new value if not already present
    const currentList = options[category] || [];
    if (!currentList.includes(data.value)) {
      currentList.push(data.value);
      options[category] = currentList;
      options.updatedAt = new Date().toISOString();

      await ddb.send(new PutCommand({
        TableName: SAVED_OPTIONS_TABLE,
        Item: options
      }));

      log.info('option added', { category, value: data.value });
    } else {
      log.info('option already exists', { category, value: data.value });
    }
    
    return envelope({ statusCode: 200, data: options });
  } catch (error: any) {
    log.error('failed to add saved option', { error: error.message });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to add saved option');
  }
};

