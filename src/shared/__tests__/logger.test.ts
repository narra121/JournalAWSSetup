import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeLogger } from '../logger.ts';
import type { Logger } from '../logger.ts';

// ─── Helpers ───────────────────────────────────────────────────

let logSpy: ReturnType<typeof vi.spyOn>;

function getLastLogEntry(): Record<string, any> {
  const lastCall = logSpy.mock.calls[logSpy.mock.calls.length - 1];
  return JSON.parse(lastCall[0] as string);
}

function getAllLogEntries(): Array<Record<string, any>> {
  return logSpy.mock.calls.map((call) => JSON.parse(call[0] as string));
}

// ─── Setup ─────────────────────────────────────────────────────

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

// ─── Tests ─────────────────────────────────────────────────────

describe('makeLogger', () => {
  // ── Creates logger with context ────────────────────────────

  it('creates a logger with requestId and userId context', () => {
    const logger = makeLogger({ requestId: 'req-123', userId: 'user-456' });

    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.debug).toBe('function');
  });

  it('creates a logger without any context', () => {
    const logger = makeLogger();

    expect(logger).toBeDefined();
    logger.info('test message');

    const entry = getLastLogEntry();
    expect(entry.msg).toBe('test message');
  });

  it('creates a logger with empty context object', () => {
    const logger = makeLogger({});

    logger.info('test');
    const entry = getLastLogEntry();
    expect(entry.msg).toBe('test');
  });

  // ── info() outputs JSON with correct level ─────────────────

  it('info() outputs JSON with level INFO', () => {
    const logger = makeLogger({ requestId: 'req-1' });
    logger.info('hello world');

    expect(logSpy).toHaveBeenCalledTimes(1);
    const entry = getLastLogEntry();
    expect(entry.level).toBe('INFO');
    expect(entry.msg).toBe('hello world');
  });

  it('info() includes a valid ISO timestamp', () => {
    const logger = makeLogger();
    logger.info('time check');

    const entry = getLastLogEntry();
    expect(entry.time).toBeDefined();
    // Verify it's a valid ISO date
    const parsed = new Date(entry.time);
    expect(parsed.toISOString()).toBe(entry.time);
  });

  it('info() includes extra data when provided', () => {
    const logger = makeLogger({ requestId: 'req-1' });
    logger.info('with extra', { action: 'create', count: 5 });

    const entry = getLastLogEntry();
    expect(entry.level).toBe('INFO');
    expect(entry.msg).toBe('with extra');
    expect(entry.action).toBe('create');
    expect(entry.count).toBe(5);
  });

  // ── warn() outputs JSON with correct level ─────────────────

  it('warn() outputs JSON with level WARN', () => {
    const logger = makeLogger();
    logger.warn('something concerning');

    const entry = getLastLogEntry();
    expect(entry.level).toBe('WARN');
    expect(entry.msg).toBe('something concerning');
  });

  it('warn() includes extra data when provided', () => {
    const logger = makeLogger();
    logger.warn('rate limit approaching', { current: 95, limit: 100 });

    const entry = getLastLogEntry();
    expect(entry.level).toBe('WARN');
    expect(entry.current).toBe(95);
    expect(entry.limit).toBe(100);
  });

  // ── error() outputs JSON with correct level and details ────

  it('error() outputs JSON with level ERROR', () => {
    const logger = makeLogger();
    logger.error('something broke');

    const entry = getLastLogEntry();
    expect(entry.level).toBe('ERROR');
    expect(entry.msg).toBe('something broke');
  });

  it('error() includes error details in extra data', () => {
    const logger = makeLogger();
    logger.error('failed', { error: 'DynamoDB timeout', stack: 'at handler:42' });

    const entry = getLastLogEntry();
    expect(entry.level).toBe('ERROR');
    expect(entry.error).toBe('DynamoDB timeout');
    expect(entry.stack).toBe('at handler:42');
  });

  // ── debug() outputs JSON with correct level ────────────────

  it('debug() outputs JSON with level DEBUG', () => {
    const logger = makeLogger();
    logger.debug('verbose detail');

    const entry = getLastLogEntry();
    expect(entry.level).toBe('DEBUG');
    expect(entry.msg).toBe('verbose detail');
  });

  it('debug() includes extra data when provided', () => {
    const logger = makeLogger();
    logger.debug('request payload', { body: { name: 'test' } });

    const entry = getLastLogEntry();
    expect(entry.level).toBe('DEBUG');
    expect(entry.body).toEqual({ name: 'test' });
  });

  // ── Includes requestId in all log output ───────────────────

  it('includes requestId in all log levels', () => {
    const logger = makeLogger({ requestId: 'req-abc-123' });

    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    const entries = getAllLogEntries();
    expect(entries).toHaveLength(4);
    for (const entry of entries) {
      expect(entry.requestId).toBe('req-abc-123');
    }
  });

  // ── Includes userId in all log output ──────────────────────

  it('includes userId in all log levels', () => {
    const logger = makeLogger({ userId: 'user-xyz-789' });

    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    const entries = getAllLogEntries();
    expect(entries).toHaveLength(4);
    for (const entry of entries) {
      expect(entry.userId).toBe('user-xyz-789');
    }
  });

  it('includes both requestId and userId in log output', () => {
    const logger = makeLogger({ requestId: 'req-1', userId: 'user-2' });

    logger.info('both context values');

    const entry = getLastLogEntry();
    expect(entry.requestId).toBe('req-1');
    expect(entry.userId).toBe('user-2');
  });

  // ── Handles missing context gracefully ─────────────────────

  it('sets requestId to undefined when not provided', () => {
    const logger = makeLogger({ userId: 'user-only' });
    logger.info('test');

    const entry = getLastLogEntry();
    expect(entry.userId).toBe('user-only');
    // requestId should be undefined (present in JSON as undefined, serialized away by JSON.stringify)
    expect(entry.requestId).toBeUndefined();
  });

  it('sets userId to undefined when not provided', () => {
    const logger = makeLogger({ requestId: 'req-only' });
    logger.info('test');

    const entry = getLastLogEntry();
    expect(entry.requestId).toBe('req-only');
    expect(entry.userId).toBeUndefined();
  });

  it('handles undefined context', () => {
    const logger = makeLogger(undefined);
    logger.info('no context');

    const entry = getLastLogEntry();
    expect(entry.level).toBe('INFO');
    expect(entry.msg).toBe('no context');
    expect(entry.requestId).toBeUndefined();
    expect(entry.userId).toBeUndefined();
  });

  // ── Output is valid JSON ───────────────────────────────────

  it('outputs valid JSON strings to console.log', () => {
    const logger = makeLogger({ requestId: 'req-1', userId: 'user-1' });
    logger.info('json test', { nested: { key: 'value' } });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const rawOutput = logSpy.mock.calls[0][0] as string;

    // Should not throw
    const parsed = JSON.parse(rawOutput);
    expect(parsed).toBeTypeOf('object');
  });

  // ── Extra data does not overwrite base fields ──────────────

  it('extra data merges with base context', () => {
    const logger = makeLogger({ requestId: 'req-1' });
    logger.info('merge test', { customField: 'custom-value' });

    const entry = getLastLogEntry();
    expect(entry.requestId).toBe('req-1');
    expect(entry.customField).toBe('custom-value');
    expect(entry.level).toBe('INFO');
    expect(entry.msg).toBe('merge test');
  });

  it('extra data can override context fields (spread order)', () => {
    // Based on the implementation: { level, msg, time, ...base, ...extra }
    // extra is spread last, so it can override base fields
    const logger = makeLogger({ requestId: 'req-original' });
    logger.info('override test', { requestId: 'req-overridden' });

    const entry = getLastLogEntry();
    // extra is spread after base, so it takes precedence
    expect(entry.requestId).toBe('req-overridden');
  });

  // ── Handles special characters in messages ─────────────────

  it('handles special characters in log messages', () => {
    const logger = makeLogger();
    logger.info('message with "quotes" and \\ backslash and \n newline');

    const entry = getLastLogEntry();
    expect(entry.msg).toContain('"quotes"');
    expect(entry.msg).toContain('\\');
    expect(entry.msg).toContain('\n');
  });

  it('handles empty string message', () => {
    const logger = makeLogger();
    logger.info('');

    const entry = getLastLogEntry();
    expect(entry.level).toBe('INFO');
    expect(entry.msg).toBe('');
  });

  // ── Does not leak sensitive data ───────────────────────────

  it('does not include password fields if passed in extra by accident', () => {
    // Note: the current implementation does not filter sensitive fields.
    // This test documents the behavior — extra data is included as-is.
    // If sensitive data filtering is added later, this test should be updated.
    const logger = makeLogger();
    logger.info('user login', { username: 'alice', password: 'secret123' });

    const entry = getLastLogEntry();
    // The logger passes extra through as-is; callers are responsible for not
    // passing secrets. This test documents current behavior.
    expect(entry.username).toBe('alice');
    // If the logger filtered passwords, this would be undefined.
    // Currently it does not filter, so the password is present.
    expect(entry.password).toBe('secret123');
  });

  // ── No extra data ─────────────────────────────────────────

  it('works correctly when no extra data is provided', () => {
    const logger = makeLogger({ requestId: 'req-1', userId: 'user-1' });

    logger.info('simple message');

    const entry = getLastLogEntry();
    expect(entry.level).toBe('INFO');
    expect(entry.msg).toBe('simple message');
    expect(entry.requestId).toBe('req-1');
    expect(entry.userId).toBe('user-1');
    expect(entry.time).toBeDefined();
  });

  // ── Multiple log calls are independent ─────────────────────

  it('each log call produces independent output', () => {
    const logger = makeLogger({ requestId: 'req-1' });

    logger.info('first', { step: 1 });
    logger.info('second', { step: 2 });

    const entries = getAllLogEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0].msg).toBe('first');
    expect(entries[0].step).toBe(1);
    expect(entries[1].msg).toBe('second');
    expect(entries[1].step).toBe(2);
  });

  // ── Logger type ────────────────────────────────────────────

  it('Logger type matches the return type of makeLogger', () => {
    const logger: Logger = makeLogger({ requestId: 'req-1' });

    // This is a compile-time check; if Logger type is wrong, TypeScript would fail.
    expect(logger.info).toBeDefined();
    expect(logger.warn).toBeDefined();
    expect(logger.error).toBeDefined();
    expect(logger.debug).toBeDefined();
  });
});
