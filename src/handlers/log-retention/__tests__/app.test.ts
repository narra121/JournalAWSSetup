import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
  PutRetentionPolicyCommand,
} from '@aws-sdk/client-cloudwatch-logs';

// ─── Env vars (before handler import) ──────────────────────────
vi.stubEnv('RETENTION_DAYS', '30');

const cwlMock = mockClient(CloudWatchLogsClient);

const { handler } = await import('../app.ts');

// ─── Tests ─────────────────────────────────────────────────────

beforeEach(() => {
  cwlMock.reset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('log-retention handler', () => {
  // ── Successful retention update ────────────────────────────

  it('updates retention for log groups without the target retention', async () => {
    cwlMock.on(DescribeLogGroupsCommand).resolves({
      logGroups: [
        { logGroupName: '/aws/lambda/func-a', retentionInDays: undefined },
        { logGroupName: '/aws/lambda/func-b', retentionInDays: 7 },
      ],
    });
    cwlMock.on(PutRetentionPolicyCommand).resolves({});

    const result = await handler();

    expect(result.processed).toBe(2);
    expect(result.updated).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);

    const putCalls = cwlMock.commandCalls(PutRetentionPolicyCommand);
    expect(putCalls).toHaveLength(2);
    expect(putCalls[0].args[0].input).toEqual({
      logGroupName: '/aws/lambda/func-a',
      retentionInDays: 30,
    });
    expect(putCalls[1].args[0].input).toEqual({
      logGroupName: '/aws/lambda/func-b',
      retentionInDays: 30,
    });
  });

  it('returns detailed results for each processed log group', async () => {
    cwlMock.on(DescribeLogGroupsCommand).resolves({
      logGroups: [
        { logGroupName: '/aws/lambda/func-a', retentionInDays: undefined },
      ],
    });
    cwlMock.on(PutRetentionPolicyCommand).resolves({});

    const result = await handler();

    expect(result.details).toHaveLength(1);
    expect(result.details[0]).toEqual({
      logGroupName: '/aws/lambda/func-a',
      status: 'updated',
    });
  });

  // ── No log groups to process ───────────────────────────────

  it('completes successfully when there are no log groups', async () => {
    cwlMock.on(DescribeLogGroupsCommand).resolves({
      logGroups: [],
    });

    const result = await handler();

    expect(result.processed).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.details).toEqual([]);
    expect(cwlMock.commandCalls(PutRetentionPolicyCommand)).toHaveLength(0);
  });

  it('handles undefined logGroups array in response', async () => {
    cwlMock.on(DescribeLogGroupsCommand).resolves({
      logGroups: undefined,
    });

    const result = await handler();

    expect(result.processed).toBe(0);
    expect(result.updated).toBe(0);
  });

  // ── Log group already has correct retention (skip) ─────────

  it('skips log groups that already have the target retention', async () => {
    cwlMock.on(DescribeLogGroupsCommand).resolves({
      logGroups: [
        { logGroupName: '/aws/lambda/already-set', retentionInDays: 30 },
        { logGroupName: '/aws/lambda/needs-update', retentionInDays: 90 },
      ],
    });
    cwlMock.on(PutRetentionPolicyCommand).resolves({});

    const result = await handler();

    expect(result.processed).toBe(2);
    expect(result.updated).toBe(1);
    expect(result.skipped).toBe(1);

    // Only one PutRetentionPolicy call (for the group needing update)
    const putCalls = cwlMock.commandCalls(PutRetentionPolicyCommand);
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].args[0].input.logGroupName).toBe('/aws/lambda/needs-update');

    // Verify skip detail
    const skippedDetail = result.details.find((d) => d.status === 'skipped');
    expect(skippedDetail).toBeDefined();
    expect(skippedDetail!.logGroupName).toBe('/aws/lambda/already-set');
    expect(skippedDetail!.message).toContain('30-day retention');
  });

  it('skips all log groups when all already have correct retention', async () => {
    cwlMock.on(DescribeLogGroupsCommand).resolves({
      logGroups: [
        { logGroupName: '/aws/lambda/a', retentionInDays: 30 },
        { logGroupName: '/aws/lambda/b', retentionInDays: 30 },
        { logGroupName: '/aws/lambda/c', retentionInDays: 30 },
      ],
    });

    const result = await handler();

    expect(result.processed).toBe(3);
    expect(result.skipped).toBe(3);
    expect(result.updated).toBe(0);
    expect(cwlMock.commandCalls(PutRetentionPolicyCommand)).toHaveLength(0);
  });

  // ── Pagination of log groups ───────────────────────────────

  it('handles pagination when there are multiple pages of log groups', async () => {
    cwlMock
      .on(DescribeLogGroupsCommand)
      .resolvesOnce({
        logGroups: [
          { logGroupName: '/aws/lambda/page1-func', retentionInDays: undefined },
        ],
        nextToken: 'token-page-2',
      })
      .resolvesOnce({
        logGroups: [
          { logGroupName: '/aws/lambda/page2-func', retentionInDays: undefined },
        ],
        nextToken: 'token-page-3',
      })
      .resolvesOnce({
        logGroups: [
          { logGroupName: '/aws/lambda/page3-func', retentionInDays: undefined },
        ],
        // No nextToken — last page
      });
    cwlMock.on(PutRetentionPolicyCommand).resolves({});

    const result = await handler();

    expect(result.processed).toBe(3);
    expect(result.updated).toBe(3);

    // Verify pagination tokens were passed correctly
    const describeCalls = cwlMock.commandCalls(DescribeLogGroupsCommand);
    expect(describeCalls).toHaveLength(3);
    expect(describeCalls[0].args[0].input.nextToken).toBeUndefined();
    expect(describeCalls[1].args[0].input.nextToken).toBe('token-page-2');
    expect(describeCalls[2].args[0].input.nextToken).toBe('token-page-3');
  });

  // ── CloudWatch API failure ─────────────────────────────────

  it('throws when DescribeLogGroups fails', async () => {
    cwlMock.on(DescribeLogGroupsCommand).rejects(new Error('CloudWatch API unavailable'));

    await expect(handler()).rejects.toThrow('CloudWatch API unavailable');
  });

  // ── Permission denied on specific log group ────────────────

  it('continues processing when PutRetentionPolicy fails on one group', async () => {
    cwlMock.on(DescribeLogGroupsCommand).resolves({
      logGroups: [
        { logGroupName: '/aws/lambda/forbidden', retentionInDays: undefined },
        { logGroupName: '/aws/lambda/allowed', retentionInDays: undefined },
        { logGroupName: '/aws/lambda/also-allowed', retentionInDays: undefined },
      ],
    });

    // First call fails, remaining succeed
    cwlMock
      .on(PutRetentionPolicyCommand)
      .rejectsOnce(new Error('AccessDeniedException: User is not authorized'))
      .resolves({});

    const result = await handler();

    expect(result.processed).toBe(3);
    expect(result.updated).toBe(2);
    expect(result.errors).toBe(1);

    // Verify error detail
    const errorDetail = result.details.find((d) => d.status === 'error');
    expect(errorDetail).toBeDefined();
    expect(errorDetail!.logGroupName).toBe('/aws/lambda/forbidden');
    expect(errorDetail!.message).toContain('AccessDeniedException');
  });

  it('records errors but does not throw when all PutRetentionPolicy calls fail', async () => {
    cwlMock.on(DescribeLogGroupsCommand).resolves({
      logGroups: [
        { logGroupName: '/aws/lambda/a', retentionInDays: undefined },
        { logGroupName: '/aws/lambda/b', retentionInDays: 7 },
      ],
    });
    cwlMock.on(PutRetentionPolicyCommand).rejects(new Error('Throttled'));

    const result = await handler();

    expect(result.processed).toBe(2);
    expect(result.updated).toBe(0);
    expect(result.errors).toBe(2);
    expect(result.details.every((d) => d.status === 'error')).toBe(true);
  });

  // ── Summary of processed groups ────────────────────────────

  it('returns a complete summary with mixed results', async () => {
    cwlMock.on(DescribeLogGroupsCommand).resolves({
      logGroups: [
        { logGroupName: '/aws/lambda/ok', retentionInDays: undefined },
        { logGroupName: '/aws/lambda/already-set', retentionInDays: 30 },
        { logGroupName: '/aws/lambda/fail', retentionInDays: 14 },
      ],
    });

    // First call (ok) succeeds, second call (fail) rejects
    // already-set is skipped so only 2 PutRetentionPolicy calls happen
    cwlMock
      .on(PutRetentionPolicyCommand)
      .resolvesOnce({})
      .rejectsOnce(new Error('Error'));

    const result = await handler();

    expect(result.processed).toBe(3);
    expect(result.updated).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.errors).toBe(1);
    expect(result.details).toHaveLength(3);

    const statuses = result.details.map((d) => d.status);
    expect(statuses).toContain('updated');
    expect(statuses).toContain('skipped');
    expect(statuses).toContain('error');
  });

  // ── Large number of log groups across pages ────────────────

  it('processes many log groups across multiple pages', async () => {
    // Simulate 2 pages of 50 log groups each
    const page1Groups = Array.from({ length: 50 }, (_, i) => ({
      logGroupName: `/aws/lambda/page1-func-${i}`,
      retentionInDays: undefined,
    }));
    const page2Groups = Array.from({ length: 50 }, (_, i) => ({
      logGroupName: `/aws/lambda/page2-func-${i}`,
      retentionInDays: undefined,
    }));

    cwlMock
      .on(DescribeLogGroupsCommand)
      .resolvesOnce({ logGroups: page1Groups, nextToken: 'page2' })
      .resolvesOnce({ logGroups: page2Groups });
    cwlMock.on(PutRetentionPolicyCommand).resolves({});

    const result = await handler();

    expect(result.processed).toBe(100);
    expect(result.updated).toBe(100);
    expect(cwlMock.commandCalls(PutRetentionPolicyCommand)).toHaveLength(100);
  });
});
