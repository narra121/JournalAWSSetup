import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { ddb } from '../../shared/dynamo';
import { PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { errorResponse, envelope, ErrorCodes } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';
import { getUserId } from '../../shared/auth';
import { checkSubscription } from '../../shared/subscription';

const SAVED_OPTIONS_TABLE = process.env.SAVED_OPTIONS_TABLE!;

const validCategories = ['symbols', 'strategies', 'sessions', 'marketConditions', 'newsEvents', 'mistakes', 'lessons', 'timeframes'];

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const userId = getUserId(event);
  const log = makeLogger({ requestId: event.requestContext.requestId, userId });
  
  log.info('update-saved-options invoked');
  
  if (!userId) {
    log.warn('unauthorized request');
    return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');
  }

  const subError = await checkSubscription(userId);
  if (subError) return subError;

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

  // Validate that all provided categories are valid
  for (const key of Object.keys(data)) {
    if (key !== 'userId' && key !== 'updatedAt' && key !== 'createdAt' && !validCategories.includes(key)) {
      log.warn('invalid category in update', { category: key });
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, `Invalid category: ${key}`);
    }
    
    // Validate that each category value is an array of strings
    if (validCategories.includes(key)) {
      if (!Array.isArray(data[key])) {
        log.warn('category must be array', { category: key });
        return errorResponse(400, ErrorCodes.VALIDATION_ERROR, `Category ${key} must be an array`);
      }
      
      for (const item of data[key]) {
        if (typeof item !== 'string') {
          log.warn('category items must be strings', { category: key });
          return errorResponse(400, ErrorCodes.VALIDATION_ERROR, `All items in ${key} must be strings`);
        }
      }
    }
  }

  try {
    // Read existing item first to merge
    const existingResult = await ddb.send(new GetCommand({
      TableName: SAVED_OPTIONS_TABLE,
      Key: { userId }
    }));
    const existing = existingResult.Item || {};

    const options = {
      userId,
      symbols: data.symbols ?? existing.symbols ?? [],
      strategies: data.strategies ?? existing.strategies ?? [],
      sessions: data.sessions ?? existing.sessions ?? [],
      marketConditions: data.marketConditions ?? existing.marketConditions ?? [],
      newsEvents: data.newsEvents ?? existing.newsEvents ?? [],
      mistakes: data.mistakes ?? existing.mistakes ?? [],
      lessons: data.lessons ?? existing.lessons ?? [],
      timeframes: data.timeframes ?? existing.timeframes ?? [],
      updatedAt: new Date().toISOString()
    };

    await ddb.send(new PutCommand({
      TableName: SAVED_OPTIONS_TABLE,
      Item: options
    }));

    log.info('saved options updated');

    return envelope({ statusCode: 200, data: options, message: 'Saved options updated' });
  } catch (error: any) {
    log.error('failed to update saved options', { error: error.message });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to update saved options');
  }
};
