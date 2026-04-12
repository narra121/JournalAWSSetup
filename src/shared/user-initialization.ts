import { ddb } from './dynamo';
import { QueryCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuid } from 'uuid';
import { batchWritePutAll } from './batchWrite';

const RULES_TABLE = process.env.RULES_TABLE!;
const SAVED_OPTIONS_TABLE = process.env.SAVED_OPTIONS_TABLE!;

export const DEFAULT_RULES = [
  'Never risk more than 1% per trade',
  'Always set stop loss before entry',
  'No trading during high-impact news',
  'Wait for confirmation before entry',
  'Review trades weekly',
  'Stick to my trading plan'
];

export const DEFAULT_SAVED_OPTIONS = {
  strategies: ['Breakout', 'Support Bounce', 'Resistance Rejection', 'Trend Continuation', 'Range Trade', 'News Trade'],
  newsEvents: ['NFP Release', 'FOMC Meeting', 'CPI Data', 'GDP Report', 'Interest Rate Decision', 'Employment Data'],
  sessions: ['Asian', 'London Open', 'London Close', 'NY Open', 'NY PM', 'London/NY Overlap'],
  marketConditions: ['Trending', 'Ranging', 'Choppy', 'High Volatility', 'Low Volatility', 'Consolidation'],
  mistakes: ['FOMO', 'Early Entry', 'Late Entry', 'Early Exit', 'Moved Stop Loss', 'Wrong Position Size', 'Revenge Trade', 'Overtrading', 'No Stop Loss'],
  symbols: [],
  lessons: [],
  timeframes: []
};

export async function createDefaultRules(userId: string): Promise<void> {
  // Check if user already has rules (idempotent)
  const existing = await ddb.send(new QueryCommand({
    TableName: RULES_TABLE,
    KeyConditionExpression: 'userId = :userId',
    ExpressionAttributeValues: { ':userId': userId },
    Limit: 1,
  }));
  if (existing.Items && existing.Items.length > 0) return;

  const now = new Date().toISOString();
  const rules = DEFAULT_RULES.map(ruleText => ({
    userId,
    ruleId: uuid(),
    rule: ruleText,
    completed: false,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  }));
  await batchWritePutAll({ ddb, tableName: RULES_TABLE, items: rules });

  console.log('Default rules created for user', { userId, count: rules.length });
}

export async function createDefaultSavedOptions(userId: string): Promise<void> {
  // Check if user already has saved options (idempotent)
  const existing = await ddb.send(new QueryCommand({
    TableName: SAVED_OPTIONS_TABLE,
    KeyConditionExpression: 'userId = :userId',
    ExpressionAttributeValues: { ':userId': userId },
    Limit: 1,
  }));
  if (existing.Items && existing.Items.length > 0) return;

  const now = new Date().toISOString();

  await ddb.send(new PutCommand({
    TableName: SAVED_OPTIONS_TABLE,
    Item: {
      userId,
      ...DEFAULT_SAVED_OPTIONS,
      createdAt: now,
      updatedAt: now,
    },
  }));

  console.log('Default saved options created for user', { userId });
}
