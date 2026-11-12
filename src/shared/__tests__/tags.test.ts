import { describe, expect, it } from 'vitest';
import { tagsError } from '../tags';

describe('tagsError', () => {
  it('accepts up to 10 tags of 1-24 characters', () => {
    expect(tagsError([])).toBeNull();
    expect(tagsError(Array.from({ length: 10 }, (_, i) => `t${i}`))).toBeNull();
    expect(tagsError(['x'.repeat(24)])).toBeNull();
  });

  it('rejects more than 10, too long, empty and non-string tags and non-arrays', () => {
    expect(tagsError(Array.from({ length: 11 }, (_, i) => `t${i}`))).toContain('at most 10');
    expect(tagsError(['x'.repeat(25)])).toContain('1-24');
    expect(tagsError([''])).toContain('1-24');
    expect(tagsError([5])).toContain('1-24');
    expect(tagsError('a')).toContain('array');
  });
});
