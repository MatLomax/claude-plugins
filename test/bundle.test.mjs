// Proves the release tarball is self-contained: built for real, then installed
// and run through `npx` with the registry pointed at a dead port and an empty
// cache, so any registry fetch would fail the run. Also proves the documented
// --strict-ssl=false one-off against an intercepting-style HTTPS chain, and
// covers the release workflow's helper scripts (tag check, changelog
// extraction).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkTag } from '../scripts/check-tag.mjs';
import { extractNotes } from '../scripts/changelog-notes.mjs';
import { checkExternalImports, shippedManifest } from '../scripts/build.mjs';
import { hasOpenssl, noOpensslReason, makeCerts } from './certs.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const versioned = join(root, 'dist', `claude-plugins-${pkg.version}.tgz`);
const latest = join(root, 'dist', 'claude-plugins.tgz');
const isWindows = process.platform === 'win32';

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', shell: isWindows, ...opts });
}

// An environment with no inherited npm config: dead registry, empty cache,
// empty user config, no offline flag, no fetch retries, and Node's own TLS
// verification left at its default, so npm really tries the network for
// anything it thinks it needs and a failed fetch fails at once.
function hermeticNpmEnv(scratch) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!/^npm_(config|package|lifecycle)_/i.test(k) && k !== 'NODE_TLS_REJECT_UNAUTHORIZED') env[k] = v;
  }
  const userconfig = join(scratch, 'npmrc');
  writeFileSync(userconfig, '');
  env.npm_config_registry = 'http://127.0.0.1:9/';
  env.npm_config_cache = join(scratch, 'cache');
  env.npm_config_userconfig = userconfig;
  env.npm_config_fetch_retries = '0';
  env.npm_config_update_notifier = 'false';
  env.npm_config_audit = 'false';
  env.npm_config_fund = 'false';
  return env;
}

test('build produces the tarballs', { timeout: 120_000 }, () => {
  const r = run(process.execPath, [join(root, 'scripts', 'build.mjs')], { cwd: root });
  assert.equal(r.status, 0, `build failed:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, new RegExp(`claude-plugins-${pkg.version.replace(/\./g, '\\.')}\\.tgz`));
  assert.match(r.stdout, /claude-plugins\.tgz/);
});

test('claude-plugins.tgz is byte-identical to the versioned tarball', () => {
  assert.ok(readFileSync(latest).equals(readFileSync(versioned)));
});

test('the tarball ships no dependencies and keeps the bin', () => {
  const r = run('tar', ['-xzOf', versioned, 'package/package.json']);
  assert.equal(r.status, 0, r.stderr);
  const shipped = JSON.parse(r.stdout);
  for (const k of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'scripts']) {
    assert.equal(shipped[k], undefined, `shipped package.json has ${k}`);
  }
  for (const k of ['name', 'version', 'type', 'bin', 'engines', 'description']) {
    assert.deepEqual(shipped[k], pkg[k], `shipped ${k} differs from root`);
  }
  const list = run('tar', ['-tzf', versioned]);
  assert.deepEqual(list.stdout.trim().split('\n').sort(), ['package/install.mjs', 'package/package.json']);
});

function runAsync(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: isWindows, ...opts });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

// npx runs `npx <args>` in a fresh scratch directory with its own empty npm
// cache, so no run can be satisfied by what an earlier run downloaded.
async function npx(args) {
  const scratch = mkdtempSync(join(tmpdir(), 'claude-plugins-npx-'));
  try {
    return await runAsync('npx', args, { cwd: scratch, env: hermeticNpmEnv(scratch) });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function npxVersion(spec, npmFlags = []) {
  const r = await npx([...npmFlags, '--yes', spec, '--version']);
  assert.equal(r.status, 0, `npx ${[...npmFlags, spec].join(' ')} failed (${r.status}):\n${r.stdout}\n${r.stderr}`);
  assert.equal(r.stdout.trim(), pkg.version);
}

// A bare absolute path is not a package spec to npx (it would try to execute
// the file), so the local tarball is addressed with the file: scheme.
test('npx runs the local tarball with no registry access', { timeout: 120_000 }, async () => {
  await npxVersion(`file:${versioned}`);
});

// Mirrors the published form `npx https://matlomax.com/claude-plugins.tgz`: a
// remote tarball URL that 302-redirects to the release asset.
test('npx runs the tarball from a redirecting URL with no registry access', { timeout: 120_000 }, async () => {
  const body = readFileSync(latest);
  const server = createServer((req, res) => {
    if (req.url === '/claude-plugins.tgz') {
      res.writeHead(302, { location: '/releases/latest/download/claude-plugins.tgz' }).end();
    } else if (req.url === '/releases/latest/download/claude-plugins.tgz') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length }).end(body);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await npxVersion(`http://127.0.0.1:${server.address().port}/claude-plugins.tgz`);
  } finally {
    server.close();
  }
});

// Proves the documented one-off for a TLS-intercepting network: the tarball
// is served over HTTPS by a leaf signed by a private root CA with the full
// chain sent, which is what an intercepting proxy presents. Plain npx fails on
// the chain; the same command with --strict-ssl=false runs the installer.
test('npx behind an intercepting-style chain: fails on the chain, runs with --strict-ssl=false', { skip: hasOpenssl ? false : noOpensslReason, timeout: 120_000 }, async () => {
  const certDir = mkdtempSync(join(tmpdir(), 'claude-plugins-certs-'));
  const body = readFileSync(latest);
  const server = createHttpsServer(makeCerts(certDir).chain, (req, res) => {
    if (req.url === '/claude-plugins.tgz') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length }).end(body);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `https://127.0.0.1:${server.address().port}/claude-plugins.tgz`;
    const strict = await npx(['--yes', url, '--version']);
    assert.notEqual(strict.status, 0, `npx ${url} must fail on the untrusted chain:\n${strict.stdout}\n${strict.stderr}`);
    assert.match(strict.stdout + strict.stderr, /SELF_SIGNED_CERT_IN_CHAIN/);
    await npxVersion(url, ['--strict-ssl=false']);
  } finally {
    server.closeAllConnections();
    server.close();
    rmSync(certDir, { recursive: true, force: true });
  }
});

test('checkTag accepts only v<version>', () => {
  assert.equal(checkTag('v1.2.3', '1.2.3').ok, true);
  assert.equal(checkTag('1.2.3', '1.2.3').ok, false);
  assert.equal(checkTag('v1.2.4', '1.2.3').ok, false);
  assert.equal(checkTag('v1.2.3-rc.1', '1.2.3').ok, false);
  assert.equal(checkTag(undefined, '1.2.3').ok, false);
  assert.equal(checkTag('', '1.2.3').ok, false);
});

test('check-tag CLI exits by match against package.json', () => {
  const script = join(root, 'scripts', 'check-tag.mjs');
  const env = { ...process.env };
  delete env.GITHUB_REF_NAME;
  assert.equal(run(process.execPath, [script, `v${pkg.version}`], { env }).status, 0);
  assert.equal(run(process.execPath, [script, `v${pkg.version}.9`], { env }).status, 1);
  assert.equal(run(process.execPath, [script], { env }).status, 1);
  assert.equal(run(process.execPath, [script], { env: { ...env, GITHUB_REF_NAME: `v${pkg.version}` } }).status, 0);
});

const SAMPLE = `# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- Something not yet released.

## [1.10.0] - 2026-09-20

### Added
- The ten.

## [1.1.0] - 2026-09-10

### Added
- A prebuilt tarball.

### Fixed
- A proxy problem.

## [1.0.0] - 2026-08-28

- Initial release.

## [0.9.0] - 2026-08-01

[Unreleased]: https://github.com/MatLomax/claude-plugins/compare/v1.10.0...HEAD
[1.0.0]: https://github.com/MatLomax/claude-plugins/releases/tag/v1.0.0
`;

test('extractNotes returns only the requested section', () => {
  assert.equal(extractNotes(SAMPLE, '1.1.0'), '### Added\n- A prebuilt tarball.\n\n### Fixed\n- A proxy problem.\n');
  assert.equal(extractNotes(SAMPLE, '1.10.0'), '### Added\n- The ten.\n');
  assert.equal(extractNotes(SAMPLE, '1.0.0'), '- Initial release.\n');
  assert.equal(extractNotes(SAMPLE.replace(/\n/g, '\r\n'), '1.0.0'), '- Initial release.\n');
});

test('extractNotes fails on a missing, undated, or empty section', () => {
  assert.throws(() => extractNotes(SAMPLE, '2.0.0'), /no "## \[2\.0\.0\]/);
  assert.throws(() => extractNotes(SAMPLE, '1.1'), /no "## \[1\.1\]/); // no prefix match on 1.1.0 / 1.10.0
  assert.throws(() => extractNotes(SAMPLE, 'Unreleased'), /no "## \[Unreleased\]/);
  assert.throws(() => extractNotes(SAMPLE, '0.9.0'), /empty/); // body is only link references
});

test('changelog-notes CLI prints the section and fails when missing', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'claude-plugins-cl-'));
  try {
    const file = join(scratch, 'CHANGELOG.md');
    writeFileSync(file, SAMPLE);
    const script = join(root, 'scripts', 'changelog-notes.mjs');
    const ok = run(process.execPath, [script, '1.0.0', file]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout, '- Initial release.\n');
    assert.equal(run(process.execPath, [script, '3.0.0', file]).status, 1);
    assert.equal(run(process.execPath, [script]).status, 2);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('checkExternalImports allows only node: builtins via ESM import', () => {
  const ok = [
    { path: 'node:fs', kind: 'import-statement', external: true },
    { path: 'node:child_process', kind: 'dynamic-import', external: true },
    { path: '@clack/prompts', kind: 'import-statement', external: false }, // bundled
  ];
  assert.deepEqual(checkExternalImports(ok), []);
  assert.equal(checkExternalImports([{ path: '@clack/prompts', kind: 'import-statement', external: true }]).length, 1);
  assert.equal(checkExternalImports([{ path: 'fs', kind: 'import-statement', external: true }]).length, 1);
  assert.equal(checkExternalImports([{ path: 'node:tty', kind: 'require-call', external: true }]).length, 1);
  assert.equal(checkExternalImports([{ path: 'node:nope', kind: 'import-statement', external: true }]).length, 1);
});

test('shippedManifest drops dependencies and scripts', () => {
  const m = shippedManifest({ name: 'x', version: '1.0.0', type: 'module', bin: { x: 'i.mjs' }, dependencies: { a: '1' }, devDependencies: { b: '1' }, scripts: { t: 'x' } });
  assert.deepEqual(m, { name: 'x', version: '1.0.0', type: 'module', bin: { x: 'i.mjs' } });
});
