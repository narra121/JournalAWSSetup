import { CognitoIdentityProviderClient, ListUsersCommand } from '@aws-sdk/client-cognito-identity-provider';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubEnv('USER_POOL_ID', 'pool');

const cognito = mockClient(CognitoIdentityProviderClient);
const { findCognitoUserBySub, resolveCognitoUsername } = await import('../cognitoUser');
const { getUserEmail } = await import('../email');

const SUB = '3f2b8c1e-0000-4000-8000-123456789abc';
const googleUser = {
  Username: 'Google_1234',
  Attributes: [
    { Name: 'sub', Value: SUB },
    { Name: 'email', Value: 'g@example.com' },
  ],
};

beforeEach(() => {
  cognito.reset();
  cognito.on(ListUsersCommand).resolves({ Users: [googleUser] });
});

describe('resolveCognitoUsername (BE-003)', () => {
  it('takes the cognito:username claim of the signed-in user (ID token) without a lookup', async () => {
    expect(await resolveCognitoUsername('pool', SUB, { sub: SUB, 'cognito:username': 'Google_77' })).toBe('Google_77');
    expect(cognito.commandCalls(ListUsersCommand)).toHaveLength(0);
  });

  it('takes the username claim of an access token', async () => {
    expect(await resolveCognitoUsername('pool', SUB, { sub: SUB, username: 'Google_88' })).toBe('Google_88');
    expect(cognito.commandCalls(ListUsersCommand)).toHaveLength(0);
  });

  it('looks the user up with a sub filter when there are no claims (background jobs, admin actions)', async () => {
    expect(await resolveCognitoUsername('pool', SUB)).toBe('Google_1234');
    expect(cognito.commandCalls(ListUsersCommand)[0].args[0].input).toEqual({ UserPoolId: 'pool', Filter: `sub = "${SUB}"`, Limit: 1 });
  });

  it('looks up when the claims belong to someone else or carry no username', async () => {
    await resolveCognitoUsername('pool', SUB, { sub: 'admin', 'cognito:username': 'Google_ADMIN' });
    await resolveCognitoUsername('pool', SUB, { sub: SUB });
    expect(cognito.commandCalls(ListUsersCommand)).toHaveLength(2);
  });

  it('throws UserNotFoundException when the pool has no such user', async () => {
    cognito.on(ListUsersCommand).resolves({ Users: [] });
    await expect(resolveCognitoUsername('pool', SUB)).rejects.toMatchObject({ name: 'UserNotFoundException' });
  });

  it('never puts a quote or other filter syntax from a path parameter into the filter', async () => {
    await expect(resolveCognitoUsername('pool', 'x" or username ^= "')).rejects.toMatchObject({ name: 'UserNotFoundException' });
    expect(cognito.commandCalls(ListUsersCommand)).toHaveLength(0);
  });
});

describe('findCognitoUserBySub', () => {
  it('returns the matching user with its attributes', async () => {
    expect(await findCognitoUserBySub('pool', SUB)).toBe(googleUser);
  });
});

describe('getUserEmail', () => {
  it('finds the address of a Google-only user, whose username is not the sub', async () => {
    expect(await getUserEmail(SUB)).toBe('g@example.com');
    expect(cognito.commandCalls(ListUsersCommand)[0].args[0].input.Filter).toBe(`sub = "${SUB}"`);
  });

  it('is null for a user that no longer exists', async () => {
    cognito.on(ListUsersCommand).resolves({ Users: [] });
    expect(await getUserEmail(SUB)).toBeNull();
  });

  it('lets a Cognito outage fail the caller instead of silently skipping the mail', async () => {
    cognito.on(ListUsersCommand).rejects(new Error('throttled'));
    await expect(getUserEmail(SUB)).rejects.toThrow('throttled');
  });
});
