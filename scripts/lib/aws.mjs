import { execFileSync } from 'node:child_process';

export const REGION = 'us-east-1';

/** Environment for AWS CLI calls: the `personal` profile locally, the ambient credentials when keys are already in the environment (CI). */
export function awsEnv() {
  const env = { ...process.env, AWS_DEFAULT_REGION: REGION, AWS_PAGER: '' };
  if (process.env.AWS_ACCESS_KEY_ID) delete env.AWS_PROFILE;
  else env.AWS_PROFILE = process.env.AWS_PROFILE || 'personal';
  return env;
}

/** Runs the AWS CLI with the `personal` profile unless AWS_PROFILE is already set. Returns parsed JSON, or text with { text: true }. */
export function aws(args, { text = false, allowFail = false } = {}) {
  const env = awsEnv();
  try {
    const out = execFileSync('aws', [...args, '--region', REGION, '--no-cli-pager', ...(text ? ['--output', 'text'] : ['--output', 'json'])], {
      env,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (text) return out.trim();
    return out.trim() ? JSON.parse(out) : null;
  } catch (err) {
    if (allowFail) return null;
    throw new Error(`aws ${args.slice(0, 3).join(' ')} failed: ${err.stderr || err.message}`);
  }
}

export const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '_');

export function stackOutputs(stackName) {
  const res = aws(['cloudformation', 'describe-stacks', '--stack-name', stackName]);
  return Object.fromEntries((res.Stacks[0].Outputs || []).map((o) => [o.OutputKey, o.OutputValue]));
}
