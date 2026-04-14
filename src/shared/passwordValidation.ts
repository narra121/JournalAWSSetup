export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

export function validatePassword(password: string): string | null {
  if (!password || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    return `Password must be ${PASSWORD_MIN}-${PASSWORD_MAX} characters`;
  }
  return null;
}
