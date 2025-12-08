import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { CognitoIdentityProviderClient, ConfirmSignUpCommand, AdminGetUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { ddb } from '../../shared/dynamo';
import { BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuid } from 'uuid';

const client = new CognitoIdentityProviderClient({});
const CLIENT_ID = process.env.USER_POOL_CLIENT_ID!;
const USER_POOL_ID = process.env.USER_POOL_ID!;
const RULES_TABLE = process.env.RULES_TABLE!;

const DEFAULT_RULES = [
  'Never risk more than 1% per trade',
  'Always set stop loss before entry',
  'No trading during high-impact news',
  'Wait for confirmation before entry',
  'Review trades weekly',
  'Stick to my trading plan'
];

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

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    if (!event.body) return resp(400, null, { code: 'INVALID_REQUEST', message: 'Missing body' });
    const { email, code } = JSON.parse(event.body);
    if (!email || !code) return resp(400, null, { code: 'INVALID_REQUEST', message: 'email and code required' });
    
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
      }
    } catch (err) {
      console.error('Failed to create default rules', { error: err });
      // Don't fail the confirmation if rule creation fails
    }
    
    return resp(200, { confirmed: true }, null);
  } catch (e: any) { console.error(e); return resp(400, null, { code: 'CONFIRM_FAILED', message: e.message || 'Confirm failed' }); }
};

function resp(statusCode: number, data: any, error: any) {
  return { statusCode, body: JSON.stringify({ data, error, meta: null }) };
}
