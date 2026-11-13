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
    // The AWS SDK v3 stays bundled on purpose: the Web Function runtime does not document a provided SDK version to pin to.
    minify: true,
    sourcemap: 'linked',
    legalComments: 'none',
    logLevel: 'warning',
    banner: { js: 'globalThis.__bundle="' + name + '";' },
  });
  // The map stays in dist/ for local stack traces; Lambda never reads it (no --enable-source-maps), so it is not shipped.
  const files = ['index.js'].map((f) => ({ name: f, data: readFileSync(join(dirname(outfile), f)) }));
  const zipped = zip(files);
  const sha256 = createHash('sha256').update(zipped).digest('hex');
  const zipPath = join(dist, `${name}.zip`);
  writeFileSync(zipPath, zipped);
  result[name] = { zip: zipPath, sha256, bytes: zipped.length };
}
console.log(JSON.stringify(result));
