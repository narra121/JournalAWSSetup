import { CognitoIdentityProviderClient, ListUsersCommand, type UserType } from '@aws-sdk/client-cognito-identity-provider';

const cognito = new CognitoIdentityProviderClient({});

/** The pool user whose `sub` is given, or undefined. */
export async function findCognitoUserBySub(userPoolId: string, sub: string): Promise<UserType | undefined> {
  if (!/^[\w-]+$/.test(sub)) return undefined;
  const res = await cognito.send(new ListUsersCommand({ UserPoolId: userPoolId, Filter: `sub = "${sub}"`, Limit: 1 }));
  return res.Users?.[0];
}

/**
 * The `Username` every Cognito Admin* call needs. A `sub` works there only for local users: a Google user's username is
 * `Google_<id>`. Pass the caller's verified `claims` when `sub` is the signed-in user (ID token `cognito:username`, access
 * token `username`); otherwise, and for background jobs and admin actions, the user is looked up by `sub`.
 * Throws `UserNotFoundException` when the pool has no such user.
 */
export async function resolveCognitoUsername(
  userPoolId: string,
  sub: string,
  claims?: Record<string, unknown>,
): Promise<string> {
  if (claims?.sub === sub) {
    const claimed = claims['cognito:username'] ?? claims.username;
    if (typeof claimed === 'string' && claimed) return claimed;
  }
  const user = await findCognitoUserBySub(userPoolId, sub);
  if (!user?.Username) throw Object.assign(new Error('User not found'), { name: 'UserNotFoundException' });
  return user.Username;
}
