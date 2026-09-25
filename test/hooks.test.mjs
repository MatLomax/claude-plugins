// Plugin hooks must be a silent no-op when their tool binary is not on PATH,
// and a transparent passthrough (same argv, stdout, exit code) when it is.
// CONVENTIONS.md §2 "Hook command shape" is the contract under test.
//
// Each command is executed the way Claude Code executes a shell-form command
// hook: `sh -c` on Linux/macOS, Git Bash (bash) on Windows, PowerShell when
// Git Bash is absent. On Linux/macOS, sh and bash always run and PowerShell
// runs when `pwsh` is on PATH (or PWSH points at it), with a POSIX sh stand-in
// tool. On Windows:
// - Git Bash (`<Git>\bin\bash.exe -c`, Claude Code's first choice) runs when
//   Git for Windows is installed, with an extensionless `#!/bin/sh` stand-in
//   (bash's `command -v` does not find a `.cmd`) and PATH = stand-in dir +
//   Git's `usr\bin`, given Windows-style (`C:\...;C:\...`): the MSYS2 runtime
//   upper-cases the `Path` name to `PATH` and converts the value to POSIX form
//   (`/c/...:/c/...`) when bash starts from a non-MSYS process.
// - PowerShell 7 (`pwsh.exe`) runs when it is on PATH (or PWSH points at it),
//   and Windows PowerShell 5.1 (`powershell.exe`, Claude Code's last fallback)
//   always runs, both with a `.cmd` stand-in, which Get-Command -CommandType
//   Application finds through PATHEXT.
// Stand-in markers are compared by tool name on Windows, by path elsewhere.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';

// Every command hook the binary-backed plugins ship, as the bare invocation the
// guard wraps. A hook added, dropped, or changed without updating this list fails.
const EXPECTED = {
  worklog: {
    SessionStart: [['session-start'], ['update', '--auto']],
    Stop: [['session-end']],
  },
  mdtohtml: {
    SessionStart: [['update', '--auto']],
  },
};

// The canonical guarded form (CONVENTIONS.md §2). One string that is valid in
// POSIX sh, bash and PowerShell: sh runs the `if command -v` guard and exits
// before `#>`, which sh reads as a comment; PowerShell reads `"\"` as a
// complete string, so `<# ... #>` is a block comment hiding the sh part, then
// runs its own Get-Command guard.
function guarded(bin, args) {
  const inv = [bin, ...args].join(' ');
  return (
    `echo "\\" | Out-Null <# " >/dev/null; ` +
    `if command -v ${bin} >/dev/null 2>&1; then ${inv}; fi; exit $? #> ; ` +
    `if (Get-Command ${bin} -CommandType Application -ErrorAction SilentlyContinue) { ${inv}; exit $LASTEXITCODE }; exit 0`
  );
}

function loadHooks(plugin) {
  const file = join(root, 'plugins', plugin, 'hooks', 'hooks.json');
  const { hooks } = JSON.parse(readFileSync(file, 'utf8'));
  const out = [];
  for (const [event, groups] of Object.entries(hooks)) {
    for (const group of groups) {
      for (const hook of group.hooks) out.push({ event, hook });
    }
  }
  return out;
}

function which(name) {
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    const p = join(dir, name);
    if (dir && existsSync(p)) return p;
  }
  return null;
}

// findGitBash locates Git for Windows: the default install directory, then the
// install root above `git --exec-path` and above every `where git` hit. It
// returns { bash, usrBin } (the `bin\bash.exe` launcher Claude Code runs, and
// the `usr\bin` holding sh, cat and the other MSYS tools), or null.
function findGitBash() {
  if (!isWindows) return null;
  const starts = [join(process.env.ProgramFiles || 'C:\\Program Files', 'Git')];
  const execPath = spawnSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true });
  if (execPath.status === 0) starts.push(execPath.stdout.trim());
  const where = spawnSync('where', ['git'], { encoding: 'utf8', windowsHide: true });
  if (where.status === 0) starts.push(...where.stdout.split(/\r?\n/).filter(Boolean));
  for (const start of starts) {
    for (let d = resolve(start); ; d = dirname(d)) {
      const bash = join(d, 'bin', 'bash.exe');
      const usrBin = join(d, 'usr', 'bin');
      if (existsSync(bash) && existsSync(join(usrBin, 'sh.exe'))) return { bash, usrBin };
      if (dirname(d) === d) break;
    }
  }
  return null;
}

const POSIX_ONLY = 'POSIX sh/bash leg, Linux/macOS only; on Windows the Git Bash leg runs instead';
const system32 = isWindows ? join(process.env.SystemRoot || 'C:\\Windows', 'System32') : '';
const windowsPowerShell = join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const gitBash = findGitBash();
const pwsh = process.env.PWSH || which(isWindows ? 'pwsh.exe' : 'pwsh');

// Each shell names its executable, whether it is present, why it is skipped
// on this OS (if it is), and on Windows which stand-in it runs: `cmd` (a
// `<tool>.cmd`, PATH = stand-in dir + System32) or `sh` (an extensionless
// `#!/bin/sh` script, PATH = stand-in dir + Git's usr\bin).
const SHELLS = [
  { name: 'sh', argv: (cmd) => ['/bin/sh', ['-c', cmd]], present: existsSync('/bin/sh'), skip: isWindows && POSIX_ONLY },
  { name: 'bash', argv: (cmd) => [which('bash'), ['-c', cmd]], present: !!which('bash'), skip: isWindows && POSIX_ONLY },
  {
    name: 'git bash',
    argv: (cmd) => [gitBash.bash, ['-c', cmd]],
    present: !!gitBash,
    skip: !isWindows ? 'Git Bash leg, Windows only' : !gitBash && 'Git for Windows not found (no <ProgramFiles>\\Git\\bin\\bash.exe, and no Git root above `git --exec-path` or `where git`)',
    windowsShim: 'sh',
  },
  {
    name: 'powershell',
    argv: (cmd) => [pwsh, ['-NoProfile', '-NonInteractive', '-Command', cmd]],
    present: !!pwsh,
    skip: false,
    windowsShim: 'cmd',
  },
  {
    name: 'windows powershell 5.1',
    argv: (cmd) => [windowsPowerShell, ['-NoProfile', '-NonInteractive', '-Command', cmd]],
    present: isWindows && existsSync(windowsPowerShell),
    skip: !isWindows && 'Windows PowerShell 5.1 exists only on Windows',
    windowsShim: 'cmd',
  },
];

// A stand-in tool binary: records its argv (one per line) to $SHIM_ARGV_FILE,
// prints a marker to stdout (`SHIM-MARKER <marker>`, by default its own path
// $0), and exits with $SHIM_EXIT.
function makeShim(dir, bin, marker = '$0') {
  const p = join(dir, bin);
  writeFileSync(
    p,
    '#!/bin/sh\n' +
      'printf "%s\\n" "$@" > "$SHIM_ARGV_FILE"\n' +
      `echo "SHIM-MARKER ${marker}"\n` +
      'exit "${SHIM_EXIT:-0}"\n',
  );
  chmodSync(p, 0o755);
  return p;
}

// The Windows stand-in tool: a `<bin>.cmd` batch file that records its argv
// (one per line) to %SHIM_ARGV_FILE%, prints a marker naming the tool, and
// exits with %SHIM_EXIT%.
// The real tools are .exe files; this exercises the hook's Get-Command guard,
// argv, stdout and $LASTEXITCODE through a batch file (run via cmd.exe), not
// .exe resolution.
function makeCmdShim(dir, bin) {
  const p = join(dir, `${bin}.cmd`);
  writeFileSync(
    p,
    [
      '@echo off',
      'type nul > "%SHIM_ARGV_FILE%"',
      'for %%a in (%*) do >>"%SHIM_ARGV_FILE%" echo(%%~a',
      `echo SHIM-MARKER ${bin}`,
      'exit /b %SHIM_EXIT%',
      '',
    ].join('\r\n'),
  );
  return p;
}

// windowsEnv is the parent environment with PATH replaced by `dirs` (any
// casing of the PATH key dropped, since Windows keys are case-insensitive).
function windowsEnv(dirs, extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== 'PATH'));
  return { ...env, Path: dirs.join(delimiter), ...extra };
}

// run executes one hook command the way Claude Code does, with a JSON payload
// on stdin. A hook that skips its tool exits without reading stdin, so writing
// the payload can race the exit and fail with EPIPE; spawnSync still reports the
// real status and output then, so EPIPE alone is not an error.
function run(shell, cmd, env) {
  const [exe, args] = shell.argv(cmd);
  const r = spawnSync(exe, args, { env, encoding: 'utf8', input: '{}' });
  if (r.error?.code === 'EPIPE') delete r.error;
  return r;
}

test('every plugin that ships hooks/hooks.json is covered here', () => {
  const withHooks = readdirSync(join(root, 'plugins'))
    .filter((p) => existsSync(join(root, 'plugins', p, 'hooks', 'hooks.json')))
    .sort();
  assert.deepEqual(withHooks, Object.keys(EXPECTED).sort());
});

for (const [plugin, events] of Object.entries(EXPECTED)) {
  test(`${plugin}: hooks.json carries exactly the expected guarded command hooks`, () => {
    const got = loadHooks(plugin);
    const want = Object.entries(events).flatMap(([event, invs]) =>
      invs.map((args) => ({ event, hook: { type: 'command', command: guarded(plugin, args) } })),
    );
    assert.deepEqual(got, want);
  });

  for (const shell of SHELLS) {
    for (const { event, hook } of loadHooks(plugin)) {
      const args = EXPECTED[plugin][event].find((a) => hook.command === guarded(plugin, a));
      const label = `${plugin} ${event} \`${[plugin, ...(args || ['?'])].join(' ')}\` under ${shell.name}`;
      const skip = shell.skip || (!shell.present && `${shell.name} not available on this machine`);

      test(`${label}: binary absent -> exit 0, no output`, { skip }, () => {
        assert.ok(args, 'hook is not in the canonical guarded form');
        const empty = mkdtempSync(join(tmpdir(), 'hooks-empty-'));
        try {
          let env = { PATH: empty, HOME: empty };
          if (isWindows) env = shell.windowsShim === 'sh' ? windowsEnv([gitBash.usrBin], { HOME: empty }) : windowsEnv([system32]);
          const r = run(shell, hook.command, env);
          assert.equal(r.error, undefined);
          assert.equal(r.stderr, '', 'stderr must be empty');
          assert.equal(r.stdout, '', 'stdout must be empty');
          assert.equal(r.status, 0);
        } finally {
          rmSync(empty, { recursive: true, force: true });
        }
      });

      for (const code of [0, 2, 3]) {
        test(`${label}: binary present, exits ${code} -> same argv, stdout passthrough, exit ${code}`, { skip }, () => {
          assert.ok(args, 'hook is not in the canonical guarded form');
          const dir = mkdtempSync(join(tmpdir(), 'hooks-shim-'));
          try {
            const argvFile = join(dir, 'argv.txt');
            const shimEnv = { SHIM_ARGV_FILE: argvFile, SHIM_EXIT: String(code) };
            let marker;
            let env;
            if (isWindows && shell.windowsShim === 'sh') {
              makeShim(dir, plugin, plugin);
              marker = `SHIM-MARKER ${plugin}`;
              env = windowsEnv([dir, gitBash.usrBin], { HOME: dir, ...shimEnv });
            } else if (isWindows) {
              makeCmdShim(dir, plugin);
              marker = `SHIM-MARKER ${plugin}`;
              env = windowsEnv([dir, system32], shimEnv);
            } else {
              marker = `SHIM-MARKER ${makeShim(dir, plugin)}`;
              env = { PATH: `${dir}${delimiter}/usr/bin${delimiter}/bin`, HOME: dir, ...shimEnv };
            }
            const r = run(shell, hook.command, env);
            assert.equal(r.error, undefined);
            assert.equal(r.stderr, '');
            assert.equal(r.stdout.replace(/\r\n/g, '\n'), `${marker}\n`);
            assert.equal(r.status, code);
            assert.deepEqual(readFileSync(argvFile, 'utf8').split(/\r?\n/).slice(0, -1), args);
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        });
      }
    }
  }
}
