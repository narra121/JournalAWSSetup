import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
  PutRetentionPolicyCommand,
} from '@aws-sdk/client-cloudwatch-logs';

const client = new CloudWatchLogsClient({});
const DEFAULT_RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS || '30', 10);

interface LogRetentionResult {
  processed: number;
  updated: number;
  skipped: number;
  errors: number;
  details: Array<{
    logGroupName: string;
    status: 'updated' | 'skipped' | 'error';
    message?: string;
  }>;
}

/**
 * Maintenance Lambda to ensure all CloudWatch log groups have a retention policy.
 * Runs on a schedule to clean up log groups that may have been created without retention.
 */
export const handler = async (): Promise<LogRetentionResult> => {
  console.log(`Setting log retention to ${DEFAULT_RETENTION_DAYS} days`);

  const result: LogRetentionResult = {
    processed: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
    details: [],
  };

  let nextToken: string | undefined;

  do {
    const response = await client.send(
      new DescribeLogGroupsCommand({ nextToken })
    );

    const logGroups = response.logGroups || [];

    for (const logGroup of logGroups) {
      result.processed++;
      const name = logGroup.logGroupName!;

      if (logGroup.retentionInDays === DEFAULT_RETENTION_DAYS) {
        result.skipped++;
        result.details.push({
          logGroupName: name,
          status: 'skipped',
          message: `Already has ${DEFAULT_RETENTION_DAYS}-day retention`,
        });
        continue;
      }

      try {
        await client.send(
          new PutRetentionPolicyCommand({
            logGroupName: name,
            retentionInDays: DEFAULT_RETENTION_DAYS,
          })
        );
        result.updated++;
        result.details.push({ logGroupName: name, status: 'updated' });
      } catch (error: any) {
        console.error(`Error setting retention for ${name}:`, error);
        result.errors++;
        result.details.push({
          logGroupName: name,
          status: 'error',
          message: error.message,
        });
      }
    }

    nextToken = response.nextToken;
  } while (nextToken);

  console.log('Log retention update complete:', JSON.stringify(result));
  return result;
};
