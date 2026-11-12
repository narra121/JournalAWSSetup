export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

/** Mirrors `Policies.PasswordPolicy` of the user pool in template.yaml (the frontend shows the same list). */
export const PASSWORD_POLICY = {
  minLength: PASSWORD_MIN,
  requireLowercase: true,
  requireUppercase: true,
  requireNumbers: true,
  requireSymbols: true,
} as const;

export function validatePassword(password: string): string | null {
  if (!password || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    return `Password must be ${PASSWORD_MIN}-${PASSWORD_MAX} characters`;
  }
  return null;
}
