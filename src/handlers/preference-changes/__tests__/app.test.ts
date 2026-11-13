import { marshall } from '@aws-sdk/util-dynamodb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rebuildForUser = vi.fn();
vi.mock('../../rebuild-stats-job/app', () => ({ rebuildForUser: (...a: any[]) => rebuildForUser(...a) }));

const { handlePreferenceChanges } = await import('../app');

const rec = (eventName: string, oldImage: any, newImage: any, seq = 's1') => ({
  eventName,
  dynamodb: { SequenceNumber: seq, OldImage: oldImage && marshall(oldImage), NewImage: newImage && marshall(newImage) },
});

beforeEach(() => {
  rebuildForUser.mockReset().mockResolvedValue(undefined);
});

describe('handlePreferenceChanges (time zone changed → rebuild once)', () => {
  it('rebuilds the user when timeZone is set or changed', async () => {
    const res = await handlePreferenceChanges({ Records: [
      rec('INSERT', undefined, { userId: 'a', timeZone: 'Asia/Kolkata' }, 's1'),
      rec('MODIFY', { userId: 'b', timeZone: 'UTC' }, { userId: 'b', timeZone: 'Asia/Tokyo' }, 's2'),
    ] });
    expect(rebuildForUser.mock.calls.map((c) => c[0])).toEqual(['a', 'b']);
    // A zone change moves hours and days without changing any trade hash, so every day record is rewritten.
    expect(rebuildForUser.mock.calls.every((c) => c[1]?.force === true)).toBe(true);
    expect(res.batchItemFailures).toEqual([]);
  });

  it('ignores other preference changes, removals and an unchanged zone', async () => {
    await handlePreferenceChanges({ Records: [
      rec('MODIFY', { userId: 'a', timeZone: 'Asia/Kolkata', darkMode: false }, { userId: 'a', timeZone: 'Asia/Kolkata', darkMode: true }),
      rec('REMOVE', { userId: 'a', timeZone: 'Asia/Kolkata' }, undefined),
      rec('INSERT', undefined, { userId: 'c', darkMode: true }),
    ] });
    expect(rebuildForUser).not.toHaveBeenCalled();
  });

  it('rebuilds once for repeated records of the same change, and reports a failed rebuild for retry', async () => {
    rebuildForUser.mockRejectedValue(new Error('throttled'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await handlePreferenceChanges({ Records: [
      rec('MODIFY', { userId: 'a', timeZone: 'UTC' }, { userId: 'a', timeZone: 'Asia/Kolkata' }, 's1'),
      rec('MODIFY', { userId: 'a', timeZone: 'UTC' }, { userId: 'a', timeZone: 'Asia/Kolkata' }, 's2'),
    ] });
    spy.mockRestore();
    expect(rebuildForUser).toHaveBeenCalledTimes(1);
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 's1' }]);
  });
});
