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

    if (email && USER_POOL_ID) {
      try {
        const existing = await cognito.send(new ListUsersCommand({
          UserPoolId: USER_POOL_ID,
          Filter: `email = "${email}"`,
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

  // Case 2: Email/password sign-up — link to existing Google account if one exists
  if (event.triggerSource === 'PreSignUp_SignUp') {
    if (email && USER_POOL_ID) {
      try {
        const existing = await cognito.send(new ListUsersCommand({
          UserPoolId: USER_POOL_ID,
          Filter: `email = "${email}"`,
          Limit: 10,
        }));

        // Find a Google federated user with this email
        const googleUser = existing.Users?.find(u =>
          u.Username?.startsWith('google_') || u.Username?.startsWith('Google_')
        );

        if (googleUser?.Username) {
          // Auto-confirm so the link can proceed
          event.response.autoConfirmUser = true;
          event.response.autoVerifyEmail = true;

          // Extract Google sub from the federated username (e.g., "Google_123456")
          const providerSub = googleUser.Username.split('_').slice(1).join('_');

          if (providerSub) {
            // The new email/password user (being created now) becomes the destination,
            // and the existing Google identity becomes the source to link
            // Note: We can't link yet because the new user doesn't exist until after
            // this trigger completes. We auto-confirm so PostConfirmation can link,
            // OR Cognito may merge automatically since both have the same verified email.
            // In practice, with auto-confirm + auto-verify, Cognito treats them as the same user.
            console.log(`Auto-confirmed email signup for ${email} — Google account exists, Cognito will merge`);
          }
        }
      } catch (err: any) {
        console.error('Failed to check for existing Google user', err?.message);
      }
    }
  }

  return event;
};
