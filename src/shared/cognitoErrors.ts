import { ErrorCodes, errorResponse } from './validation';
import { PASSWORD_MIN } from './passwordValidation';

export type AuthCall = 'login' | 'signup' | 'confirm-signup' | 'forgot-password' | 'confirm-forgot-password' | 'refresh';

const CODE_INVALID = 'Invalid verification code. Check the email and enter it again.';
const BAD_LOGIN = 'Invalid email or password';

/**
 * A Cognito failure as an API error. Cognito's own wording is never sent: it is matched on `name` (and the `USER_EXISTS` marker), logged by the
 * caller, and answered with a sentence for the user; an unknown failure keeps the 400 these handlers always returned.
 */
export function cognitoFailure(e: { name?: string; message?: string } | undefined, call: AuthCall) {
  if (e instanceof SyntaxError) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'The request body must be valid JSON.');
  switch (e?.name) {
    case 'TooManyRequestsException':
    case 'LimitExceededException':
    case 'TooManyFailedAttemptsException':
      return errorResponse(429, ErrorCodes.RATE_LIMITED, 'Too many attempts. Please wait a few minutes and try again.');
    case 'CodeMismatchException':
      return errorResponse(400, ErrorCodes.CODE_INVALID, CODE_INVALID);
    case 'ExpiredCodeException':
      return errorResponse(400, ErrorCodes.CODE_EXPIRED, 'That verification code has expired. Request a code again.');
    case 'UserNotConfirmedException':
      if (call !== 'login') break;
      return errorResponse(403, ErrorCodes.EMAIL_NOT_VERIFIED, 'Please verify your email before logging in. Check your inbox for the verification code.');
    case 'UserLambdaValidationException':
      // The Pre sign-up trigger's refusal (auth-pre-signup); its other failures stay generic.
      if (e?.message?.includes('USER_EXISTS')) return errorResponse(400, ErrorCodes.USER_EXISTS, 'An account with this email already exists. Please login instead.');
      break;
    case 'UserNotFoundException':
      if (call === 'refresh') break;
      if (call === 'login') return errorResponse(400, ErrorCodes.UNAUTHORIZED, BAD_LOGIN);
      return errorResponse(400, ErrorCodes.CODE_INVALID, CODE_INVALID);
    case 'NotAuthorizedException':
      if (call === 'refresh') break;
      if (call === 'login') return errorResponse(400, ErrorCodes.UNAUTHORIZED, BAD_LOGIN);
      if (call === 'confirm-signup') return errorResponse(400, ErrorCodes.ALREADY_CONFIRMED, 'This email is already confirmed. You can log in.');
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, "We couldn't reset that password. Request a new code and try again.");
    case 'InvalidPasswordException':
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, `Choose a stronger password: at least ${PASSWORD_MIN} characters with upper and lower case letters, a number and a symbol.`);
    case 'InvalidParameterException':
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, call === 'signup' ? 'Check your email address and name, then try again.' : 'Check what you entered and try again.');
  }
  if (call === 'refresh') return errorResponse(400, ErrorCodes.UNAUTHORIZED, 'Your session has ended. Please log in again.');
  return errorResponse(400, ErrorCodes.VALIDATION_ERROR, "We couldn't complete that request. Please try again.");
}
