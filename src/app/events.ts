import { handler as postConfirmation } from '../handlers/auth-post-confirmation/app';
import { handler as preSignUp } from '../handlers/auth-pre-signup/app';
import { handler as rebuildStats } from '../handlers/rebuild-stats-job/app';
import { handlePreferenceChanges } from '../handlers/preference-changes/app';
import { defaultWeeklyDeps, runLifecycleEmails, runWeeklyReports } from '../handlers/lifecycle-emails/app';
import { handler as updateStats } from '../handlers/update-stats/app';

/** Single entry for every non-HTTP source: Cognito triggers, the Trades stream and scheduled `{job}` events. */
export const handler = async (event: any, context?: any): Promise<any> => {
  const trigger: string | undefined = event?.triggerSource;
  if (trigger?.startsWith('PreSignUp_')) return preSignUp(event);
  if (trigger?.startsWith('PostConfirmation_')) return postConfirmation(event);
  if (Array.isArray(event?.Records) && event.Records[0]?.eventSource === 'aws:dynamodb') {
    if (String(event.Records[0].eventSourceARN).includes(':table/UserPreferences-')) return handlePreferenceChanges(event);
    return (updateStats as any)(event, context, () => undefined);
  }
  if (event?.job === 'rebuild-stats') return rebuildStats();
  if (event?.job === 'lifecycle-emails') return runLifecycleEmails();
  if (event?.job === 'weekly-insights') return runWeeklyReports(await defaultWeeklyDeps());
  throw new Error(`Unsupported event: ${JSON.stringify(event).slice(0, 200)}`);
};

export { legacyExtract } from './legacy-extract';
