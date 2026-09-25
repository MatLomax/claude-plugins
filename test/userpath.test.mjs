// The user-PATH step of an install: the PowerShell script that updates the
// Windows user PATH, how its result is read, and the summary lines for every
// outcome on Windows and elsewhere. The spawn of PowerShell is injected; no
// PowerShell runs here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { windowsPathScript, encodePowerShell, psQuote, powershellEnv, addWindowsUserPath, ensureUserPath, onPathDir, pathLines, WINDOWS_PATH_TIMEOUT_MS } from '../lib/userpath.mjs';
import { summaryLines } from '../lib/flow.mjs';
import { integrityLine } from '../lib/tls.mjs';

const WIN_DIR = String.raw`C:\Users\o'brien\AppData\Local\Programs\mdtohtml`;

// fakeSpawn answers like spawnSync and records every call.
function fakeSpawn(result) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { status: 0, stdout: '', stderr: '', error: undefined, ...result };
  };
  return { spawn, calls };
}

function decode(b64) {
  return Buffer.from(b64, 'base64').toString('utf16le');
}

test('psQuote doubles every single-quote delimiter PowerShell recognises', () => {
  assert.equal(psQuote(WIN_DIR), String.raw`'C:\Users\o''brien\AppData\Local\Programs\mdtohtml'`);
  assert.equal(psQuote("a''b"), "'a''''b'");
  for (const q of ['\u2018', '\u2019', '\u201A', '\u201B']) {
    assert.equal(psQuote(`O${q}Brien`), `'O${q}${q}Brien'`, `U+${q.codePointAt(0).toString(16)}`);
  }
});

test('windowsPathScript: raw read, ExpandString write, read-back check, broadcast, exit codes', () => {
  const script = windowsPathScript(WIN_DIR);
  const lines = script.split('\n');
  // The dir is assigned once, safely quoted, and referenced only as $d.
  assert.ok(lines.includes(String.raw`$d = 'C:\Users\o''brien\AppData\Local\Programs\mdtohtml'`), script);
  assert.equal(script.split('brien').length - 1, 1, 'the dir appears only in the $d assignment');
  assert.ok(windowsPathScript('C:\\Users\\O\u2019Brien\\x').includes("$d = 'C:\\Users\\O\u2019\u2019Brien\\x'"));
  assert.match(script, /\[Microsoft\.Win32\.Registry\]::CurrentUser\.CreateSubKey\('Environment'\)/);
  assert.match(script, /\$raw = \[string\]\$k\.GetValue\('Path', '', \[Microsoft\.Win32\.RegistryValueOptions\]::DoNotExpandEnvironmentNames\)/);
  // An entry matches with %VAR% expanded and trailing backslashes dropped.
  assert.match(script, /function Test-Listed\(\[string\]\$value\) \{ @\(\$value -split ';' \| Where-Object \{ \$_ -ne '' -and \[Environment\]::ExpandEnvironmentVariables\(\$_\)\.TrimEnd\('\\'\) -eq \$d\.TrimEnd\('\\'\) \}\)\.Count -gt 0 \}/);
  assert.match(script, /if \(-not \(Test-Listed \$raw\)\) \{\n\s+\$e = @\(\$raw -split ';' \| Where-Object \{ \$_ -ne '' \}\)\n\s+\$k\.SetValue\('Path', \(\(\$e \+ \$d\) -join ';'\), \[Microsoft\.Win32\.RegistryValueKind\]::ExpandString\)/);
  // Read back after the write, and fail unless the dir is there.
  const write = script.indexOf('SetValue(');
  const readBack = script.indexOf("$check = [string]$k.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)");
  assert.ok(write > 0 && readBack > write, 'the value is read back after the write');
  assert.match(script, /if \(-not \(Test-Listed \$check\)\) \{\n\s+\[Console\]::Error\.WriteLine\('[^']+'\)\n\s+exit 1\n\}/);
  // A registry exception is reported on stderr with exit 1.
  assert.match(script, /\} catch \{\n\s+\[Console\]::Error\.WriteLine\(\$_\.Exception\.Message\)\n\s+exit 1\n\}/);
  assert.match(script, /^\$ErrorActionPreference = 'Stop'$/m);
  assert.match(script, /^try \{ \[Console\]::OutputEncoding = \[System\.Text\.Encoding\]::UTF8 \} catch \{\}$/m);
  // The verified result is printed and flushed before the broadcast.
  const reported = script.indexOf("if ($added) { [Console]::Out.WriteLine('added') } else { [Console]::Out.WriteLine('present') }\n[Console]::Out.Flush()");
  assert.ok(reported > readBack, script);
  // WM_SETTINGCHANGE "Environment" to HWND_BROADCAST, SMTO_ABORTIFHUNG, 5 s.
  assert.match(script, /Add-Type -Namespace \w+ -Name \w+ -MemberDefinition '\[DllImport\("user32\.dll"[^']*\)\] public static extern IntPtr SendMessageTimeout\(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult\);'/);
  assert.match(script, /::SendMessageTimeout\(\[IntPtr\]0xffff, 0x1A, \[UIntPtr\]::Zero, 'Environment', 2, 5000, \[ref\]\$result\)/);
  assert.ok(script.indexOf('SendMessageTimeout([IntPtr]') > reported, 'the broadcast follows the reported, verified write');
  assert.match(script, /\n\[Console\]::Out\.WriteLine\(\$sent\)\nexit 0$/);
  assert.doesNotMatch(script, /setx/i);
});

test('addWindowsUserPath runs powershell with the encoded script and reads added/present', () => {
  const { spawn, calls } = fakeSpawn({ stdout: 'added\r\nbroadcast\r\n' });
  assert.deepEqual(addWindowsUserPath(WIN_DIR, { spawn }), { ok: true, added: true, broadcast: true, error: null });
  assert.equal(calls.length, 1);
  const { cmd, args } = calls[0];
  assert.equal(cmd, 'powershell');
  assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.equal(calls[0].opts.timeout, WINDOWS_PATH_TIMEOUT_MS);
  assert.equal(decode(args[3]), windowsPathScript(WIN_DIR));
  assert.equal(args[3], encodePowerShell(windowsPathScript(WIN_DIR)));

  assert.ok(calls[0].opts.env, 'PowerShell gets an explicit environment');
  assert.ok(!Object.keys(calls[0].opts.env).some((k) => k.toUpperCase() === 'PSMODULEPATH'));

  const present = fakeSpawn({ stdout: 'present\nno-broadcast\n' });
  assert.deepEqual(addWindowsUserPath(WIN_DIR, present), { ok: true, added: false, broadcast: false, error: null });
});

test('powershellEnv drops PSModulePath under any casing and keeps everything else', () => {
  for (const key of ['PSModulePath', 'PSMODULEPATH', 'psmodulepath']) {
    const env = { Path: 'C:\\Windows', [key]: 'C:\\Program Files\\PowerShell\\7\\Modules', SystemRoot: 'C:\\Windows' };
    assert.deepEqual(powershellEnv(env), { Path: 'C:\\Windows', SystemRoot: 'C:\\Windows' }, key);
    assert.ok(key in env, 'the input is not modified');
  }
  const both = { PSModulePath: 'a', PSMODULEPATH: 'b', PSModulePathX: 'kept' };
  assert.deepEqual(powershellEnv(both), { PSModulePathX: 'kept' });
  assert.deepEqual(powershellEnv({}), {});
});

test('addWindowsUserPath runs PowerShell with the given environment minus PSModulePath', () => {
  const { spawn, calls } = fakeSpawn({ stdout: 'added\nbroadcast\n' });
  const env = { Path: 'C:\\Windows\\System32', PSModulePath: 'C:\\Program Files\\PowerShell\\7\\Modules', USERPROFILE: 'C:\\Users\\u' };
  assert.equal(addWindowsUserPath(WIN_DIR, { spawn, env }).ok, true);
  assert.deepEqual(calls[0].opts.env, { Path: 'C:\\Windows\\System32', USERPROFILE: 'C:\\Users\\u' });
});

test('addWindowsUserPath reports a non-zero exit, a spawn failure and a silent script as not ok', () => {
  const failed = fakeSpawn({ status: 1, stderr: 'Requested registry access is not allowed.\r\n' });
  assert.deepEqual(addWindowsUserPath(WIN_DIR, failed), { ok: false, added: false, broadcast: false, error: 'Requested registry access is not allowed.' });
  const noStderr = fakeSpawn({ status: 3, stdout: 'added\n' });
  assert.equal(addWindowsUserPath(WIN_DIR, noStderr).error, 'PowerShell exited with code 3');
  const missing = fakeSpawn({ status: null, error: Object.assign(new Error('spawnSync powershell ENOENT'), { code: 'ENOENT' }) });
  assert.deepEqual(addWindowsUserPath(WIN_DIR, missing), { ok: false, added: false, broadcast: false, error: 'could not run PowerShell (ENOENT)' });
  const silent = fakeSpawn({ stdout: '' });
  assert.equal(addWindowsUserPath(WIN_DIR, silent).ok, false);
});

test('addWindowsUserPath after a timeout: ok when the verified write was already reported, else not', () => {
  const timedOut = () => Object.assign(new Error('spawnSync powershell ETIMEDOUT'), { code: 'ETIMEDOUT' });
  const afterWrite = fakeSpawn({ status: null, signal: 'SIGTERM', stdout: 'added\r\n', error: timedOut() });
  assert.deepEqual(addWindowsUserPath(WIN_DIR, afterWrite), { ok: true, added: true, broadcast: false, error: null });
  const beforeWrite = fakeSpawn({ status: null, signal: 'SIGTERM', stdout: '', error: timedOut() });
  assert.deepEqual(addWindowsUserPath(WIN_DIR, beforeWrite), { ok: false, added: false, broadcast: false, error: 'PowerShell did not finish within 60 s' });
});

test('ensureUserPath: Windows updates the registry, elsewhere only checks the starting PATH', () => {
  const { spawn, calls } = fakeSpawn({ stdout: 'added\nbroadcast\n' });
  assert.deepEqual(ensureUserPath(WIN_DIR, { platform: 'win32', pathValue: WIN_DIR, spawn }), { windows: true, ok: true, added: true, broadcast: true, error: null });
  assert.equal(calls.length, 1, 'the registry is updated even when the process PATH already has the dir');

  const posix = fakeSpawn({});
  assert.deepEqual(ensureUserPath('/home/u/.local/bin', { platform: 'linux', pathValue: '/usr/bin:/home/u/.local/bin', spawn: posix.spawn }), { windows: false, onPath: true });
  assert.deepEqual(ensureUserPath('/home/u/.local/bin', { platform: 'darwin', pathValue: '/usr/bin', spawn: posix.spawn }), { windows: false, onPath: false });
  assert.equal(posix.calls.length, 0, 'no PowerShell and no profile edit outside Windows');
});

test('onPathDir splits on the platform separator', () => {
  assert.equal(onPathDir('C:\\a', 'C:\\x;C:\\a', 'win32'), true);
  assert.equal(onPathDir('/a', '/x:/a', 'linux'), true);
  assert.equal(onPathDir('/a', '/x:/ab', 'linux'), false);
  assert.equal(onPathDir('/a', undefined, 'linux'), false);
  assert.equal(onPathDir('/home/u/.local/bin', '/usr/bin:/home/u/.local/bin/', 'linux'), true, 'trailing slash');
  assert.equal(onPathDir('C:\\A\\bin', 'c:\\a\\BIN\\;C:\\x', 'win32'), true, 'case and trailing backslash on Windows');
  assert.equal(onPathDir('/A', '/a', 'linux'), false, 'case matters elsewhere');
});

// installedStatus is the tool status the flow builds after a provision.
function installedStatus(path, dir) {
  return { ok: true, version: 'v1.2.3', installedTo: dir, path, verified: true };
}

test('summaryLines on Windows: added, already present, and a failed update', () => {
  const integrity = integrityLine({ verified: true, insecure: false });
  const cases = [
    [
      { stdout: 'added\nbroadcast\n' },
      `[ok] added ${WIN_DIR} to your user PATH. Fully quit Claude Desktop (from the system tray) and any open terminals/IDEs, then reopen them so they see it.`,
    ],
    [
      { stdout: 'added\nno-broadcast\n' },
      `[ok] added ${WIN_DIR} to your user PATH. Fully quit Claude Desktop (from the system tray) and any open terminals/IDEs, then reopen them so they see it. If they still do not find it, sign out of Windows and back in.`,
    ],
    [{ stdout: 'present\nbroadcast\n' }, `[ok] ${WIN_DIR} is already on your user PATH.`],
    [
      { status: 1, stderr: 'Requested registry access is not allowed.\r\n' },
      `[x] could not add ${WIN_DIR} to your user PATH: Requested registry access is not allowed. Add it by hand (Start > "Edit environment variables for your account").`,
    ],
  ];
  for (const [result, pathLine] of cases) {
    const path = ensureUserPath(WIN_DIR, { platform: 'win32', spawn: fakeSpawn(result).spawn });
    const lines = summaryLines('mdtohtml', installedStatus(path, WIN_DIR));
    assert.deepEqual(lines, ['[ok] mdtohtml installed (v1.2.3).', integrity, pathLine], JSON.stringify(result));
    assert.doesNotMatch(lines.join('\n'), /on PATH \(|not on your PATH yet|Add it, then reopen/);
  }
});

test('summaryLines elsewhere: on PATH says nothing more, off PATH names the profile line', () => {
  const dir = '/home/u/.local/bin';
  const integrity = integrityLine({ verified: false, insecure: false });
  const on = ensureUserPath(dir, { platform: 'linux', pathValue: `/usr/bin:${dir}` });
  assert.deepEqual(summaryLines('worklog', { ...installedStatus(on, dir), verified: false }, { home: '/home/u' }), [
    '[ok] worklog installed (v1.2.3).',
    integrity,
    '[!] worklog not initialised here — run `/worklog:init` (or `worklog init`) to activate it.',
  ]);
  const off = ensureUserPath(dir, { platform: 'linux', pathValue: '/usr/bin' });
  assert.deepEqual(summaryLines('mdtohtml', { ...installedStatus(off, dir), verified: false }, { home: '/home/u' }), [
    '[ok] mdtohtml installed (v1.2.3).',
    integrity,
    '[!] /home/u/.local/bin is not on your PATH. Add it in your shell profile, e.g. export PATH="$HOME/.local/bin:$PATH", then open a new terminal.',
  ]);
  // A directory outside HOME is shown literally.
  assert.deepEqual(pathLines('/opt/bin', off, { home: '/home/u' }), [
    '[!] /opt/bin is not on your PATH. Add it in your shell profile, e.g. export PATH="/opt/bin:$PATH", then open a new terminal.',
  ]);
});

test('summaryLines for a binary that was already found keeps "on PATH"', () => {
  assert.deepEqual(summaryLines('mdtohtml', { ok: true, version: 'mdtohtml 0.4.0' }), ['[ok] mdtohtml on PATH (mdtohtml 0.4.0).']);
});
