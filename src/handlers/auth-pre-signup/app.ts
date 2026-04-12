export const handler = async (event: any) => {
  // Auto-confirm and verify email for federated (Google) users
  if (event.triggerSource === 'PreSignUp_ExternalProvider') {
    event.response.autoConfirmUser = true;
    event.response.autoVerifyEmail = true;
  }
  return event;
};
