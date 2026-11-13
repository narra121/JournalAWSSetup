import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { createDefaultRules, createDefaultSavedOptions } from '../../shared/user-initialization';
import { ddb } from '../../shared/dynamo';

const SUBSCRIPTIONS_TABLE = process.env.SUBSCRIPTIONS_TABLE!;
const TRIAL_DAYS = 14;

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
      // Start 14-day free trial
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
    const TRIAL = 2;
    // A trial row that already exists is not a failure (a repeated confirmation).
    const trialExists = (r: PromiseSettledResult<unknown>) => r.status === 'rejected' && r.reason?.name === 'ConditionalCheckFailedException';
    results.forEach((r, i) => {
      if (r.status === 'rejected' && !(i === TRIAL && trialExists(r))) {
        console.error(`${labels[i]} failed`, { userId, error: r.reason?.message || r.reason });
      }
    });
    console.log('post-confirmation init complete', { userId, trialEnd: trialEnd.toISOString(), results: results.map((r, i) => `${labels[i]}:${r.status}`) });

    // Without the trial row the user stays on Free for good; failing the trigger makes Cognito fail the confirmation so it is retried.
    const trial = results[TRIAL];
    if (trial.status === 'rejected' && !trialExists(trial)) throw trial.reason;
  }

  return event;
};
