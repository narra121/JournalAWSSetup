/**
 * Extract userId from API Gateway event.
 *
 * In production: API Gateway Cognito authorizer populates requestContext.authorizer.jwt.claims.sub
 * In SAM local: authorizer is not enforced, so we decode the JWT from the Authorization header directly.
 */
export function getUserId(event: any): string | undefined {
  // Production path: Cognito authorizer populates claims
  const claims = (event.requestContext as any)?.authorizer?.jwt?.claims;
  if (claims?.sub) return claims.sub;

  // SAM local fallback: decode JWT from Authorization header
  const authHeader = event.headers?.authorization || event.headers?.Authorization;
  if (!authHeader) return undefined;

  const token = authHeader.replace(/^Bearer\s+/i, '');
  try {
    const payload = token.split('.')[1];
    if (!payload) return undefined;
    const decoded = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    return decoded.sub;
  } catch {
    return undefined;
  }
}
