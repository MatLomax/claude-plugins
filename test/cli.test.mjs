// The installer entry point run as a real process: the print-and-exit flags
// and flag errors must finish before any network call or prompt.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../install.mjs', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// stdin is closed, so the installer can never reach a prompt.
function run(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
}

test('--version prints the bare package.json version and exits 0', () => {
  const r = run(['--version']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${pkg.version}\n`);
  assert.equal(r.stderr, '');
});

test('--help and -h print usage and exit 0', () => {
  for (const flag of ['--help', '-h']) {
    const r = run([flag]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^Usage: npx https:\/\/matlomax\.com\/claude-plugins\.tgz/);
    assert.match(r.stdout, /--insecure/);
    assert.match(r.stdout, /--no-self-update/);
    assert.match(r.stdout, /--plugins=<names>/);
  }
});

test('--insecure --version still just prints the version', () => {
  const r = run(['--insecure', '--version']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, `${pkg.version}\n`);
});

test('an unknown flag prints a short error plus usage and exits 2', () => {
  const r = run(['--frobnicate']);
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^claude-plugins-install: Unknown option '--frobnicate'\n\nUsage:/);
});

test('without a terminal and without --plugins it refuses before checking for updates', () => {
  const r = run([]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /interactive/);
  assert.match(r.stderr, /--plugins/);
  assert.doesNotMatch(r.stderr, /newer installer/);
});

test('--help and --version win over an invalid --plugins list', () => {
  for (const args of [['--help', '--plugins=nope'], ['--plugins=', '-h'], ['--install-tools', '--help']]) {
    const r = run(args);
    assert.equal(r.status, 0, `${args}: ${r.stderr}`);
    assert.match(r.stdout, /^Usage: /);
    assert.equal(r.stderr, '');
  }
  const r = run(['--version', '--plugins=worklog,nope']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${pkg.version}\n`);
});

test('--help, -h and --version win over a flag that does not parse', () => {
  for (const args of [['--help', '--plugins'], ['--plugins', '--help'], ['--plugins', '-h'], ['--bogus', '--help']]) {
    const r = run(args);
    assert.equal(r.status, 0, `${args}: ${r.stderr}`);
    assert.match(r.stdout, /^Usage: /);
    assert.equal(r.stderr, '');
  }
  const r = run(['--plugins', '--version']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${pkg.version}\n`);
});

test('--plugins=--help is a plugin name, not the help flag', () => {
  const r = run(['--plugins=--help']);
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^claude-plugins-install: unknown plugin '--help'/);
});

test('a parseArgs error spanning several lines is shown as one line, then usage', () => {
  const r = run(['--plugins', '--install-tools']);
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^claude-plugins-install: Option '--plugins' argument is ambiguous\n\nUsage:/);
});
