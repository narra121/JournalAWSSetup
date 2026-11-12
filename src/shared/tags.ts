export const MAX_TAGS = 10;
export const MAX_TAG_LENGTH = 24;

/** Error message for an invalid `tags` value (at most 10 strings of 1-24 characters), or null when it is valid. */
export function tagsError(tags: unknown): string | null {
  if (!Array.isArray(tags)) return 'tags must be an array';
  if (tags.length > MAX_TAGS) return `A trade can have at most ${MAX_TAGS} tags`;
  if (tags.some((t) => typeof t !== 'string' || t.length < 1 || t.length > MAX_TAG_LENGTH)) {
    return `Each tag must be 1-${MAX_TAG_LENGTH} characters`;
  }
  return null;
}
