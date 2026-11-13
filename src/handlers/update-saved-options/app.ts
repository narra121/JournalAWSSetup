import type { ApiHandler } from '../../shared/types';
import { ddb } from '../../shared/dynamo';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { errorResponse, envelope, ErrorCodes } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';
import { getUserId } from '../../shared/auth';

const SAVED_OPTIONS_TABLE = process.env.SAVED_OPTIONS_TABLE!;

const validCategories = ['symbols', 'strategies', 'sessions', 'marketConditions', 'newsEvents', 'mistakes', 'lessons', 'timeframes', 'tags'];
const MAX_TAG_LENGTH = 24;
/** Size limits of one category list and of one entry in it. */
const MAX_ENTRIES = 500;
const MAX_ENTRY_LENGTH = 200;

export const handler: ApiHandler = async (event) => {
  const userId = getUserId(event);
  const log = makeLogger({ requestId: event.requestContext.requestId, userId });
  
  log.info('update-saved-options invoked');
  
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

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Body must be a JSON object');
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
      
      if (data[key].length > MAX_ENTRIES) {
        return errorResponse(400, ErrorCodes.VALIDATION_ERROR, `${key} can have at most ${MAX_ENTRIES} entries`);
      }
      for (const item of data[key]) {
        if (typeof item !== 'string') {
          log.warn('category items must be strings', { category: key });
          return errorResponse(400, ErrorCodes.VALIDATION_ERROR, `All items in ${key} must be strings`);
        }
        if (item.length > MAX_ENTRY_LENGTH) {
          return errorResponse(400, ErrorCodes.VALIDATION_ERROR, `Entries in ${key} can have at most ${MAX_ENTRY_LENGTH} characters`);
        }
        if (key === 'tags' && item.length > MAX_TAG_LENGTH) {
          return errorResponse(400, ErrorCodes.VALIDATION_ERROR, `Tags can have at most ${MAX_TAG_LENGTH} characters`);
        }
      }
    }
  }

  try {
    // Only the categories in the request are written, so a symbol the stream added meanwhile to a category the client
    // did not send is never overwritten by an older copy of the whole item.
    const sent = validCategories.filter((c) => data[c] !== undefined);
    const names: Record<string, string> = { '#updatedAt': 'updatedAt', '#createdAt': 'createdAt' };
    const values: Record<string, unknown> = { ':now': new Date().toISOString() };
    const sets = ['#updatedAt = :now', '#createdAt = if_not_exists(#createdAt, :now)'];
    sent.forEach((category, i) => {
      names[`#c${i}`] = category;
      values[`:v${i}`] = data[category];
      sets.push(`#c${i} = :v${i}`);
    });
    const result = await ddb.send(new UpdateCommand({
      TableName: SAVED_OPTIONS_TABLE,
      Key: { userId },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    }));
    const options = Object.fromEntries(validCategories.map((c) => [c, [] as string[]]));
    Object.assign(options, result.Attributes);

    log.info('saved options updated');

    return envelope({ statusCode: 200, data: options, message: 'Saved options updated' });
  } catch (error: any) {
    log.error('failed to update saved options', { error: error.message });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to update saved options');
  }
};
