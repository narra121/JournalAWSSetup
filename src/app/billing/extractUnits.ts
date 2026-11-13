/** Most images one extract request may carry (src/handlers/extract-trades). */
const MAX_IMAGES = 3;

/**
 * Quota units of a `POST /v1/trades/extract` body: one per image, because each image is its own model call.
 * A text request, a single `imageBase64` and anything unreadable count as one.
 */
export function extractUnits(rawBody: string | undefined): number {
  let body: any;
  try {
    body = JSON.parse(rawBody ?? '');
  } catch {
    return 1;
  }
  if (body?.textContent || typeof body?.imageBase64 === 'string') return 1;
  return Array.isArray(body?.images) ? Math.min(MAX_IMAGES, Math.max(1, body.images.length)) : 1;
}
