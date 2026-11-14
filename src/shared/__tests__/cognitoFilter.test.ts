import { describe, expect, it } from 'vitest';
import { cognitoFilterValue } from '../cognitoFilter';

describe('cognitoFilterValue', () => {
  it('leaves an ordinary email unchanged', () => {
    expect(cognitoFilterValue('trader+tag@example.com')).toBe('trader+tag@example.com');
  });

  it('escapes a quote', () => {
    expect(cognitoFilterValue('a"b')).toBe('a\\"b');
  });

  it('escapes a backslash', () => {
    expect(cognitoFilterValue('a\\b')).toBe('a\\\\b');
  });

  it('escapes the backslash before the quote, so a backslash-quote pair stays inside the literal', () => {
    expect(cognitoFilterValue('a\\"b')).toBe('a\\\\\\"b');
  });

  it('keeps a trailing backslash from escaping the closing quote', () => {
    expect(`"${cognitoFilterValue('a\\')}"`).toBe('"a\\\\"');
  });
});
