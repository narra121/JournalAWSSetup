import { describe, it, expect } from 'vitest';

const { handler } = await import('../app.ts');

describe('auth-pre-signup handler', () => {
  it('auto-confirms and auto-verifies email for external provider', async () => {
    const event = {
      triggerSource: 'PreSignUp_ExternalProvider',
      request: { userAttributes: { email: 'google@example.com' } },
      response: {},
    };

    const result = await handler(event);

    expect(result.response.autoConfirmUser).toBe(true);
    expect(result.response.autoVerifyEmail).toBe(true);
  });

  it('does not auto-confirm for normal signup', async () => {
    const event = {
      triggerSource: 'PreSignUp_SignUp',
      request: { userAttributes: { email: 'normal@example.com' } },
      response: {},
    };

    const result = await handler(event);

    expect(result.response.autoConfirmUser).toBeUndefined();
    expect(result.response.autoVerifyEmail).toBeUndefined();
  });

  it('does not auto-confirm for admin create user', async () => {
    const event = {
      triggerSource: 'PreSignUp_AdminCreateUser',
      request: { userAttributes: { email: 'admin@example.com' } },
      response: {},
    };

    const result = await handler(event);

    expect(result.response.autoConfirmUser).toBeUndefined();
    expect(result.response.autoVerifyEmail).toBeUndefined();
  });

  it('returns the event unchanged for non-external triggers', async () => {
    const event = {
      triggerSource: 'PreSignUp_SignUp',
      request: { userAttributes: { email: 'test@example.com' } },
      response: {},
    };

    const result = await handler(event);

    expect(result).toEqual(event);
  });
});
