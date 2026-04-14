import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { createDefaultRules, createDefaultSavedOptions } from '../../shared/user-initialization';
import { ddb } from '../../shared/dynamo';

const SUBSCRIPTIONS_TABLE = process.env.SUBSCRIPTIONS_TABLE || 'Subscriptions-tradeflow-dev';
const TRIAL_DAYS = 30;

export const handler = async (event: any) => {
  const userId = event.request.userAttributes.sub;
  const triggerSource = event.triggerSource;

  console.log('post-confirmation trigger', { triggerSource, userId });

  // Create defaults for new user confirmations (both email and Google)
  if (triggerSource === 'PostConfirmation_ConfirmSignUp') {
    const now = new Date();
    const trialEnd = new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);

    try {
      await Promise.all([
        createDefaultRules(userId),
        createDefaultSavedOptions(userId),
        // Start 30-day free trial
        ddb.send(new PutCommand({
          TableName: SUBSCRIPTIONS_TABLE,
          Item: {
            userId,
            status: 'trial',
            trialEnd: trialEnd.toISOString(),
            trialStarted: now.toISOString(),
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
          },
          ConditionExpression: 'attribute_not_exists(userId)',
        })),
      ]);
      console.log('default rules, options, and trial created', { userId, trialEnd: trialEnd.toISOString() });
    } catch (error: any) {
      console.error('failed to create defaults', { userId, error: error.message });
      // Don't throw - let the confirmation succeed even if defaults fail
    }
  }

  return event;
};
