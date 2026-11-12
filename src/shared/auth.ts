/**
 * Caller identity comes only from `requestContext.authorizer.jwt.claims`, which the app fills after
 * verifying the Cognito token signature. The Authorization header is never decoded here.
 */
export function getUserId(event: any): string | undefined {
  return event?.requestContext?.authorizer?.jwt?.claims?.sub || undefined;
}

export function getClaims(event: any): Record<string, string> {
  return event?.requestContext?.authorizer?.jwt?.claims || {};
}
