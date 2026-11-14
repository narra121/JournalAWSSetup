import { describe, expect, it } from 'vitest';
import { cognitoFailure, type AuthCall } from '../cognitoErrors';

const named = (name: string, message = 'raw Cognito text arn:aws:cognito-idp:us-east-1:123:userpool/x') => Object.assign(new Error(message), { name });
const body = (e: unknown, call: AuthCall) => {
  const res = cognitoFailure(e as any, call);
  return { status: res.statusCode, ...JSON.parse(res.body), raw: res.body };
};

describe('cognitoFailure: Cognito wording never reaches the user', () => {
  it.each([
    ['CodeMismatchException', 'confirm-signup', 400, 'CODE_INVALID', /invalid verification code/i],
    ['CodeMismatchException', 'confirm-forgot-password', 400, 'CODE_INVALID', /invalid verification code/i],
    ['UserNotFoundException', 'confirm-signup', 400, 'CODE_INVALID', /invalid verification code/i],
    ['ExpiredCodeException', 'confirm-signup', 400, 'CODE_EXPIRED', /expired.*request a code again/i],
    ['NotAuthorizedException', 'confirm-signup', 400, 'ALREADY_CONFIRMED', /already confirmed/i],
    ['NotAuthorizedException', 'confirm-forgot-password', 400, 'VALIDATION_ERROR', /request a new code/i],
    ['InvalidPasswordException', 'signup', 400, 'VALIDATION_ERROR', /stronger password/i],
    ['InvalidParameterException', 'signup', 400, 'VALIDATION_ERROR', /email address and name/i],
    ['LimitExceededException', 'confirm-signup', 429, 'RATE_LIMITED', /too many attempts/i],
    ['TooManyRequestsException', 'forgot-password', 429, 'RATE_LIMITED', /too many attempts/i],
    ['NotAuthorizedException', 'refresh', 400, 'UNAUTHORIZED', /session has ended/i],
    ['SomethingNewException', 'refresh', 400, 'UNAUTHORIZED', /session has ended/i],
    ['SomethingNewException', 'signup', 400, 'VALIDATION_ERROR', /couldn't complete that request/i],
    ['UserNotConfirmedException', 'login', 403, 'EMAIL_NOT_VERIFIED', /verify your email/i],
    ['NotAuthorizedException', 'login', 400, 'UNAUTHORIZED', /invalid email or password/i],
    ['UserNotFoundException', 'login', 400, 'UNAUTHORIZED', /invalid email or password/i],
    ['TooManyRequestsException', 'login', 429, 'RATE_LIMITED', /too many attempts/i],
    ['InternalErrorException', 'login', 400, 'VALIDATION_ERROR', /couldn't complete that request/i],
    ['UserNotConfirmedException', 'forgot-password', 400, 'VALIDATION_ERROR', /couldn't complete that request/i],
  ] as const)('%s on %s -> %i %s', (name, call, status, code, message) => {
    const b = body(named(name), call);
    expect(b.status).toBe(status);
    expect(b.errorCode).toBe(code);
    expect(b.message).toMatch(message);
    expect(b.errorMessage).toBe(b.message);
    expect(b.raw).not.toMatch(/arn:aws|Cognito|userpool/);
  });

  it('the Pre sign-up refusal USER_EXISTS is an existing-account error, not a generic failure', () => {
    const b = body(named('UserLambdaValidationException', 'PreSignUp failed with error USER_EXISTS.'), 'signup');
    expect(b.status).toBe(400);
    expect(b.errorCode).toBe('USER_EXISTS');
    expect(b.message).toMatch(/already exists/i);
    expect(b.raw).not.toMatch(/PreSignUp/);
  });

  it('any other Pre sign-up lambda failure stays generic', () => {
    const b = body(named('UserLambdaValidationException', 'PreSignUp failed with error Internal.'), 'signup');
    expect(b.errorCode).toBe('VALIDATION_ERROR');
  });

  it('malformed JSON is a 400 about the body, not a Cognito error', () => {
    const b = body(new SyntaxError('Unexpected token { in JSON at position 1'), 'signup');
    expect(b.status).toBe(400);
    expect(b.message).toBe('The request body must be valid JSON.');
    expect(b.raw).not.toContain('Unexpected token');
  });
});
