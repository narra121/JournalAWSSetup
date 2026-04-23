import { describe, it, expect } from 'vitest';
import { signAdminToken, verifyAdminToken } from '../admin-jwt';

const SECRET = 'test-secret-256-bit-key-for-testing';

describe('signAdminToken', () => {
  it('returns a JWT string', () => {
    const token = signAdminToken(SECRET);
    expect(typeof token).toBe('string');
    expect(token.split('.')).toHaveLength(3);
  });
});

describe('verifyAdminToken', () => {
  it('returns payload for valid token', () => {
    const token = signAdminToken(SECRET);
    const payload = verifyAdminToken(token, SECRET);
    expect(payload).not.toBeNull();
    expect(payload!.role).toBe('admin');
  });

  it('returns null for expired token', () => {
    const jwt = require('jsonwebtoken');
    const token = jwt.sign({ role: 'admin' }, SECRET, { expiresIn: -1 });
    const payload = verifyAdminToken(token, SECRET);
    expect(payload).toBeNull();
  });

  it('returns null for wrong secret', () => {
    const token = signAdminToken(SECRET);
    const payload = verifyAdminToken(token, 'wrong-secret');
    expect(payload).toBeNull();
  });

  it('returns null for garbage string', () => {
    const payload = verifyAdminToken('not.a.jwt', SECRET);
    expect(payload).toBeNull();
  });
});
