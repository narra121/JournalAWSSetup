import { unmarshall } from '@aws-sdk/util-dynamodb';
import { rebuildForUser } from '../rebuild-stats-job/app';

/** Stream record shape this handler reads (DynamoDB Streams, NEW_AND_OLD_IMAGES). */
interface PreferenceRecord {
  eventName?: string;
  dynamodb?: { NewImage?: Record<string, any>; OldImage?: Record<string, any>; SequenceNumber?: string };
}

/**
 * UserPreferences stream: when a user's `timeZone` changes, every day bucket, hour and weekday of their statistics moves,
 * so their daily statistics are rebuilt once. Other preference changes are ignored.
 */
export async function handlePreferenceChanges(event: { Records: PreferenceRecord[] }): Promise<{ batchItemFailures: { itemIdentifier: string }[] }> {
  const failures: { itemIdentifier: string }[] = [];
  const seen = new Set<string>();
  for (const record of event.Records) {
    if (record.eventName === 'REMOVE' || !record.dynamodb?.NewImage) continue;
    const next = unmarshall(record.dynamodb.NewImage);
    const previous = record.dynamodb.OldImage ? unmarshall(record.dynamodb.OldImage) : {};
    if ((next.timeZone ?? null) === (previous.timeZone ?? null)) continue;
    const userId = next.userId as string | undefined;
    if (!userId || seen.has(`${userId}:${next.timeZone}`)) continue;
    seen.add(`${userId}:${next.timeZone}`);
    try {
      await rebuildForUser(userId, { force: true });
      console.log(JSON.stringify({ msg: 'timezone_rebuild_done', userId, timeZone: next.timeZone ?? null }));
    } catch (err: any) {
      console.error(JSON.stringify({ msg: 'timezone_rebuild_failed', userId, error: err.message }));
      if (record.dynamodb.SequenceNumber) failures.push({ itemIdentifier: record.dynamodb.SequenceNumber });
    }
  }
  return { batchItemFailures: failures };
}
