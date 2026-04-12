import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { ddb } from '../../shared/dynamo';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { errorResponse, envelope, ErrorCodes } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';
import { getUserId } from '../../shared/auth';

const USER_PREFERENCES_TABLE = process.env.USER_PREFERENCES_TABLE!;

/** Extract claims from the Cognito JWT (authorizer or manual decode). */
function getClaims(event: any): Record<string, string> {
  // Production: API Gateway Cognito authorizer populates claims
  const authClaims = (event.requestContext as any)?.authorizer?.jwt?.claims;
  if (authClaims) return authClaims;

  // SAM local fallback: decode JWT payload from Authorization header
  const authHeader = event.headers?.authorization || event.headers?.Authorization;
  if (!authHeader) return {};
  try {
    const payload = authHeader.replace(/^Bearer\s+/i, '').split('.')[1];
    if (!payload) return {};
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return {};
  }
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const userId = getUserId(event);
  const log = makeLogger({ requestId: event.requestContext.requestId, userId });

  log.info('get-user-profile invoked');

  if (!userId) {
    log.warn('unauthorized request');
    return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');
  }

  try {
    // Extract user info directly from the ID token claims
    // (no extra Cognito API call needed — the ID token already has email/name)
    const claims = getClaims(event);
    const userName = claims.name || '';
    const userEmail = claims.email || '';

    // Get preferences from DynamoDB
    const prefsResult = await ddb.send(new GetCommand({
      TableName: USER_PREFERENCES_TABLE,
      Key: { userId }
    }));

    const preferences = prefsResult.Item || {
      userId,
      darkMode: false,
      currency: 'USD',
      timezone: 'UTC',
      notifications: {
        tradeReminders: true,
        weeklyReport: true,
        goalAlerts: true
      }
    };

    const user = {
      id: userId,
      name: userName,
      email: userEmail,
      preferences
    };

    log.info('user profile retrieved');
    
    return envelope({ statusCode: 200, data: { user }, message: 'User profile retrieved' });
  } catch (error: any) {
    log.error('failed to get user profile', { error: error.message });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to retrieve user profile');
  }
};

