// extractZip against real Windows PowerShell 5.1: a release zip laid out like
// mdtohtml's (mdtohtml.exe + a themes/ folder), built with Compress-Archive,
// is unpacked by the real Expand-Archive call into a directory whose path
// contains a `'`. extractZip runs with the environment an installer started
// from PowerShell 7 inherits (PSModulePath led by PowerShell 7's own module
// folder), which proves the 5.1 it spawns loads its own
// Microsoft.PowerShell.Archive, not PowerShell 7's. It only writes a temp
// directory, so it runs on any Windows machine with PowerShell 7 installed; a
// GitHub-hosted Actions runner must have PowerShell 7.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractZip } from '../lib/place.mjs';
import { encodePowerShell, powershellEnv } from '../lib/userpath.mjs';

const onHostedRunner = process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted';

// pwsh7Modules is PowerShell 7's own module folder ($PSHOME\Modules), or null
// when PowerShell 7 is not installed.
function pwsh7Modules() {
  const dirs = [...String(process.env.PATH || '').split(';'), join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7')];
  const home = dirs.find((d) => d && existsSync(join(d, 'pwsh.exe')) && existsSync(join(d, 'Modules')));
  return home ? join(home, 'Modules') : null;
}

const mods = process.platform === 'win32' ? pwsh7Modules() : null;
const skip =
  process.platform !== 'win32'
    ? 'Windows only: runs the real Windows PowerShell 5.1 Expand-Archive'
    : !mods && !onHostedRunner
      ? 'PowerShell 7 is not installed, so there is no PowerShell 7 module path to inherit'
      : false;

// fromPwsh7 is this process's environment as an installer started from
// PowerShell 7 sees it: PSModulePath (under any casing) replaced by one led by
// PowerShell 7's module folder.
function fromPwsh7() {
  const inherited = Object.entries(process.env).find(([k]) => k.toUpperCase() === 'PSMODULEPATH')?.[1];
  return { ...powershellEnv(process.env), PSModulePath: [mods, inherited].filter(Boolean).join(';') };
}

// compress builds `zip` from the contents of `src` with Windows PowerShell
// 5.1's Compress-Archive, under its own default module path.
function compress(src, zip) {
  const script =
    "$ErrorActionPreference = 'Stop'\n" +
    'Compress-Archive -Path (Join-Path $env:CP_SRC "*") -DestinationPath $env:CP_ZIP -Force\n';
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(script)], {
    encoding: 'utf8',
    windowsHide: true,
    env: powershellEnv({ ...process.env, CP_SRC: src, CP_ZIP: zip }),
  });
  assert.equal(r.status, 0, `Compress-Archive failed: ${r.stderr || r.error}`);
  assert.ok(existsSync(zip), 'the zip was built');
}

test('extractZip unpacks a real mdtohtml-style zip with Expand-Archive under a PowerShell 7 environment', { skip }, () => {
  assert.ok(mods, 'PowerShell 7 (pwsh.exe) is installed on the runner');
  const env = fromPwsh7();
  assert.equal(env.PSModulePath.split(';')[0], mods);
  const root = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'claude-plugins-place-'));
  try {
    const src = join(root, 'src');
    mkdirSync(join(src, 'themes'), { recursive: true });
    writeFileSync(join(src, 'mdtohtml.exe'), 'fake executable');
    writeFileSync(join(src, 'themes', 'dark.css'), 'body{}');
    const zip = join(root, 'mdtohtml-windows-x86_64.zip');
    compress(src, zip);

    const dest = join(root, "o'brien", 'Programs', 'mdtohtml');
    extractZip(zip, dest, { platform: 'win32', env });
    assert.equal(readFileSync(join(dest, 'mdtohtml.exe'), 'utf8'), 'fake executable');
    assert.equal(readFileSync(join(dest, 'themes', 'dark.css'), 'utf8'), 'body{}');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
