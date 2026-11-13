import type { ApiHandler } from '../../shared/types';
import { ddb } from '../../shared/dynamo';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { errorResponse, envelope, ErrorCodes } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';
import { getUserId } from '../../shared/auth';

const ACCOUNTS_TABLE = process.env.ACCOUNTS_TABLE!;

export const handler: ApiHandler = async (event) => {
  const userId = getUserId(event);
  const log = makeLogger({ requestId: event.requestContext.requestId, userId });
  
  const accountId = event.pathParameters?.accountId;
  log.info('update-account-status invoked', { accountId });
  
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
  if (!data || typeof data !== 'object' || Array.isArray(data)) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Body must be a JSON object');

  const validStatuses = ['active', 'breached', 'passed', 'withdrawn', 'inactive'];
  if (!data.status || !validStatuses.includes(data.status)) {
    log.warn('invalid status', { status: data.status });
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Invalid status');
  }

  try {
    const now = new Date().toISOString();
    
    const result = await ddb.send(new UpdateCommand({
      TableName: ACCOUNTS_TABLE,
      Key: { userId, accountId },
      // An account deleted meanwhile must not be recreated as a stub by the update.
      ConditionExpression: 'attribute_exists(accountId)',
      UpdateExpression: 'SET #status = :status, #updatedAt = :updatedAt',
      ExpressionAttributeNames: {
        '#status': 'status',
        '#updatedAt': 'updatedAt'
      },
      ExpressionAttributeValues: {
        ':status': data.status,
        ':updatedAt': now
      },
      ReturnValues: 'ALL_NEW'
    }));

    log.info('account status updated', { accountId, status: data.status });
    
    return envelope({ statusCode: 200, data: { account: result.Attributes }, message: 'Account status updated' });
  } catch (error: any) {
    if (error.name === 'ConditionalCheckFailedException') {
      log.warn('account not found', { accountId });
      return errorResponse(404, ErrorCodes.NOT_FOUND, 'Account not found');
    }
    log.error('failed to update account status', { error: error.message });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to update account status');
  }
};
