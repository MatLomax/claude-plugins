// placeRelease on this machine's real filesystem: a bare binary and a zip
// (executable + themes/) placed into a scratch HOME, and the PATH report
// measured against the PATH the installer started with, not the run's PATH;
// and the Windows zip extraction's PowerShell call, with the spawn injected.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, statSync, readlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractZip, placeRelease } from '../lib/place.mjs';
import { TOOLS } from '../lib/plugins.mjs';

const posixOnly = process.platform === 'win32' ? 'the POSIX install layout' : false;
const haveZipTools = !spawnSync('unzip', ['-v'], { stdio: 'ignore' }).error && !spawnSync('python3', ['-c', 'import zipfile'], { stdio: 'ignore' }).error;
const zipSkip = posixOnly || (haveZipTools ? false : 'needs unzip and python3 to build and extract a zip');

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'claude-plugins-place-'));
  const s = { root, home: join(root, 'home'), dl: join(root, 'dl') };
  mkdirSync(s.home);
  mkdirSync(s.dl);
  return s;
}

function binaryArtifact(s, name) {
  const file = join(s.dl, name);
  writeFileSync(file, '#!/bin/sh\necho ok\n');
  return file;
}

// zipArtifact builds a release zip laid out like mdtohtml's: the executable
// and a themes/ folder at the top level.
function zipArtifact(s) {
  const src = join(s.dl, 'src');
  mkdirSync(join(src, 'themes'), { recursive: true });
  writeFileSync(join(src, 'mdtohtml'), '#!/bin/sh\necho ok\n');
  writeFileSync(join(src, 'themes', 'dark.css'), 'body{}');
  const zip = join(s.dl, 'mdtohtml.zip');
  const py = 'import sys, zipfile\nz = zipfile.ZipFile(sys.argv[1], "w")\nz.write(sys.argv[2] + "/mdtohtml", "mdtohtml")\nz.write(sys.argv[2] + "/themes/dark.css", "themes/dark.css")\nz.close()';
  const r = spawnSync('python3', ['-c', py, zip, src]);
  assert.equal(r.status, 0, String(r.stderr));
  return zip;
}

test('a bare binary lands in ~/.local/bin, executable, and is reported against the starting PATH', { skip: posixOnly }, () => {
  const s = scratch();
  try {
    const binDir = join(s.home, '.local', 'bin');
    const placed = placeRelease(TOOLS.worklog, binaryArtifact(s, 'worklog-linux-amd64'), { platform: 'linux', home: s.home, startPath: '/usr/bin' });
    assert.deepEqual(placed, { dir: binDir, path: { windows: false, onPath: false } });
    assert.ok(statSync(join(binDir, 'worklog')).mode & 0o100);
    const again = placeRelease(TOOLS.worklog, binaryArtifact(s, 'worklog-linux-amd64'), { platform: 'linux', home: s.home, startPath: `/usr/bin:${binDir}` });
    assert.deepEqual(again.path, { windows: false, onPath: true });
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('a zip is unpacked to ~/.local/share/<tool> and symlinked into ~/.local/bin', { skip: zipSkip }, () => {
  const s = scratch();
  try {
    const binDir = join(s.home, '.local', 'bin');
    const placed = placeRelease(TOOLS.mdtohtml, zipArtifact(s), { platform: 'linux', home: s.home, startPath: '/usr/bin' });
    assert.deepEqual(placed, { dir: binDir, path: { windows: false, onPath: false } });
    const installDir = join(s.home, '.local', 'share', 'mdtohtml');
    assert.equal(readlinkSync(join(binDir, 'mdtohtml')), join(installDir, 'mdtohtml'));
    assert.ok(statSync(join(installDir, 'mdtohtml')).mode & 0o100);
    assert.equal(readFileSync(join(installDir, 'themes', 'dark.css'), 'utf8'), 'body{}');
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('a second tool installed into the same directory is still reported off PATH', { skip: zipSkip }, () => {
  const s = scratch();
  try {
    // main() passes the PATH it started with for every placement, so the
    // second install is judged by what a new shell sees, not by the run's
    // PATH (which gained ~/.local/bin after the first install).
    const startPath = '/usr/bin';
    const first = placeRelease(TOOLS.worklog, binaryArtifact(s, 'worklog-linux-amd64'), { platform: 'linux', home: s.home, startPath });
    const second = placeRelease(TOOLS.mdtohtml, zipArtifact(s), { platform: 'linux', home: s.home, startPath });
    assert.equal(second.dir, first.dir);
    assert.deepEqual(second.path, { windows: false, onPath: false });
    assert.ok(existsSync(join(first.dir, 'worklog')) && existsSync(join(first.dir, 'mdtohtml')));
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('on Windows a zip is expanded by Windows PowerShell with PSModulePath removed from its environment', () => {
  const s = scratch();
  try {
    const calls = [];
    const spawn = (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return { status: 0 };
    };
    const env = { Path: 'C:\\Windows\\System32', PSMODULEPATH: 'C:\\Program Files\\PowerShell\\7\\Modules', SystemRoot: 'C:\\Windows' };
    const dir = join(s.home, 'Programs', 'mdtohtml');
    extractZip("C:\\dl\\o'brien.zip", dir, { platform: 'win32', spawn, env });
    assert.ok(existsSync(dir), 'the destination is created first');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, 'powershell');
    assert.deepEqual(calls[0].args, ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -Path 'C:\\dl\\o''brien.zip' -DestinationPath '${dir}' -Force`]);
    assert.deepEqual(calls[0].opts.env, { Path: 'C:\\Windows\\System32', SystemRoot: 'C:\\Windows' });
    assert.throws(() => extractZip('x.zip', dir, { platform: 'win32', spawn: () => ({ status: 1 }), env }), /Expand-Archive failed/);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});
