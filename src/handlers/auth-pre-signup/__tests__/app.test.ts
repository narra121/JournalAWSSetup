import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { CognitoIdentityProviderClient, ListUsersCommand, AdminLinkProviderForUserCommand } from '@aws-sdk/client-cognito-identity-provider';

const cognitoMock = mockClient(CognitoIdentityProviderClient);
const TEST_POOL_ID = 'us-east-1_TestPool';

const { handler } = await import('../app.ts');

beforeEach(() => {
  cognitoMock.reset();
  cognitoMock.on(ListUsersCommand).resolves({ Users: [] });
  cognitoMock.on(AdminLinkProviderForUserCommand).resolves({});
});

describe('auth-pre-signup handler', () => {
  // --- External provider (Google sign-in) ---

  it('auto-confirms and auto-verifies email for external provider', async () => {
    const event = {
      userPoolId: TEST_POOL_ID,
      triggerSource: 'PreSignUp_ExternalProvider',
      userName: 'Google_123456',
      request: { userAttributes: { email: 'google@example.com' } },
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
      request: { userAttributes: { email: 'shared@example.com' } },
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

  it('does not link when no native user exists for Google sign-in', async () => {
    cognitoMock.on(ListUsersCommand).resolves({ Users: [] });

    const event = {
      userPoolId: TEST_POOL_ID,
      triggerSource: 'PreSignUp_ExternalProvider',
      userName: 'Google_111111',
      request: { userAttributes: { email: 'new@example.com' } },
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
      request: { userAttributes: { email: 'google@example.com' } },
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
      request: { userAttributes: { email: 'fail@example.com' } },
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
      request: { userAttributes: { email: 'normal@example.com' } },
      response: {},
    };

    const result = await handler(event);

    expect(result.response.autoConfirmUser).toBeUndefined();
    expect(result.response.autoVerifyEmail).toBeUndefined();
  });

  it('auto-confirms email signup when existing Google account has same email', async () => {
    cognitoMock.on(ListUsersCommand).resolves({
      Users: [
        { Username: 'Google_444444', UserStatus: 'EXTERNAL_PROVIDER', Attributes: [{ Name: 'email', Value: 'both@example.com' }] },
      ],
    });

    const event = {
      userPoolId: TEST_POOL_ID,
      triggerSource: 'PreSignUp_SignUp',
      userName: 'email-user',
      request: { userAttributes: { email: 'both@example.com' } },
      response: {},
    };

    const result = await handler(event);

    expect(result.response.autoConfirmUser).toBe(true);
    expect(result.response.autoVerifyEmail).toBe(true);
  });

  it('does not auto-confirm email signup if ListUsers fails', async () => {
    cognitoMock.on(ListUsersCommand).rejects(new Error('Service unavailable'));

    const event = {
      userPoolId: TEST_POOL_ID,
      triggerSource: 'PreSignUp_SignUp',
      userName: 'email-user',
      request: { userAttributes: { email: 'error@example.com' } },
      response: {},
    };

    const result = await handler(event);

    // Should not auto-confirm — fall through to normal Cognito flow
    expect(result.response.autoConfirmUser).toBeUndefined();
  });

  // --- Other trigger sources ---

  it('does not auto-confirm for admin create user', async () => {
    const event = {
      userPoolId: TEST_POOL_ID,
      triggerSource: 'PreSignUp_AdminCreateUser',
      request: { userAttributes: { email: 'admin@example.com' } },
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
      request: { userAttributes: { email: 'test@example.com' } },
      response: {},
    };

    const result = await handler(event);

    expect(result).toEqual(event);
  });
});
