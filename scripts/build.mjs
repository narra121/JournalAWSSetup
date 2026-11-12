// Bundles the Web Function and the Event Function and writes deterministic zips + sha256 into dist/.
// Usage: node scripts/build.mjs   (prints {"web":{...},"events":{...}} on the last line)
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zip } from './lib/zip.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
rmSync(dist, { recursive: true, force: true });

const targets = {
  web: { entry: 'src/app/server.ts' },
  events: { entry: 'src/app/events.ts' },
};

const result = {};
for (const [name, { entry }] of Object.entries(targets)) {
  const outfile = join(dist, name, 'index.js');
  mkdirSync(dirname(outfile), { recursive: true });
  await build({
    entryPoints: [join(root, entry)],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    sourcemap: 'linked',
    legalComments: 'none',
    logLevel: 'warning',
    banner: { js: 'globalThis.__bundle="' + name + '";' },
  });
  const files = ['index.js', 'index.js.map'].map((f) => ({ name: f, data: readFileSync(join(dirname(outfile), f)) }));
  const zipped = zip(files);
  const sha256 = createHash('sha256').update(zipped).digest('hex');
  const zipPath = join(dist, `${name}.zip`);
  writeFileSync(zipPath, zipped);
  result[name] = { zip: zipPath, sha256, bytes: zipped.length };
}
console.log(JSON.stringify(result));
