import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { CognitoIdentityProviderClient, ConfirmSignUpCommand, AdminGetUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { ddb } from '../../shared/dynamo';
import { BatchWriteCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuid } from 'uuid';
import { envelope, errorResponse, ErrorCodes } from '../../shared/validation';

const client = new CognitoIdentityProviderClient({});
const CLIENT_ID = process.env.USER_POOL_CLIENT_ID!;
const USER_POOL_ID = process.env.USER_POOL_ID!;
const RULES_TABLE = process.env.RULES_TABLE!;
const SAVED_OPTIONS_TABLE = process.env.SAVED_OPTIONS_TABLE!;

const DEFAULT_RULES = [
  'Never risk more than 1% per trade',
  'Always set stop loss before entry',
  'No trading during high-impact news',
  'Wait for confirmation before entry',
  'Review trades weekly',
  'Stick to my trading plan'
];

const DEFAULT_SAVED_OPTIONS = {
  strategies: ['Breakout', 'Support Bounce', 'Resistance Rejection', 'Trend Continuation', 'Range Trade', 'News Trade'],
  newsEvents: ['NFP Release', 'FOMC Meeting', 'CPI Data', 'GDP Report', 'Interest Rate Decision', 'Employment Data'],
  sessions: ['Asian', 'London Open', 'London Close', 'NY Open', 'NY PM', 'London/NY Overlap'],
  marketConditions: ['Trending', 'Ranging', 'Choppy', 'High Volatility', 'Low Volatility', 'Consolidation'],
  mistakes: ['FOMO', 'Early Entry', 'Late Entry', 'Early Exit', 'Moved Stop Loss', 'Wrong Position Size', 'Revenge Trade', 'Overtrading', 'No Stop Loss'],
  symbols: [],
  lessons: [],
  timeframes: []
};

async function createDefaultRules(userId: string): Promise<void> {
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
  await ddb.send(new BatchWriteCommand({
    RequestItems: {
      [RULES_TABLE]: rules.map(rule => ({ PutRequest: { Item: rule } }))
    }
  }));
  
  console.log('Default rules created for user', { userId, count: rules.length });
}

async function createDefaultSavedOptions(userId: string): Promise<void> {
  const now = new Date().toISOString();
  
  await ddb.send(new PutCommand({
    TableName: SAVED_OPTIONS_TABLE,
    Item: {
      userId,
      ...DEFAULT_SAVED_OPTIONS,
      createdAt: now,
      updatedAt: now
    }
  }));
  
  console.log('Default saved options created for user', { userId });
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    if (!event.body) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Missing body');
    const { email, code } = JSON.parse(event.body);
    if (!email || !code) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'email and code required');
    
    await client.send(new ConfirmSignUpCommand({ ClientId: CLIENT_ID, Username: email, ConfirmationCode: code }));
    
    // Get the user's sub (userId) after confirmation
    try {
      const userDetails = await client.send(new AdminGetUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: email
      }));
      
      const userSub = userDetails.UserAttributes?.find(attr => attr.Name === 'sub')?.Value;
      if (userSub) {
        // Create default trading rules for the new user
        await createDefaultRules(userSub);
        await createDefaultSavedOptions(userSub);
      }
    } catch (err) {
      console.error('Failed to create default rules and saved options', { error: err });
      // Don't fail the confirmation if initialization fails
    }
    
    return envelope({ statusCode: 200, data: { confirmed: true }, message: 'Email verified successfully' });
  } catch (e: any) { console.error(e); return errorResponse(400, ErrorCodes.VALIDATION_ERROR, e.message || 'Confirm failed'); }
};
