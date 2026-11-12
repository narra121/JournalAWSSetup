import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { describe, expect, it, vi } from 'vitest';
import { dayOf, dayRangeUtc, getUserTimeZone, hourOf, weekdayOf } from '../timezone';

describe('dayOf / hourOf', () => {
  it('moves a late-evening UTC trade to the next local day in Asia/Kolkata (UTC+5:30)', () => {
    expect(dayOf('2026-11-09T20:00:00Z', 'Asia/Kolkata')).toBe('2026-11-10');
    expect(hourOf('2026-11-09T20:00:00Z', 'Asia/Kolkata')).toBe(1);
  });

  it('moves an early-morning UTC trade to the previous local day in America/New_York', () => {
    expect(dayOf('2026-11-09T03:00:00Z', 'America/New_York')).toBe('2026-11-08');
    expect(hourOf('2026-11-09T03:00:00Z', 'America/New_York')).toBe(22);
  });

  it('a trade at 23:50 IST lands on the local day and hour 23', () => {
    expect(dayOf('2026-11-10T18:20:00Z', 'Asia/Kolkata')).toBe('2026-11-10');
    expect(hourOf('2026-11-10T18:20:00Z', 'Asia/Kolkata')).toBe(23);
  });

  it('no time zone, UTC, date-only and unparsable values are left as they are', () => {
    expect(dayOf('2026-11-09T20:00:00Z')).toBe('2026-11-09');
    expect(dayOf('2026-11-09T20:00:00Z', 'UTC')).toBe('2026-11-09');
    expect(dayOf('2026-11-09', 'Asia/Kolkata')).toBe('2026-11-09');
    expect(dayOf('garbage T value', 'Asia/Kolkata')).toBe('garbage ');
    expect(hourOf('2026-11-09', 'Asia/Kolkata')).toBeNull();
    expect(hourOf('2026-11-09T20:00:00Z')).toBe(20);
  });

  it('weekday of a calendar day', () => {
    expect(weekdayOf('2026-11-09')).toBe(1); // Monday
    expect(weekdayOf('2026-11-08')).toBe(0);
  });
});

describe('dayRangeUtc', () => {
  it('a local day in IST starts at 18:30 UTC the day before', () => {
    expect(dayRangeUtc('2026-11-10', 'Asia/Kolkata')).toEqual({ start: '2026-11-09T18:30:00.000Z', end: '2026-11-10T18:29:59.999Z' });
  });

  it('is exact on a daylight-saving change day (25 hours in New York on 2026-11-01)', () => {
    const r = dayRangeUtc('2026-11-01', 'America/New_York');
    expect(r.start).toBe('2026-11-01T04:00:00.000Z');
    expect(r.end).toBe('2026-11-02T04:59:59.999Z');
  });

  it('consecutive local days tile the timeline without gaps or overlaps', () => {
    const a = dayRangeUtc('2026-03-08', 'America/New_York'); // 23 hours (spring forward)
    const b = dayRangeUtc('2026-03-09', 'America/New_York');
    expect(Date.parse(b.start) - Date.parse(a.end)).toBe(1);
    expect(Date.parse(a.end) - Date.parse(a.start) + 1).toBe(23 * 3600 * 1000);
  });

  it('every instant belongs to exactly the day whose range contains it', () => {
    const tz = 'Asia/Kolkata';
    for (const iso of ['2026-11-09T18:29:59.999Z', '2026-11-09T18:30:00.000Z', '2026-11-10T18:29:59.000Z']) {
      const day = dayOf(iso, tz);
      const { start, end } = dayRangeUtc(day, tz);
      expect(iso >= start && iso <= end).toBe(true);
    }
  });

  it('UTC returns the date prefix for begins_with-style bounds', () => {
    expect(dayRangeUtc('2026-11-10')).toEqual({ start: '2026-11-10', end: '2026-11-10T23:59:59.999Z' });
  });
});

describe('getUserTimeZone', () => {
  const ddb = mockClient(DynamoDBDocumentClient);

  it('reads the preference with an expression alias (TIMEZONE is a DynamoDB reserved word)', async () => {
    vi.stubEnv('USER_PREFERENCES_TABLE', 'prefs');
    ddb.on(GetCommand).resolves({ Item: { timeZone: 'Asia/Kolkata' } });
    expect(await getUserTimeZone('u1')).toBe('Asia/Kolkata');
    const input = ddb.commandCalls(GetCommand)[0].args[0].input;
    expect(input.ProjectionExpression).toBe('#tz');
    expect(input.ExpressionAttributeNames).toEqual({ '#tz': 'timeZone' });
  });

  it('is null when no preference or no table is configured', async () => {
    ddb.on(GetCommand).resolves({});
    expect(await getUserTimeZone('u1')).toBeNull();
    vi.stubEnv('USER_PREFERENCES_TABLE', '');
    expect(await getUserTimeZone('u1')).toBeNull();
  });
});
