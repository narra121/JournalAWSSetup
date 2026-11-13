import { UpdateCommand } from '@aws-sdk/lib-dynamodb';

/**
 * Partition of the DailyStats table that lists the users whose statistics changed since their last rebuild
 * (sort key = userId, attribute `dirtyAt`). Real user ids are Cognito subs, so it never collides with a user partition.
 */
export const STATS_DIRTY_PK = '#dirty';

/** Flags a user for the next rebuild-stats-job run; the run clears the flag only if `dirtyAt` is still the value it read. */
export async function markStatsDirty(ddb: { send: (command: any) => Promise<any> }, table: string, userId: string): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: table,
    Key: { userId: STATS_DIRTY_PK, sk: userId },
    UpdateExpression: 'SET dirtyAt = :now',
    ExpressionAttributeValues: { ':now': new Date().toISOString() },
  }));
}
