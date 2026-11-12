import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PASSWORD_POLICY } from '../passwordValidation';

describe('PASSWORD_POLICY', () => {
  it('matches the Cognito user pool password policy in template.yaml', () => {
    const template = readFileSync('template.yaml', 'utf8');
    const block = template.slice(template.indexOf('PasswordPolicy:'), template.indexOf('PasswordPolicy:') + 400);
    expect(block).toContain(`MinimumLength: ${PASSWORD_POLICY.minLength}`);
    expect(block).toContain(`RequireLowercase: ${PASSWORD_POLICY.requireLowercase}`);
    expect(block).toContain(`RequireUppercase: ${PASSWORD_POLICY.requireUppercase}`);
    expect(block).toContain(`RequireNumbers: ${PASSWORD_POLICY.requireNumbers}`);
    expect(block).toContain(`RequireSymbols: ${PASSWORD_POLICY.requireSymbols}`);
  });
});
