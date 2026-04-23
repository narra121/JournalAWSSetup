import jwt from 'jsonwebtoken';

const EXPIRY = '4h';

export interface AdminTokenPayload {
  role: 'admin';
  iat: number;
  exp: number;
}

export function signAdminToken(secret: string): string {
  return jwt.sign({ role: 'admin' }, secret, { expiresIn: EXPIRY });
}

export function verifyAdminToken(token: string, secret: string): AdminTokenPayload | null {
  try {
    const payload = jwt.verify(token, secret) as AdminTokenPayload;
    if (payload.role !== 'admin') return null;
    return payload;
  } catch {
    return null;
  }
}
