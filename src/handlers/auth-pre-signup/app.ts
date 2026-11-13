import { CognitoIdentityProviderClient, ListUsersCommand, AdminLinkProviderForUserCommand, AdminDeleteUserCommand } from '@aws-sdk/client-cognito-identity-provider';

const cognito = new CognitoIdentityProviderClient({});

export const handler = async (event: any) => {
  const email = event.request?.userAttributes?.email;
  // Cognito passes the User Pool ID in the event — no env var needed (avoids circular dependency in SAM)
  const USER_POOL_ID = event.userPoolId;

  // Case 1: Google sign-in — link to existing email/password account if one exists
  if (event.triggerSource === 'PreSignUp_ExternalProvider') {
    event.response.autoConfirmUser = true;
    event.response.autoVerifyEmail = true;

    // Link only when the identity provider asserts the address is verified.
    const emailVerified = String(event.request?.userAttributes?.email_verified) === 'true';
    if (email && USER_POOL_ID && emailVerified) {
      try {
        const safeEmail = email.replace(/"/g, '\\"');
        const existing = await cognito.send(new ListUsersCommand({
          UserPoolId: USER_POOL_ID,
          Filter: `email = "${safeEmail}"`,
          Limit: 10,
        }));

        const natives = (existing.Users ?? []).filter(u =>
          u.UserStatus !== 'EXTERNAL_PROVIDER' &&
          !u.Username?.startsWith('google_') &&
          !u.Username?.startsWith('Google_')
        );

        // An unconfirmed sign-up has not proven it owns the address, so linking to it would give the Google owner's journal
        // to whoever typed that password. It holds no data: remove it and let the Google user be created on its own.
        for (const pending of natives.filter(u => u.UserStatus === 'UNCONFIRMED')) {
          await cognito.send(new AdminDeleteUserCommand({ UserPoolId: USER_POOL_ID, Username: pending.Username }));
        }
        const nativeUser = natives.find(u => u.UserStatus === 'CONFIRMED');

        if (nativeUser?.Username) {
          // Extract the Google provider sub from the external provider username
          // Format: "Google_123456789" → ProviderAttributeValue = "123456789"
          const providerSub = event.userName?.split('_').slice(1).join('_');

          if (providerSub) {
            await cognito.send(new AdminLinkProviderForUserCommand({
              UserPoolId: USER_POOL_ID,
              DestinationUser: {
                ProviderName: 'Cognito',
                ProviderAttributeValue: nativeUser.Username,
              },
              SourceUser: {
                ProviderName: 'Google',
                ProviderAttributeName: 'Cognito_Subject',
                ProviderAttributeValue: providerSub,
              },
            }));
            console.log(`Linked Google identity to existing user ${nativeUser.Username}`);
          }
        }
      } catch (err: any) {
        // Log but don't block sign-in — linking failure shouldn't prevent auth
        console.error('Failed to link Google identity to existing user', err?.message);
      }
    }

    return event;
  }

  // Email/password sign-up (PreSignUp_SignUp) is never auto-confirmed: without the confirmation code the sign-up has
  // proven no ownership of the address, even when a Google account with the same email exists.
  // It is refused when a confirmed or Google account already owns the address (clients call Cognito SignUp directly,
  // so this is where the former /auth/signup existence check lives). TradeFlow src/lib/auth/authService.ts matches the
  // message text `USER_EXISTS` in Cognito's UserLambdaValidationException.
  if (event.triggerSource === 'PreSignUp_SignUp' && email && USER_POOL_ID) {
    const safeEmail = email.replace(/"/g, '\\"');
    const existing = await cognito.send(new ListUsersCommand({
      UserPoolId: USER_POOL_ID,
      Filter: `email = "${safeEmail}"`,
      Limit: 10,
    }));
    if (existing.Users?.some(u => u.UserStatus === 'CONFIRMED' || u.UserStatus === 'EXTERNAL_PROVIDER')) {
      throw new Error('USER_EXISTS');
    }
  }
  return event;
};
