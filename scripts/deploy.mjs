// Change-set deploy of tradequt-<stage> with a guard on stateful resources.
// Usage: node scripts/deploy.mjs --stage dev|prod [--dry-run] [--confirm-prod] [--skip-checks] [--skip-backup]
//          [--param Key=Value ...]      repeatable; overrides one stack parameter (e.g. AlarmEmail, AdminSecretParamName)
// Prod refuses to run (dry run included) unless AlarmEmail is a real address and the admin secret parameter names
// are under /tradequt/prod/. The final parameter table is printed before the change set is created.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backup } from './backup.mjs';
import { aws, awsEnv, stackOutputs, stamp } from './lib/aws.mjs';
import { assertDeclared, formatParamTable, parseDeployArgs, prodParamProblems } from './lib/deploy-args.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { stage, flags, params: overrides } = parseDeployArgs(process.argv.slice(2));
const flag = (name) => flags.has(name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (stage === 'prod' && !flag('dry-run') && !flag('confirm-prod')) throw new Error('prod deploy needs --confirm-prod (or --dry-run)');

const stack = `tradequt-${stage}`;
const research = process.env.TRADEQUT_RESEARCH || 'C:\\Users\\narpra1\\Work\\Personal\\TradeQut-Research';
const outDir = join(research, 'build', 'backups', `${stage}-${stamp()}`);
mkdirSync(outDir, { recursive: true });
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });

if (!flag('skip-checks')) {
  run('node', ['node_modules/vitest/vitest.mjs', 'run', '--reporter=dot']);
  run('node', ['node_modules/typescript/bin/tsc', '--noEmit']);
  run('sam', ['validate', '--lint']);
}

const built = JSON.parse(execFileSync('node', ['scripts/build.mjs'], { cwd: root, encoding: 'utf8' }).trim().split('\n').pop());
const bucket = stackOutputs('tradequt-artifacts').CodeBucketName;

function upload(file, key) {
  return aws(['s3api', 'put-object', '--bucket', bucket, '--key', key, '--body', file]).VersionId;
}
const webKey = `web/${stage}/${built.web.sha256}.zip`;
const eventsKey = `events/${stage}/${built.events.sha256}.zip`;
const webVersion = upload(built.web.zip, webKey);
const eventsVersion = upload(built.events.zip, eventsKey);

const templateKey = `templates/${stage}/${Date.now()}.yaml`;
upload(join(root, 'template.yaml'), templateKey);
const templateUrl = `https://${bucket}.s3.us-east-1.amazonaws.com/${templateKey}`;

const summary = aws(['cloudformation', 'get-template-summary', '--template-url', templateUrl]);
const declared = new Set(summary.Parameters.map((p) => p.ParameterKey));
const existingParams = aws(['cloudformation', 'describe-stacks', '--stack-name', stack]).Stacks[0].Parameters;
const existing = existingParams.map((p) => p.ParameterKey);
assertDeclared(overrides, declared);

const explicit = {
  CodeBucket: bucket,
  WebCodeKey: webKey,
  WebCodeVersion: webVersion,
  EventsCodeKey: eventsKey,
  EventsCodeVersion: eventsVersion,
};
if (stage === 'dev') {
  const prod = stackOutputs('tradequt-prod');
  explicit.ProdUserPoolId = prod.UserPoolId;
  explicit.ProdUserPoolClientId = prod.UserPoolClientId;
  explicit.AppHost = 'dev.tradequt.com';
}
Object.assign(explicit, overrides);

// The value every declared parameter will have after this update, and where it comes from.
const previousValue = Object.fromEntries(existingParams.map((p) => [p.ParameterKey, p.ParameterValue]));
const finalRows = summary.Parameters.map((p) => {
  const name = p.ParameterKey;
  if (name in explicit) return { name, value: explicit[name], source: name in overrides ? 'explicit --param' : 'script', noEcho: p.NoEcho };
  if (existing.includes(name)) return { name, value: previousValue[name], source: 'previous value', noEcho: p.NoEcho };
  return { name, value: p.DefaultValue ?? '', source: 'template default', noEcho: p.NoEcho };
});
if (stage === 'prod') {
  const problems = prodParamProblems(Object.fromEntries(finalRows.map((r) => [r.name, r.value])));
  if (problems.length) {
    console.error(formatParamTable(finalRows));
    console.error(`\nREFUSING to deploy tradequt-prod:\n - ${problems.join('\n - ')}`);
    process.exit(4);
  }
}
console.log(`Final parameters for ${stack}:\n${formatParamTable(finalRows)}\n`);

const parameters = [
  ...Object.entries(explicit)
    .filter(([k]) => declared.has(k))
    .map(([k, v]) => ({ ParameterKey: k, ParameterValue: v })),
  ...existing.filter((k) => declared.has(k) && !(k in explicit)).map((k) => ({ ParameterKey: k, UsePreviousValue: true })),
];
const paramsFile = join(outDir, 'parameters.json');
writeFileSync(paramsFile, JSON.stringify(parameters, null, 2));
copyFileSync(join(root, 'template.yaml'), join(outDir, 'template-new.yaml'));

const csName = `cs-${stamp().replace("_", "-")}`;
aws([
  'cloudformation', 'create-change-set',
  '--stack-name', stack,
  '--change-set-name', csName,
  '--change-set-type', 'UPDATE',
  '--template-url', templateUrl,
  '--parameters', `file://${paramsFile}`,
  '--capabilities', 'CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND',
]);
let cs;
for (let i = 0; i < 120; i++) {
  cs = aws(['cloudformation', 'describe-change-set', '--stack-name', stack, '--change-set-name', csName]);
  if (['CREATE_COMPLETE', 'FAILED'].includes(cs.Status)) break;
  await sleep(3000);
}
writeFileSync(join(outDir, 'changeset.json'), JSON.stringify(cs, null, 2));
if (cs.Status !== 'CREATE_COMPLETE') throw new Error(`change set ${cs.Status}: ${cs.StatusReason}`);

const PROTECTED = new Set([
  'AWS::DynamoDB::Table',
  'AWS::Cognito::UserPool',
  'AWS::Cognito::UserPoolClient',
  'AWS::S3::Bucket',
  'AWS::Route53::HostedZone',
]);
const violations = cs.Changes.map((c) => c.ResourceChange).filter(
  (rc) => PROTECTED.has(rc.ResourceType) && (rc.Action === 'Remove' || rc.Replacement === 'True' || rc.Replacement === 'Conditional'),
);
const tally = {};
for (const { ResourceChange: rc } of cs.Changes) {
  const key = `${rc.Action} ${rc.ResourceType}`;
  tally[key] = (tally[key] || 0) + 1;
}
console.log('change set', csName, JSON.stringify(tally, null, 1));
const dropChangeSet = () =>
  aws(['cloudformation', 'delete-change-set', '--stack-name', stack, '--change-set-name', csName], { allowFail: true });
if (violations.length) {
  console.error('GUARD: stateful resource would be removed/replaced:', JSON.stringify(violations.map((v) => `${v.LogicalResourceId} ${v.Action} ${v.Replacement}`)));
  dropChangeSet();
  process.exit(2);
}

if (flag('dry-run')) {
  dropChangeSet();
  console.log(`dry run OK (guard passed). Artifacts: ${outDir}`);
  process.exit(0);
}

if (!flag('skip-backup')) {
  const backups = backup(stage, outDir);
  console.log(`backups AVAILABLE: ${backups.length} tables -> ${outDir}`);
}

aws(['cloudformation', 'execute-change-set', '--stack-name', stack, '--change-set-name', csName]);
console.log('executing... waiting for UPDATE_COMPLETE');
try {
  execFileSync('aws', ['cloudformation', 'wait', 'stack-update-complete', '--stack-name', stack, '--region', 'us-east-1'], {
    stdio: 'inherit',
    env: awsEnv(),
    timeout: 55 * 60 * 1000,
  });
} catch (err) {
  const events = aws(['cloudformation', 'describe-stack-events', '--stack-name', stack, '--max-items', '25']);
  const failed = events.StackEvents.filter((e) => /FAILED/.test(e.ResourceStatus)).map((e) => `${e.LogicalResourceId}: ${e.ResourceStatusReason}`);
  console.error('stack update did not complete:', JSON.stringify(failed, null, 1));
  throw err;
}
const outputs = stackOutputs(stack);
writeFileSync(join(outDir, 'outputs.json'), JSON.stringify(outputs, null, 2));
console.log('UPDATE_COMPLETE', outputs.ApiBaseUrl);

const url = `${outputs.ApiBaseUrl}/subscriptions/plans`;
for (let i = 0; i < 40; i++) {
  try {
    const res = await fetch(url);
    if (res.status === 200) {
      console.log('smoke OK', url, res.status);
      process.exit(0);
    }
    console.log('smoke', res.status);
  } catch (e) {
    console.log('smoke error', e.cause?.code || e.message);
  }
  await sleep(15000);
}
console.error('smoke failed');
process.exit(3);
