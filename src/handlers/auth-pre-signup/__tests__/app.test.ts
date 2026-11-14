import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { CognitoIdentityProviderClient, ListUsersCommand, AdminLinkProviderForUserCommand, AdminDeleteUserCommand } from '@aws-sdk/client-cognito-identity-provider';

const cognitoMock = mockClient(CognitoIdentityProviderClient);
const TEST_POOL_ID = 'us-east-1_TestPool';

const { handler } = await import('../app.ts');

beforeEach(() => {
  cognitoMock.reset();
  cognitoMock.on(ListUsersCommand).resolves({ Users: [] });
  cognitoMock.on(AdminLinkProviderForUserCommand).resolves({});
  cognitoMock.on(AdminDeleteUserCommand).resolves({});
});

describe('auth-pre-signup handler', () => {
  // --- External provider (Google sign-in) ---

  it('auto-confirms and auto-verifies email for external provider', async () => {
    const event = {
      userPoolId: TEST_POOL_ID,
      triggerSource: 'PreSignUp_ExternalProvider',
      userName: 'Google_123456',
      request: { userAttributes: { email: 'google@example.com', email_verified: 'true' } },
      response: {},
    };

    const result = await handler(event);

    expect(result.response.autoConfirmUser).toBe(true);
    expect(result.response.autoVerifyEmail).toBe(true);
  });

  it('links Google identity to existing native user with same email', async () => {
    cognitoMock.on(ListUsersCommand).resolves({
      Users: [
        { Username: 'native-user-uuid', UserStatus: 'CONFIRMED', Attributes: [{ Name: 'email', Value: 'shared@example.com' }] },
      ],
    });

    const event = {
      userPoolId: TEST_POOL_ID,
      triggerSource: 'PreSignUp_ExternalProvider',
      userName: 'Google_789012',
      request: { userAttributes: { email: 'shared@example.com', email_verified: 'true' } },
      response: {},
    };

    await handler(event);

    const linkCalls = cognitoMock.commandCalls(AdminLinkProviderForUserCommand);
    expect(linkCalls).toHaveLength(1);
    expect(linkCalls[0].args[0].input).toEqual({
      UserPoolId: TEST_POOL_ID,
      DestinationUser: {
        ProviderName: 'Cognito',
        ProviderAttributeValue: 'native-user-uuid',
      },
      SourceUser: {
        ProviderName: 'Google',
        ProviderAttributeName: 'Cognito_Subject',
        ProviderAttributeValue: '789012',
      },
    });
  });

  it('does not link to an unconfirmed native sign-up: it removes it and lets the Google user be created alone', async () => {
    cognitoMock.on(ListUsersCommand).resolves({
      Users: [{ Username: 'pending-uuid', UserStatus: 'UNCONFIRMED', Attributes: [{ Name: 'email', Value: 'victim@example.com' }] }],
    });

    const result = await handler({
      userPoolId: TEST_POOL_ID,
      triggerSource: 'PreSignUp_ExternalProvider',
      userName: 'Google_555',
      request: { userAttributes: { email: 'victim@example.com', email_verified: 'true' } },
      response: {},
    });

    expect(cognitoMock.commandCalls(AdminLinkProviderForUserCommand)).toHaveLength(0);
    const deletes = cognitoMock.commandCalls(AdminDeleteUserCommand);
    expect(deletes).toHaveLength(1);
    expect(deletes[0].args[0].input).toEqual({ UserPoolId: TEST_POOL_ID, Username: 'pending-uuid' });
    expect(result.response.autoConfirmUser).toBe(true);
  });

  it('links to the confirmed native user and removes an unconfirmed duplicate of the same email', async () => {
    cognitoMock.on(ListUsersCommand).resolves({
      Users: [
        { Username: 'pending-uuid', UserStatus: 'UNCONFIRMED', Attributes: [] },
        { Username: 'confirmed-uuid', UserStatus: 'CONFIRMED', Attributes: [] },
      ],
    });
    await handler({
      userPoolId: TEST_POOL_ID,
      triggerSource: 'PreSignUp_ExternalProvider',
      userName: 'Google_556',
      request: { userAttributes: { email: 'both@example.com', email_verified: 'true' } },
      response: {},
    });
    expect(cognitoMock.commandCalls(AdminDeleteUserCommand)).toHaveLength(1);
    expect(cognitoMock.commandCalls(AdminLinkProviderForUserCommand)[0].args[0].input.DestinationUser).toEqual({ ProviderName: 'Cognito', ProviderAttributeValue: 'confirmed-uuid' });
  });

  it('neither links nor deletes a native user in any other state (reset required, force change password)', async () => {
    cognitoMock.on(ListUsersCommand).resolves({
      Users: [{ Username: 'u1', UserStatus: 'RESET_REQUIRED', Attributes: [] }, { Username: 'u2', UserStatus: 'FORCE_CHANGE_PASSWORD', Attributes: [] }],
    });
    await handler({
      userPoolId: TEST_POOL_ID,
      triggerSource: 'PreSignUp_ExternalProvider',
      userName: 'Google_557',
      request: { userAttributes: { email: 'odd@example.com', email_verified: 'true' } },
      response: {},
    });
    expect(cognitoMock.commandCalls(AdminDeleteUserCommand)).toHaveLength(0);
    expect(cognitoMock.commandCalls(AdminLinkProviderForUserCommand)).toHaveLength(0);
  });

  it('does not link when no native user exists for Google sign-in', async () => {
    cognitoMock.on(ListUsersCommand).resolves({ Users: [] });

    const event = {
      userPoolId: TEST_POOL_ID,
      triggerSource: 'PreSignUp_ExternalProvider',
      userName: 'Google_111111',
      request: { userAttributes: { email: 'new@example.com', email_verified: 'true' } },
      response: {},
    };

    await handler(event);

    const linkCalls = cognitoMock.commandCalls(AdminLinkProviderForUserCommand);
    expect(linkCalls).toHaveLength(0);
  });

  it('skips linking when only another Google user exists (no native)', async () => {
    cognitoMock.on(ListUsersCommand).resolves({
      Users: [
        { Username: 'Google_999999', UserStatus: 'EXTERNAL_PROVIDER', Attributes: [{ Name: 'email', Value: 'google@example.com' }] },
      ],
    });

    const event = {
      userPoolId: TEST_POOL_ID,
      triggerSource: 'PreSignUp_ExternalProvider',
      userName: 'Google_222222',
      request: { userAttributes: { email: 'google@example.com', email_verified: 'true' } },
      response: {},
    };

    await handler(event);

    const linkCalls = cognitoMock.commandCalls(AdminLinkProviderForUserCommand);
    expect(linkCalls).toHaveLength(0);
  });

  it('does not block sign-in if linking fails', async () => {
    cognitoMock.on(ListUsersCommand).resolves({
      Users: [
        { Username: 'native-user', UserStatus: 'CONFIRMED', Attributes: [] },
      ],
    });
    cognitoMock.on(AdminLinkProviderForUserCommand).rejects(new Error('Link failed'));

    const event = {
      userPoolId: TEST_POOL_ID,
      triggerSource: 'PreSignUp_ExternalProvider',
      userName: 'Google_333333',
      request: { userAttributes: { email: 'fail@example.com', email_verified: 'true' } },
      response: {},
    };

    const result = await handler(event);

    // Should still return the event with auto-confirm (sign-in not blocked)
    expect(result.response.autoConfirmUser).toBe(true);
  });

  // --- Normal email/password sign-up ---

  it('does not auto-confirm for normal signup when no Google account exists', async () => {
    const event = {
      userPoolId: TEST_POOL_ID,
      triggerSource: 'PreSignUp_SignUp',
      userName: 'new-user',
      request: { userAttributes: { email: 'normal@example.com', email_verified: 'true' } },
      response: {},
    };

    const result = await handler(event);

    expect(result.response.autoConfirmUser).toBeUndefined();
    expect(result.response.autoVerifyEmail).toBeUndefined();
  });

  it('refuses an email signup when a Google account has the same email (USER_EXISTS)', async () => {
    cognitoMock.on(ListUsersCommand).resolves({
      Users: [
        { Username: 'Google_444444', UserStatus: 'EXTERNAL_PROVIDER', Attributes: [{ Name: 'email', Value: 'both@example.com' }] },
      ],
    });

    const event = {
      userPoolId: TEST_POOL_ID,
      triggerSource: 'PreSignUp_SignUp',
      userName: 'email-user',
      request: { userAttributes: { email: 'both@example.com', email_verified: 'true' } },
      response: {},
    };

    await expect(handler(event)).rejects.toThrow('USER_EXISTS');
    expect(cognitoMock.commandCalls(AdminLinkProviderForUserCommand)).toHaveLength(0);
  });

  it('refuses an email signup when a confirmed native account has the same email (USER_EXISTS)', async () => {
    cognitoMock.on(ListUsersCommand).resolves({
      Users: [{ Username: 'native-uuid', UserStatus: 'CONFIRMED', Attributes: [{ Name: 'email', Value: 'taken@example.com' }] }],
    });
    const event = {
      userPoolId: TEST_POOL_ID,
      triggerSource: 'PreSignUp_SignUp',
      userName: 'email-user',
      request: { userAttributes: { email: 'taken@example.com' } },
      response: {},
    };
    await expect(handler(event)).rejects.toThrow('USER_EXISTS');
  });

  it('lets an email signup through when the only account with that email is unconfirmed', async () => {
    cognitoMock.on(ListUsersCommand).resolves({
      Users: [{ Username: 'pending-uuid', UserStatus: 'UNCONFIRMED', Attributes: [{ Name: 'email', Value: 'pending@example.com' }] }],
    });
    const event = {
      userPoolId: TEST_POOL_ID,
      triggerSource: 'PreSignUp_SignUp',
      userName: 'email-user',
      request: { userAttributes: { email: 'pending@example.com' } },
      response: {},
    };
    const result = await handler(event);
    expect(result.response.autoConfirmUser).toBeUndefined();
  });

  it('does not link a Google identity whose email the provider did not verify', async () => {
    const event = {
      userPoolId: TEST_POOL_ID,
      triggerSource: 'PreSignUp_ExternalProvider',
      userName: 'Google_777',
      request: { userAttributes: { email: 'victim@example.com', email_verified: 'false' } },
      response: {},
    };
    await handler(event);
    expect(cognitoMock.commandCalls(ListUsersCommand)).toHaveLength(0);
    expect(cognitoMock.commandCalls(AdminLinkProviderForUserCommand)).toHaveLength(0);
  });

  it('fails the email signup (never auto-confirms) if ListUsers fails', async () => {
    cognitoMock.on(ListUsersCommand).rejects(new Error('Service unavailable'));

    const event = {
      userPoolId: TEST_POOL_ID,
      triggerSource: 'PreSignUp_SignUp',
      userName: 'email-user',
      request: { userAttributes: { email: 'error@example.com', email_verified: 'true' } },
      response: {},
    };

    await expect(handler(event)).rejects.toThrow('Service unavailable');
  });

  // --- Filter escaping: a backslash is escaped before the quote, or it would cancel the quote's escape ---

  const TRICKY_EMAIL = 'a\\"b@example.com';
  const TRICKY_FILTER = 'email = "a\\\\\\"b@example.com"';

  it('escapes backslash and quote in the ListUsers filter for an email signup', async () => {
    await handler({
      userPoolId: TEST_POOL_ID,
      triggerSource: 'PreSignUp_SignUp',
      userName: 'email-user',
      request: { userAttributes: { email: TRICKY_EMAIL } },
      response: {},
    });
    expect(cognitoMock.commandCalls(ListUsersCommand)[0].args[0].input.Filter).toBe(TRICKY_FILTER);
  });

  it('escapes backslash and quote in the ListUsers filter when linking a Google identity', async () => {
    await handler({
      userPoolId: TEST_POOL_ID,
      triggerSource: 'PreSignUp_ExternalProvider',
      userName: 'Google_888',
      request: { userAttributes: { email: TRICKY_EMAIL, email_verified: 'true' } },
      response: {},
    });
    expect(cognitoMock.commandCalls(ListUsersCommand)[0].args[0].input.Filter).toBe(TRICKY_FILTER);
  });

  // --- Other trigger sources ---

  it('does not auto-confirm for admin create user', async () => {
    const event = {
      userPoolId: TEST_POOL_ID,
      triggerSource: 'PreSignUp_AdminCreateUser',
      request: { userAttributes: { email: 'admin@example.com', email_verified: 'true' } },
      response: {},
    };

    const result = await handler(event);

    expect(result.response.autoConfirmUser).toBeUndefined();
    expect(result.response.autoVerifyEmail).toBeUndefined();
  });

  it('returns the event unchanged for non-external, non-signup triggers', async () => {
    const event = {
      userPoolId: TEST_POOL_ID,
      triggerSource: 'PreSignUp_AdminCreateUser',
      request: { userAttributes: { email: 'test@example.com', email_verified: 'true' } },
      response: {},
    };

    const result = await handler(event);

    expect(result).toEqual(event);
  });
});
