import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { createDefaultRules, createDefaultSavedOptions } from '../../shared/user-initialization';
import { ddb } from '../../shared/dynamo';
import { PLANS_VERSION, TRIAL_DAYS } from '../../app/billing/entitlements';
import { sendEmail, welcomeMail } from '../../shared/email';

const SUBSCRIPTIONS_TABLE = process.env.SUBSCRIPTIONS_TABLE!;

/** Cognito fails the confirmation when this trigger runs longer than 5 s, so the welcome mail gets a short share of that. */
const WELCOME_MAIL_TIMEOUT_MS = 2000;

/** Best effort: a mail that fails or does not answer in time is logged and never fails the confirmation. */
async function sendWelcomeMail(userId: string, to: string, trialEnd: Date): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      sendEmail(welcomeMail(to, trialEnd.toISOString().slice(0, 10))),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer in ${WELCOME_MAIL_TIMEOUT_MS} ms`)), WELCOME_MAIL_TIMEOUT_MS);
      }),
    ]);
  } catch (err: any) {
    console.error('welcome mail failed', { userId, error: err?.message || err });
  } finally {
    clearTimeout(timer);
  }
}

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
      // The free trial (every Pro feature); after it the journal is read-only until Pro.
      ddb.send(new PutCommand({
        TableName: SUBSCRIPTIONS_TABLE,
        Item: {
          userId,
          status: 'trial',
          trialEnd: trialEnd.toISOString(),
          trialStarted: now.toISOString(),
          plansVersion: PLANS_VERSION,
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

    // Without the trial row the first request would start the trial later; failing the trigger makes Cognito fail the confirmation so it is retried.
    const trial = results[TRIAL];
    if (trial.status === 'rejected' && !trialExists(trial)) throw trial.reason;

    // A repeated confirmation finds the trial row and must not get the mail a second time.
    const email = event.request.userAttributes.email;
    if (trial.status === 'fulfilled' && email) await sendWelcomeMail(userId, email, trialEnd);
  }

  return event;
};
