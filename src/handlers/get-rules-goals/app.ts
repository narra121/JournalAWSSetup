import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { ddb } from '../../shared/dynamo';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { errorResponse, envelope, ErrorCodes } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';
import { v4 as uuid } from 'uuid';
import { batchWritePutAll } from '../../shared/batchWrite';

const RULES_TABLE = process.env.RULES_TABLE!;
const GOALS_TABLE = process.env.GOALS_TABLE!;

const DEFAULT_RULES = [
  'Never risk more than 1% per trade',
  'Always set stop loss before entry',
  'No trading during high-impact news',
  'Wait for confirmation before entry',
  'Review trades weekly',
  'Stick to my trading plan'
];

async function ensureDefaultRules(userId: string, existingRules: any[]): Promise<any[]> {
  if (existingRules.length > 0) {
    return existingRules; // User already has rules
  }

  // Create default rules
  const now = new Date().toISOString();
  const rules = DEFAULT_RULES.map(ruleText => ({
    userId,
    ruleId: uuid(),
    rule: ruleText,
    completed: false,
    isActive: true,
    createdAt: now,
    updatedAt: now
  }));

  // Batch write all default rules
  await batchWritePutAll({ ddb, tableName: RULES_TABLE, items: rules });

  console.log('Default rules created', { userId, count: rules.length });
  return rules;
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const rc: any = event.requestContext as any;
  const claims = rc?.authorizer?.jwt?.claims || {};
  const userId = claims.sub;
  const log = makeLogger({ requestId: event.requestContext.requestId, userId });
  
  log.info('get-rules-goals invoked');
  
  if (!userId) {
    log.warn('unauthorized request');
    return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');
  }

  if (!RULES_TABLE || !GOALS_TABLE) {
    log.error('rules/goals table env vars are not configured', {
      hasRulesTable: !!RULES_TABLE,
      hasGoalsTable: !!GOALS_TABLE
    });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Rules/goals tables are not configured');
  }

  try {
    // Fetch rules and goals in parallel
    const [rulesResult, goalsResult] = await Promise.all([
      ddb.send(new QueryCommand({
        TableName: RULES_TABLE,
        KeyConditionExpression: 'userId = :userId',
        ExpressionAttributeValues: { ':userId': userId }
      })),
      ddb.send(new QueryCommand({
        TableName: GOALS_TABLE,
        KeyConditionExpression: 'userId = :userId',
        ExpressionAttributeValues: { ':userId': userId }
      }))
    ]);

    let rules = rulesResult.Items || [];
    const goals = goalsResult.Items || [];

    // Ensure user has default rules if none exist
    rules = await ensureDefaultRules(userId, rules);

    log.info('rules and goals fetched', { 
      rulesCount: rules.length, 
      goalsCount: goals.length 
    });
    
    return envelope({ 
      statusCode: 200, 
      data: { 
        rules,
        goals,
        meta: {
          rulesCount: rules.length,
          goalsCount: goals.length
        }
      },
      message: 'Rules and goals retrieved'
    });
  } catch (error: any) {
    log.error('failed to fetch rules and goals', { error: error.message });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to retrieve rules and goals');
  }
};
