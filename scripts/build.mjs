#!/usr/bin/env node
// Builds the dependency-free installer tarball shipped on GitHub releases.
//
// Bundles install.mjs (and every npm dependency it imports) into a single ESM
// file, stages it beside a stripped package.json (no dependencies, so `npx
// <tarball>` never touches a registry), packs that staging dir with `npm pack`,
// and writes dist/claude-plugins-<version>.tgz plus an identical
// dist/claude-plugins.tgz (the asset the "latest" download URL resolves to).

import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, renameSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, dirname, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const stage = join(dist, 'package');

// Fields carried from the root package.json into the shipped one. Everything
// else (dependencies, devDependencies, scripts) is deliberately dropped.
const KEPT_FIELDS = ['name', 'version', 'private', 'type', 'description', 'bin', 'engines'];

const builtins = new Set(builtinModules);

// Every import left in the bundle must be a node builtin written with the
// `node:` scheme and loaded via ESM import. A bare specifier would need a
// registry fetch at install time; a require() call throws in an ESM bundle.
export function checkExternalImports(imports) {
  const bad = [];
  for (const imp of imports) {
    if (!imp.external) continue;
    const bare = imp.path.startsWith('node:') ? imp.path.slice(5) : null;
    const isBuiltin = bare !== null && (builtins.has(bare) || builtins.has(`node:${bare}`));
    const isEsm = imp.kind === 'import-statement' || imp.kind === 'dynamic-import';
    if (!isBuiltin || !isEsm) bad.push(`${imp.kind} ${JSON.stringify(imp.path)}`);
  }
  return bad;
}

export function shippedManifest(pkg) {
  const out = {};
  for (const k of KEPT_FIELDS) if (k in pkg) out[k] = pkg[k];
  return out;
}

function run(cmd, args, opts) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32', ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}):\n${r.stderr}`);
  return r.stdout;
}

async function main() {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const { version } = pkg;

  rmSync(dist, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });

  const outfile = join(stage, 'install.mjs');
  const result = await build({
    entryPoints: [join(root, 'install.mjs')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    metafile: true,
    logLevel: 'warning',
  });

  const bad = [];
  for (const out of Object.values(result.metafile.outputs)) bad.push(...checkExternalImports(out.imports));
  if (bad.length) throw new Error(`bundle has non-builtin or require() imports left:\n  ${bad.join('\n  ')}`);

  const code = readFileSync(outfile, 'utf8');
  if (!code.startsWith('#!/usr/bin/env node\n')) throw new Error('bundle lost the #!/usr/bin/env node shebang');

  writeFileSync(join(stage, 'package.json'), JSON.stringify(shippedManifest(pkg), null, 2) + '\n');

  const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', dist], { cwd: stage }));
  const packedPath = join(dist, packed[0].filename);
  const versioned = join(dist, `claude-plugins-${version}.tgz`);
  const latest = join(dist, 'claude-plugins.tgz');
  renameSync(packedPath, versioned);
  copyFileSync(versioned, latest);

  for (const p of [versioned, latest]) console.log(relative(process.cwd(), p) || p);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(`build failed: ${err.message}`);
    process.exit(1);
  });
}
