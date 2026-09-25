// Making an installed binary's directory reachable from new processes: on
// Windows the directory is appended to the user PATH in the registry and the
// change is broadcast so Explorer (and apps it launches, like Claude Desktop)
// pick it up; on macOS and Linux the directory is only checked against PATH,
// because shell profiles are left to the user.

import { spawnSync } from 'node:child_process';

// psQuote renders `value` as a PowerShell single-quoted string literal. Inside
// one, PowerShell treats `'` and the typographic single quotes U+2018, U+2019,
// U+201A and U+201B alike as the delimiter, and a doubled delimiter as one
// literal quote.
export function psQuote(value) {
  return `'${String(value).replace(/['\u2018\u2019\u201A\u201B]/g, (q) => q + q)}'`;
}

// powershellEnv is `env` without its PSModulePath variable (under any
// casing), for spawning Windows PowerShell 5.1 (`powershell`). A process
// started from PowerShell 7 inherits 7's PSModulePath, whose 7-only module
// folders precede 5.1's own, so 5.1 resolves shared modules such as
// Microsoft.PowerShell.Utility (Add-Type) or Microsoft.PowerShell.Archive
// (Expand-Archive) to 7's copies, which it cannot load. Without the variable,
// 5.1 builds its default module path at startup.
export function powershellEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => k.toUpperCase() !== 'PSMODULEPATH'));
}

// The longest the PATH update may take before the installer stops waiting.
export const WINDOWS_PATH_TIMEOUT_MS = 60000;

// The P/Invoke declaration for user32's SendMessageTimeout, compiled by
// Add-Type at run time.
const SEND_MESSAGE_TIMEOUT =
  '[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] ' +
  'public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);';

// windowsPathScript is the PowerShell script that appends `dir` to the user
// PATH (HKCU\Environment `Path`) unless it is already listed, comparing
// entries with %VAR% expanded and trailing backslashes dropped (PowerShell's
// -eq ignores case). It reads the raw value (DoNotExpandEnvironmentNames) and
// writes it back as REG_EXPAND_SZ so %VAR% indirections survive, then reads the
// value back and fails (exit 1, reason on stderr) unless `dir` is in it. It
// prints `added` or `present` as soon as the write is verified, then
// broadcasts WM_SETTINGCHANGE "Environment" to every top-level window and
// prints `broadcast` or `no-broadcast`. Output is UTF-8.
export function windowsPathScript(dir) {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}',
    `$d = ${psQuote(dir)}`,
    "function Test-Listed([string]$value) { @($value -split ';' | Where-Object { $_ -ne '' -and [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\\') -eq $d.TrimEnd('\\') }).Count -gt 0 }",
    'try {',
    "  $k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')",
    "  $raw = [string]$k.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
    '  $added = $false',
    '  if (-not (Test-Listed $raw)) {',
    "    $e = @($raw -split ';' | Where-Object { $_ -ne '' })",
    "    $k.SetValue('Path', (($e + $d) -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)",
    '    $added = $true',
    '  }',
    "  $check = [string]$k.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
    '  $k.Dispose()',
    '} catch {',
    '  [Console]::Error.WriteLine($_.Exception.Message)',
    '  exit 1',
    '}',
    'if (-not (Test-Listed $check)) {',
    "  [Console]::Error.WriteLine('the user Path read back from the registry does not contain the directory')",
    '  exit 1',
    '}',
    "if ($added) { [Console]::Out.WriteLine('added') } else { [Console]::Out.WriteLine('present') }",
    '[Console]::Out.Flush()',
    "$sent = 'no-broadcast'",
    'try {',
    `  Add-Type -Namespace ClaudePluginsInstall -Name User32 -MemberDefinition ${psQuote(SEND_MESSAGE_TIMEOUT)}`,
    '  $result = [UIntPtr]::Zero',
    "  $ret = [ClaudePluginsInstall.User32]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)",
    "  if ($ret -ne [IntPtr]::Zero) { $sent = 'broadcast' }",
    '} catch {}',
    '[Console]::Out.WriteLine($sent)',
    'exit 0',
  ].join('\n');
}

// encodePowerShell encodes a script for `powershell -EncodedCommand` (base64
// of its UTF-16LE bytes), so no Windows command-line quoting touches it.
export function encodePowerShell(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

// addWindowsUserPath runs windowsPathScript(dir) and resolves to
// { ok, added, broadcast, error }: `ok` is true only when the script verified
// the registry holds `dir`, `added` when this run appended it, `broadcast` when
// the WM_SETTINGCHANGE broadcast was delivered, and `error` says why `ok` is
// false. PowerShell runs with powershellEnv(env). A run that outlives
// WINDOWS_PATH_TIMEOUT_MS is stopped; it still counts as ok when it had
// already reported the verified write.
export function addWindowsUserPath(dir, { spawn = spawnSync, env = process.env } = {}) {
  const r = spawn('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(windowsPathScript(dir))], {
    env: powershellEnv(env),
    encoding: 'utf8',
    windowsHide: true,
    timeout: WINDOWS_PATH_TIMEOUT_MS,
  });
  const lines = String(r.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const reported = lines.includes('added') || lines.includes('present');
  const result = (ok, error) => ({ ok, added: ok && lines.includes('added'), broadcast: ok && lines.includes('broadcast'), error });
  if (r.error) {
    if (r.error.code === 'ETIMEDOUT') {
      return reported ? result(true, null) : result(false, `PowerShell did not finish within ${WINDOWS_PATH_TIMEOUT_MS / 1000} s`);
    }
    return result(false, `could not run PowerShell (${r.error.code || r.error.message})`);
  }
  if (r.status !== 0) {
    const stderr = String(r.stderr || '').trim();
    return result(false, stderr || `PowerShell exited with code ${r.status}`);
  }
  if (!reported) return result(false, 'PowerShell did not report the result of the PATH update');
  return result(true, null);
}

// onPathDir reports whether `dir` is an entry of the PATH value `pathValue`,
// ignoring trailing separators (and, on Windows, case).
export function onPathDir(dir, pathValue, platform = process.platform) {
  const windows = platform === 'win32';
  const norm = (p) => {
    const trimmed = p.replace(windows ? /[\\/]+$/ : /\/+$/, '') || p;
    return windows ? trimmed.toLowerCase() : trimmed;
  };
  const want = norm(dir);
  return String(pathValue || '').split(windows ? ';' : ':').filter(Boolean).some((p) => norm(p) === want);
}

// ensureUserPath makes `dir` reachable from new processes where the installer
// can, and reports it. On Windows: { windows: true, ok, added, broadcast,
// error } from addWindowsUserPath. Elsewhere: { windows: false, onPath }, with
// `onPath` measured against `pathValue` (the PATH the installer started with).
export function ensureUserPath(dir, { platform = process.platform, pathValue = '', spawn = spawnSync } = {}) {
  if (platform === 'win32') return { windows: true, ...addWindowsUserPath(dir, { spawn }) };
  return { windows: false, onPath: onPathDir(dir, pathValue, platform) };
}

// pathLines is the summary for a freshly installed binary's directory, given
// ensureUserPath's report. `home` shortens a directory under it to `$HOME/...`
// in the shell-profile example.
export function pathLines(dir, path, { home = '' } = {}) {
  if (!path) return [];
  if (path.windows) {
    if (!path.ok) {
      const reason = String(path.error || 'unknown error').replace(/\s+/g, ' ').replace(/[.\s]+$/, '');
      return [`[x] could not add ${dir} to your user PATH: ${reason}. Add it by hand (Start > "Edit environment variables for your account").`];
    }
    const reopen = path.broadcast
      ? ''
      : ' If they still do not find it, sign out of Windows and back in.';
    if (path.added) {
      return [`[ok] added ${dir} to your user PATH. Fully quit Claude Desktop (from the system tray) and any open terminals/IDEs, then reopen them so they see it.${reopen}`];
    }
    return [`[ok] ${dir} is already on your user PATH.`];
  }
  if (path.onPath) return [];
  const shown = home && dir.startsWith(home + '/') ? '$HOME' + dir.slice(home.length) : dir;
  return [`[!] ${dir} is not on your PATH. Add it in your shell profile, e.g. export PATH="${shown}:$PATH", then open a new terminal.`];
}
