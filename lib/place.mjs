// Installing a downloaded release artifact: where each tool's files go per
// platform, and the PATH report for the directory that holds its executable.

import { mkdirSync, chmodSync, renameSync, copyFileSync, rmSync, symlinkSync } from 'node:fs';
import { join, win32, posix } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensureUserPath, powershellEnv, psQuote } from './userpath.mjs';

function moveInto(src, dst) {
  try {
    renameSync(src, dst); // fast path when src and dst share a filesystem
  } catch {
    copyFileSync(src, dst); // temp dir may be on another filesystem
    rmSync(src, { force: true });
  }
}

// extractZip unpacks `zip` into `dir`: with Expand-Archive under Windows
// PowerShell 5.1 (run with powershellEnv(env)) on Windows, with unzip elsewhere.
export function extractZip(zip, dir, { platform = process.platform, spawn = spawnSync, env = process.env } = {}) {
  mkdirSync(dir, { recursive: true });
  if (platform === 'win32') {
    const r = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -Path ${psQuote(zip)} -DestinationPath ${psQuote(dir)} -Force`], { stdio: 'ignore', windowsHide: true, env: powershellEnv(env) });
    if (r.error || r.status !== 0) throw new Error('could not extract the zip (Expand-Archive failed)');
  } else {
    const r = spawn('unzip', ['-oq', zip, '-d', dir], { stdio: 'ignore' });
    if (r.error || r.status !== 0) throw new Error('could not extract the zip (is `unzip` installed?)');
  }
}

// placeRelease installs `artifact` (a bare executable for kind 'binary', a zip
// of the executable + themes/ for kind 'zip') and returns { dir, path }: the
// directory holding the executable, and ensureUserPath's report for it.
//
// Windows: both kinds go to <localAppData>\Programs\<bin>, which is added to
// the user PATH. Elsewhere: a binary goes to <home>/.local/bin; a zip is
// unpacked to <home>/.local/share/<bin> and symlinked into <home>/.local/bin
// (themes/ resolves through the symlink at run time); <home>/.local/bin is
// checked against `startPath`, the PATH the installer started with.
export function placeRelease(tool, artifact, { platform = process.platform, home, localAppData, startPath = '', spawn = spawnSync }) {
  const windows = platform === 'win32';
  const path = windows ? win32 : posix;
  const exeName = tool.bin + (windows ? '.exe' : '');
  const report = (dir) => ({ dir, path: ensureUserPath(dir, { platform, pathValue: startPath, spawn }) });
  const binDir = windows ? path.join(localAppData || home, 'Programs', tool.bin) : path.join(home, '.local', 'bin');

  if (tool.kind === 'binary') {
    mkdirSync(binDir, { recursive: true });
    const target = join(binDir, exeName);
    moveInto(artifact, target);
    if (!windows) chmodSync(target, 0o755);
    return report(binDir);
  }
  if (windows) {
    extractZip(artifact, binDir, { platform, spawn });
    return report(binDir);
  }
  const installDir = path.join(home, '.local', 'share', tool.bin);
  extractZip(artifact, installDir, { platform, spawn });
  const exe = join(installDir, exeName);
  chmodSync(exe, 0o755);
  mkdirSync(binDir, { recursive: true });
  const link = join(binDir, tool.bin);
  rmSync(link, { force: true });
  symlinkSync(exe, link);
  return report(binDir);
}
