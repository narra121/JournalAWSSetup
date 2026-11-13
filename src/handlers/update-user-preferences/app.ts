import type { ApiHandler } from '../../shared/types';
import { ddb } from '../../shared/dynamo';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { errorResponse, envelope, ErrorCodes } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';
import { getUserId } from '../../shared/auth';
import { normalizeCurrency } from '../../shared/currency';
import { DEFAULT_PERIODS, WEEK_STARTS, isValidTimeZone } from '../../shared/defaults';

const USER_PREFERENCES_TABLE = process.env.USER_PREFERENCES_TABLE!;

export const handler: ApiHandler = async (event) => {
  const userId = getUserId(event);
  const log = makeLogger({ requestId: event.requestContext.requestId, userId });

  log.info('update-user-preferences invoked');

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
  if (data.timeZone !== undefined && !isValidTimeZone(data.timeZone)) {
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'timeZone must be an IANA time zone such as Asia/Kolkata');
  }
  if (data.weekStart !== undefined && !(WEEK_STARTS as readonly string[]).includes(data.weekStart)) {
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, "weekStart must be 'mon' or 'sun'");
  }
  if (data.defaultPeriod !== undefined && !(DEFAULT_PERIODS as readonly string[]).includes(data.defaultPeriod)) {
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, `defaultPeriod must be one of ${DEFAULT_PERIODS.join(', ')}`);
  }
  if (data.pnlPalette !== undefined && !(typeof data.pnlPalette === 'string' && /^[a-z0-9-]{1,24}$/.test(data.pnlPalette))) {
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'pnlPalette must be 1-24 lowercase letters, digits or dashes');
  }
  for (const field of ['darkMode', 'carryForwardGoalsRules'] as const) {
    if (data[field] !== undefined && typeof data[field] !== 'boolean') {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, `${field} must be true or false`);
    }
  }
  const currency = data.currency === undefined ? undefined : normalizeCurrency(data.currency);
  if (data.currency !== undefined && !currency) {
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'currency must be a supported ISO currency code such as USD');
  }

  try {
    const setExpressions: string[] = [];
    const expressionAttributeNames: Record<string, string> = {};
    const expressionAttributeValues: Record<string, any> = {};

    for (const field of ['timeZone', 'weekStart', 'pnlPalette', 'defaultPeriod'] as const) {
      if (data[field] !== undefined) {
        setExpressions.push(`#${field} = :${field}`);
        expressionAttributeNames[`#${field}`] = field;
        expressionAttributeValues[`:${field}`] = data[field];
      }
    }

    if (data.darkMode !== undefined) {
      setExpressions.push('#darkMode = :darkMode');
      expressionAttributeNames['#darkMode'] = 'darkMode';
      expressionAttributeValues[':darkMode'] = data.darkMode;
    }
    if (data.currency !== undefined) {
      setExpressions.push('#currency = :currency');
      expressionAttributeNames['#currency'] = 'currency';
      expressionAttributeValues[':currency'] = currency;
    }
    if (data.carryForwardGoalsRules !== undefined) {
      setExpressions.push('#carryForward = :carryForward');
      expressionAttributeNames['#carryForward'] = 'carryForwardGoalsRules';
      expressionAttributeValues[':carryForward'] = data.carryForwardGoalsRules;
    }

    setExpressions.push('#updatedAt = :updatedAt');
    expressionAttributeNames['#updatedAt'] = 'updatedAt';
    expressionAttributeValues[':updatedAt'] = new Date().toISOString();

    const result = await ddb.send(new UpdateCommand({
      TableName: USER_PREFERENCES_TABLE,
      Key: { userId },
      UpdateExpression: `SET ${setExpressions.join(', ')}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW'
    }));

    const preferences = result.Attributes;

    log.info('preferences updated');

    return envelope({ statusCode: 200, data: { preferences }, message: 'Preferences updated' });
  } catch (error: any) {
    log.error('failed to update preferences', { error: error.message });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to update preferences');
  }
};
