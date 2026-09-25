// The Windows user-PATH step against the real registry: addWindowsUserPath runs
// the real PowerShell script, and the HKCU\Environment `Path` value is then
// read independently with reg.exe. It writes the real current user's registry,
// so it runs only on a GitHub-hosted Actions Windows runner (a throwaway VM);
// the original value (and its type, or its absence) is captured first and
// restored afterwards. The tests run in file order and build on each other's
// registry state.
//
// addWindowsUserPath runs with the environment an installer started from
// PowerShell 7 inherits: PSModulePath led by PowerShell 7's own module folder.
// The strict broadcast assertion (Add-Type, from Microsoft.PowerShell.Utility)
// then proves the Windows PowerShell 5.1 it spawns does not load PowerShell 7's
// modules.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { addWindowsUserPath, encodePowerShell, powershellEnv } from '../lib/userpath.mjs';

const skip =
  process.platform !== 'win32'
    ? 'Windows only: exercises the real HKCU\\Environment registry value'
    : process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted'
      ? 'runs only on a GitHub-hosted Actions runner: it rewrites the current user\'s PATH in the registry, which must never touch a developer or self-hosted machine'
      : false;

const suffix = randomBytes(6).toString('hex');
const base = join(process.env.RUNNER_TEMP || process.env.TEMP || '.', `claude-plugins-userpath-${suffix}`);
const PLAIN_DIR = join(base, 'bin');
const QUOTED_DIR = join(base, "o'brien", 'bin');
// A %VAR% entry seeded before the test; its expansion differs from its raw text.
const SEEDED_LEAF = `claude-plugins-seed-${suffix}`;
const SEEDED_RAW = `%USERPROFILE%\\${SEEDED_LEAF}`;

// pwsh7Modules is PowerShell 7's own module folder ($PSHOME\Modules), or null
// when PowerShell 7 is not installed.
function pwsh7Modules() {
  const dirs = [...String(process.env.PATH || '').split(';'), join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7')];
  const home = dirs.find((d) => d && existsSync(join(d, 'pwsh.exe')) && existsSync(join(d, 'Modules')));
  return home ? join(home, 'Modules') : null;
}

// fromPwsh7 is this process's environment as an installer started from
// PowerShell 7 sees it: PSModulePath (under any casing) replaced by one led by
// PowerShell 7's module folder, as PowerShell 7 sets it for its children.
function fromPwsh7() {
  const mods = skip ? null : pwsh7Modules();
  const inherited = Object.entries(process.env).find(([k]) => k.toUpperCase() === 'PSMODULEPATH')?.[1];
  return { ...powershellEnv(process.env), PSModulePath: [mods, inherited].filter(Boolean).join(';') };
}
const PWSH7_ENV = fromPwsh7();

// ps runs a Windows PowerShell script (UTF-8 output) with extra environment
// variables, under powershellEnv like the installer's own calls, and returns
// its non-empty stdout lines, each trimmed, with a leading byte order mark
// (U+FEFF) removed; a non-zero exit fails the test.
function ps(script, env = {}) {
  const full = "$ErrorActionPreference = 'Stop'\ntry { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}\n" + script;
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(full)], {
    encoding: 'utf8',
    windowsHide: true,
    env: powershellEnv({ ...process.env, ...env }),
  });
  assert.equal(r.status, 0, `PowerShell failed: ${r.stderr || r.error}`);
  return String(r.stdout).replace(/^\uFEFF/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

// readRaw returns { present, kind, value } for HKCU\Environment `Path`, value
// unexpanded, kind as a RegistryValueKind name.
function readRaw() {
  const out = ps(
    "$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')\n" +
      "if ($k -eq $null -or $k.GetValueNames() -notcontains 'Path') { 'absent'; exit 0 }\n" +
      "$v = [string]$k.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)\n" +
      "'present'\n$k.GetValueKind('Path').ToString()\n'b64:' + [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($v))\n",
  );
  if (out[0] === 'absent') return { present: false };
  return { present: true, kind: out[1], value: Buffer.from(out[2].slice(4), 'base64').toString('utf8') };
}

// writeRaw sets HKCU\Environment `Path` to `value` with registry kind `kind`,
// or deletes it when `present` is false.
function writeRaw({ present, kind, value }) {
  ps(
    "$k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')\n" +
      "if ($env:CP_PRESENT -eq '1') { $k.SetValue('Path', [string]$env:CP_VALUE, [Microsoft.Win32.RegistryValueKind]$env:CP_KIND) } else { $k.DeleteValue('Path', $false) }\n" +
      '$k.Dispose()\n',
    { CP_PRESENT: present ? '1' : '0', CP_VALUE: value || '', CP_KIND: kind || 'ExpandString' },
  );
}

// regQuery reads HKCU\Environment `Path` with reg.exe: { type, data }.
function regQuery() {
  const r = spawnSync('reg', ['query', 'HKCU\\Environment', '/v', 'Path'], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, `reg query failed: ${r.stderr}`);
  const m = /^ {4}Path {4}(REG_[A-Z_]+) {4}(.*?)\r?$/m.exec(r.stdout);
  assert.ok(m, `unexpected reg query output:\n${r.stdout}`);
  return { type: m[1], data: m[2] };
}

// add runs the real addWindowsUserPath and also returns the script's stdout lines.
function add(dir) {
  let raw;
  const result = addWindowsUserPath(dir, { spawn: (...a) => (raw = spawnSync(...a)), env: PWSH7_ENV });
  const lines = String(raw.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return { result, lines, stderr: raw.stderr };
}

// The script prints exactly one broadcast token, and on the runner's desktop
// session the WM_SETTINGCHANGE broadcast (Add-Type + SendMessageTimeout) is
// delivered.
function assertBroadcast({ result, lines }) {
  const tokens = lines.filter((l) => l === 'broadcast' || l === 'no-broadcast');
  assert.deepEqual(tokens, ['broadcast'], `stdout lines: ${JSON.stringify(lines)}`);
  assert.equal(result.broadcast, true);
}

let original;
let seeded;

before(() => {
  if (skip) return;
  original = readRaw();
  const entries = original.present ? original.value.split(';').filter(Boolean) : [];
  seeded = [...entries, SEEDED_RAW];
  writeRaw({ present: true, kind: 'ExpandString', value: seeded.join(';') });
  mkdirSync(PLAIN_DIR, { recursive: true });
  mkdirSync(QUOTED_DIR, { recursive: true });
});

after(() => {
  if (skip || !original) return;
  try {
    writeRaw(original);
    assert.deepEqual(readRaw(), original, 'the original user Path is restored');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('the environment under test leads PSModulePath with PowerShell 7 modules', { skip }, (t) => {
  const mods = pwsh7Modules();
  assert.ok(mods, 'PowerShell 7 (pwsh.exe) is installed on the runner');
  assert.equal(PWSH7_ENV.PSModulePath.split(';')[0], mods);
  // Without powershellEnv, Windows PowerShell 5.1 under this environment
  // reports whether Add-Type (Microsoft.PowerShell.Utility) still loads. This
  // documents the failure mode; the installer never runs 5.1 this way.
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', "Add-Type -TypeDefinition 'public static class ClaudePluginsControl { }'; 'loaded'"], {
    encoding: 'utf8',
    windowsHide: true,
    env: PWSH7_ENV,
  });
  t.diagnostic(`unstripped 5.1 Add-Type: exit ${r.status}, stdout ${JSON.stringify(String(r.stdout).trim())}, stderr ${JSON.stringify(String(r.stderr).trim().slice(0, 300))}`);
});

test('a new directory is appended, REG_EXPAND_SZ kept, %VAR% entries left unexpanded', { skip }, () => {
  const run = add(PLAIN_DIR);
  assert.deepEqual(run.result, { ok: true, added: true, broadcast: true, error: null }, run.stderr);
  assert.deepEqual(run.lines.slice(0, 1), ['added']);
  assertBroadcast(run);
  const { type, data } = regQuery();
  assert.equal(type, 'REG_EXPAND_SZ');
  assert.equal(data, [...seeded, PLAIN_DIR].join(';'));
  assert.ok(data.split(';').includes(SEEDED_RAW), 'the seeded %VAR% entry is stored unexpanded');
});

test('a second call reports already present and does not duplicate', { skip }, () => {
  assert.equal(add(PLAIN_DIR).result.ok, true);
  const prior = regQuery();
  for (const dir of [PLAIN_DIR, PLAIN_DIR.toUpperCase() + '\\']) {
    const run = add(dir);
    assert.deepEqual(run.result, { ok: true, added: false, broadcast: true, error: null }, run.stderr);
    assert.deepEqual(run.lines.slice(0, 1), ['present']);
    assertBroadcast(run);
  }
  assert.deepEqual(regQuery(), prior);
  assert.equal(prior.data.split(';').filter((e) => e === PLAIN_DIR).length, 1);
});

test('a directory matching a %VAR% entry once expanded counts as present', { skip }, () => {
  const prior = regQuery();
  const run = add(join(process.env.USERPROFILE, SEEDED_LEAF));
  assert.deepEqual(run.result, { ok: true, added: false, broadcast: true, error: null }, run.stderr);
  assert.deepEqual(run.lines.slice(0, 1), ['present']);
  assertBroadcast(run);
  assert.deepEqual(regQuery(), prior);
});

test("a directory containing ' is quoted correctly and stored verbatim", { skip }, () => {
  const prior = regQuery();
  const run = add(QUOTED_DIR);
  assert.deepEqual(run.result, { ok: true, added: true, broadcast: true, error: null }, run.stderr);
  assertBroadcast(run);
  const { type, data } = regQuery();
  assert.equal(type, 'REG_EXPAND_SZ');
  assert.equal(data, [...prior.data.split(';').filter(Boolean), QUOTED_DIR].join(';'));
  assert.ok(data.split(';').includes(SEEDED_RAW), 'the seeded %VAR% entry is still unexpanded');
});
