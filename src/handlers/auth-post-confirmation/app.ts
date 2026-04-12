import { createDefaultRules, createDefaultSavedOptions } from '../../shared/user-initialization';

export const handler = async (event: any) => {
  const userId = event.request.userAttributes.sub;
  const triggerSource = event.triggerSource;

  console.log('post-confirmation trigger', { triggerSource, userId });

  // Create defaults for new user confirmations (both email and Google)
  if (triggerSource === 'PostConfirmation_ConfirmSignUp') {
    try {
      await Promise.all([
        createDefaultRules(userId),
        createDefaultSavedOptions(userId),
      ]);
      console.log('default rules and options created', { userId });
    } catch (error: any) {
      console.error('failed to create defaults', { userId, error: error.message });
      // Don't throw - let the confirmation succeed even if defaults fail
    }
  }

  return event;
};
