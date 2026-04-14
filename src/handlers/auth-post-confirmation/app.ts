import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { createDefaultRules, createDefaultSavedOptions } from '../../shared/user-initialization';
import { ddb } from '../../shared/dynamo';

const SUBSCRIPTIONS_TABLE = process.env.SUBSCRIPTIONS_TABLE!;
const TRIAL_DAYS = 30;

export const handler = async (event: any) => {
  const userId = event.request.userAttributes.sub;
  const triggerSource = event.triggerSource;

  console.log('post-confirmation trigger', { triggerSource, userId });

  // Create defaults for new user confirmations (both email and Google)
  if (triggerSource === 'PostConfirmation_ConfirmSignUp') {
    const now = new Date();
    const trialEnd = new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);

    const results = await Promise.allSettled([
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

    const labels = ['createDefaultRules', 'createDefaultSavedOptions', 'createTrialSubscription'];
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.error(`${labels[i]} failed`, { userId, error: r.reason?.message || r.reason });
      }
    });
    console.log('post-confirmation init complete', { userId, trialEnd: trialEnd.toISOString(), results: results.map((r, i) => `${labels[i]}:${r.status}`) });
  }

  return event;
};
