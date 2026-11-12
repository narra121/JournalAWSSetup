import { CognitoIdentityProviderClient, ListUsersCommand, AdminLinkProviderForUserCommand } from '@aws-sdk/client-cognito-identity-provider';

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

        // Find a native (non-federated) user with this email
        const nativeUser = existing.Users?.find(u =>
          u.UserStatus !== 'EXTERNAL_PROVIDER' &&
          !u.Username?.startsWith('google_') &&
          !u.Username?.startsWith('Google_')
        );

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
  return event;
};
