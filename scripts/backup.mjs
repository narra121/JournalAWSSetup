// Pre-deploy backup: on-demand DynamoDB backups of every table in the stack + config snapshots + revert notes.
// Usage: node scripts/backup.mjs --stage dev|prod --out <dir>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aws, stamp } from './lib/aws.mjs';

const arg = (name) => process.argv[process.argv.indexOf(`--${name}`) + 1];

export function backup(stage, outDir) {
  const stack = `tradequt-${stage}`;
  mkdirSync(outDir, { recursive: true });
  const save = (name, data) => writeFileSync(join(outDir, name), typeof data === 'string' ? data : JSON.stringify(data, null, 2));

  const stackDesc = aws(['cloudformation', 'describe-stacks', '--stack-name', stack]);
  save('stack.json', stackDesc);
  save('template-original.json', aws(['cloudformation', 'get-template', '--stack-name', stack, '--template-stage', 'Original']));
  const resources = aws(['cloudformation', 'list-stack-resources', '--stack-name', stack]).StackResourceSummaries;
  save('resources.json', resources);

  const pool = resources.find((r) => r.ResourceType === 'AWS::Cognito::UserPool');
  const client = resources.find((r) => r.ResourceType === 'AWS::Cognito::UserPoolClient');
  if (pool) save('user-pool.json', aws(['cognito-idp', 'describe-user-pool', '--user-pool-id', pool.PhysicalResourceId]));
  if (pool && client) {
    save('user-pool-client.json', aws(['cognito-idp', 'describe-user-pool-client', '--user-pool-id', pool.PhysicalResourceId, '--client-id', client.PhysicalResourceId]));
  }
  const params = Object.fromEntries(stackDesc.Stacks[0].Parameters.map((p) => [p.ParameterKey, p.ParameterValue]));
  if (params.HostedZoneId && params.CustomDomainName) {
    save('route53-records.json', aws(['route53', 'list-resource-record-sets', '--hosted-zone-id', params.HostedZoneId, '--query', `ResourceRecordSets[?Name=='${params.CustomDomainName}.']`]));
  }

  const ts = stamp();
  const backups = [];
  for (const t of resources.filter((r) => r.ResourceType === 'AWS::DynamoDB::Table')) {
    const res = aws(['dynamodb', 'create-backup', '--table-name', t.PhysicalResourceId, '--backup-name', `pre-deploy-${ts}`]);
    backups.push({ table: t.PhysicalResourceId, arn: res.BackupDetails.BackupArn });
  }
  for (const b of backups) {
    for (let i = 0; i < 60; i++) {
      const status = aws(['dynamodb', 'describe-backup', '--backup-arn', b.arn]).BackupDescription.BackupDetails.BackupStatus;
      if (status === 'AVAILABLE') {
        b.status = status;
        break;
      }
      if (i === 59) throw new Error(`backup ${b.arn} not AVAILABLE`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
    }
  }
  save('dynamodb-backups.json', backups);
  save(
    'REVERT.md',
    `# Revert ${stack} (${ts})\n\n` +
      `1. Bad app code: \`aws lambda-web update-web-function-endpoint --function-name ${stack}-api --endpoint-name live --revision-weights '[{"revisionId":"<previous>","weight":100}]'\`\n` +
      `2. Infra: redeploy the pre-change template (\`template-original.json\` here, parameters in \`stack.json\`) with \`aws cloudformation deploy\`.\n` +
      `3. Data: \`aws dynamodb restore-table-from-backup --target-table-name <t>-restored --backup-arn <arn from dynamodb-backups.json>\` (or point-in-time restore), verify, copy items back.\n`,
  );
  return backups;
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const stage = arg('stage');
  const out = arg('out');
  const result = backup(stage, out);
  console.log(`backed up ${result.length} tables to ${out}`);
}
