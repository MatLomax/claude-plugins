// Self-update: before the interactive flow, ask GitHub for the latest
// installer release and, when it is newer than this one, hand over to it via
// `npx <versioned tarball>`. The check fails open: any trouble reaching or
// reading the release keeps the current installer running. --no-self-update
// skips it entirely.

import { forwardArgs } from './args.mjs';

export const LATEST_RELEASE_API = 'https://api.github.com/repos/MatLomax/claude-plugins/releases/latest';
export const RELAUNCH_ENV = 'CLAUDE_PLUGINS_RELAUNCHED';
export const CHECK_TIMEOUT_MS = 5000;

// The relaunch command line passes through cmd.exe on Windows, so each part
// must be free of shell metacharacters. Versions are digits-and-dots and flags
// are fixed names, so this always holds; the check keeps it that way.
const SHELL_SAFE = /^[A-Za-z0-9._:/=@-]+$/;

// parseSemver accepts `X.Y.Z` or `vX.Y.Z` and returns [X, Y, Z], or null for
// anything else (including pre-release and build suffixes).
export function parseSemver(s) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(s ?? '').trim());
  return m ? m.slice(1).map(Number) : null;
}

// isNewer reports whether `candidate` is strictly greater than `current`;
// false when either is unparsable.
export function isNewer(candidate, current) {
  const a = parseSemver(candidate);
  const b = parseSemver(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

// versionedTarballUrl points straight at the GitHub release asset, so the
// relaunch reaches it from any network that reached the release at all.
export function versionedTarballUrl(version) {
  return `https://github.com/MatLomax/claude-plugins/releases/download/v${version}/claude-plugins-${version}.tgz`;
}

// fetchLatestVersion returns the latest release's version as `X.Y.Z`, or null
// on any failure (offline, rate limit, no release, bad JSON, timeout).
export async function fetchLatestVersion({ fetchJson, url = LATEST_RELEASE_API, insecure = false, timeoutMs = CHECK_TIMEOUT_MS }) {
  try {
    const rel = await fetchJson(url, { insecure, signal: AbortSignal.timeout(timeoutMs) });
    const v = parseSemver(rel && rel.tag_name);
    return v ? v.join('.') : null;
  } catch {
    return null;
  }
}

// manualCommand is what the user runs by hand when the relaunch fails. Under
// --insecure npm's own fetch of the tarball needs strict-ssl off as well.
export function manualCommand(version, forwarded, insecure) {
  const parts = ['npx'];
  if (insecure) parts.push('--strict-ssl=false');
  parts.push(versionedTarballUrl(version), ...forwarded);
  return parts.join(' ');
}

// relaunchPlan builds the spawn call that runs the newer installer with the
// same flags. The child's env marks it as relaunched so it skips this check.
// On Windows npx is a .cmd, which Node only runs through a shell; an args
// array with `shell: true` is deprecated (DEP0190), so the plan there is one
// command string built from the shell-safe parts, with no args array.
export function relaunchPlan({ version, forwarded, insecure, platform, env }) {
  const win = platform === 'win32';
  const parts = ['-y', versionedTarballUrl(version), ...forwarded];
  for (const a of parts) {
    if (!SHELL_SAFE.test(a)) throw new Error(`refusing to relaunch with unsafe argument ${JSON.stringify(a)}`);
  }
  const childEnv = { ...env, [RELAUNCH_ENV]: '1' };
  if (insecure) childEnv.npm_config_strict_ssl = 'false';
  return {
    command: win ? ['npx', ...parts].join(' ') : 'npx',
    args: win ? [] : parts,
    options: { stdio: 'inherit', env: childEnv, shell: win },
    manual: manualCommand(version, forwarded, insecure),
  };
}

// runChild resolves to { error } when the process could not start, else to
// { code } with a signal death reported as 1.
function runChild(spawn, plan) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(plan.command, plan.args, plan.options);
    } catch (error) {
      resolve({ error });
      return;
    }
    child.on('error', (error) => resolve({ error }));
    child.on('exit', (code) => resolve({ code: code ?? 1 }));
  });
}

// selfUpdate runs the check and, when a newer release exists, the relaunch.
// It resolves to { action: 'continue' } (run this installer) or
// { action: 'exit', code } (the newer installer ran, or the user must run it).
export async function selfUpdate({
  ownVersion,
  cli,
  fetchJson,
  spawn,
  env = process.env,
  platform = process.platform,
  out = (line) => console.error(line),
  url = LATEST_RELEASE_API,
  timeoutMs = CHECK_TIMEOUT_MS,
}) {
  if (cli['no-self-update'] || env[RELAUNCH_ENV] === '1') return { action: 'continue' };
  const latest = await fetchLatestVersion({ fetchJson, url, insecure: cli.insecure, timeoutMs });
  if (!latest || !isNewer(latest, ownVersion)) return { action: 'continue' };

  const plan = relaunchPlan({ version: latest, forwarded: forwardArgs(cli), insecure: cli.insecure, platform, env });
  out(`[!] newer installer v${latest} available (this is v${ownVersion}), relaunching ...`);
  const result = await runChild(spawn, plan);
  if (result.error) {
    out(`[x] could not start npx (${result.error.message}). Run the newer installer yourself:\n  ${plan.manual}`);
    return { action: 'exit', code: 1 };
  }
  if (result.code !== 0) {
    out(`[x] the newer installer exited with code ${result.code}. If npm could not fetch it, run it yourself:\n  ${plan.manual}`);
    return { action: 'exit', code: result.code };
  }
  return { action: 'exit', code: 0 };
}
