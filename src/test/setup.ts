import { vi } from 'vitest';

// Handler tests build events with an unsigned Bearer token. In production the Hono app verifies the token and
// fills requestContext.authorizer.jwt.claims; this stand-in reproduces that step for the tests only.
function claimsFromEvent(event: any): Record<string, string> {
  const claims = event?.requestContext?.authorizer?.jwt?.claims;
  if (claims) return claims;
  const header = event?.headers?.authorization || event?.headers?.Authorization;
  if (!header) return {};
  try {
    const payload = header.replace(/^Bearer\s+/i, '').split('.')[1];
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return {};
  }
}

vi.mock('../shared/auth', () => ({
  getClaims: claimsFromEvent,
  getUserId: (event: any) => claimsFromEvent(event).sub || undefined,
}));
