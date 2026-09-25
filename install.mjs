#!/usr/bin/env node
// Interactive installer for the `matlomax` Claude Code plugin marketplace.
//
// Run from the root of the repo you want to enable the plugins in:
//   npx https://matlomax.com/claude-plugins.tgz
//
// It multiselects the marketplace's plugins (all off by default) and deep-merges
// `.claude/settings.json` in the current repo — registering the marketplace and
// setting exactly the plugins you tick as enabled (the multiselect is
// authoritative for this marketplace's plugins; unrelated settings are left
// untouched). For a
// plugin backed by a CLI binary (worklog, mdtohtml) it offers to install that
// binary by downloading the latest release for your platform (SHA-256 verified
// when the release publishes a checksum) and placing it on PATH; after that each
// tool keeps itself current via its own `<tool> update`. It never requires a
// language toolchain.
//
// Before the prompts it checks GitHub for a newer installer release and, if
// there is one, relaunches as `npx <that release's claude-plugins-<v>.tgz>`
// (`--no-self-update` skips this). `--insecure` skips certificate checks on the
// installer's own downloads for networks that intercept HTTPS; see `--help`.

import { intro, outro, multiselect, confirm, note, log, isCancel, cancel } from '@clack/prompts';
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, renameSync, copyFileSync, rmSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseCli, parseErrorMessage, USAGE } from './lib/args.mjs';
import { fetchJson, download } from './lib/net.mjs';
import { describeError, integrityLine, INSECURE_WARNING } from './lib/tls.mjs';
import { selfUpdate } from './lib/selfupdate.mjs';

// The installer's version is the package.json shipped beside this script (in
// the repo and in the release tarball alike).
const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;

const MARKETPLACE_ID = 'matlomax';
const REPO = 'MatLomax/claude-plugins';
const KNOWN_PLUGINS = ['worklog', 'image-to-html', 'mdtohtml'];

// Plugins backed by a release CLI binary the installer can provision. Asset
// naming and layout differ per tool, so each carries its own mapping.
const TOOLS = {
  worklog: {
    repo: 'MatLomax/worklog',
    bin: 'worklog',
    versionArgs: ['version'],
    kind: 'binary', // a bare executable
    osMap: { linux: 'linux', darwin: 'darwin', win32: 'windows' },
    archMap: { x64: 'amd64', arm64: 'arm64' },
    releases: 'https://github.com/MatLomax/worklog/releases',
  },
  mdtohtml: {
    repo: 'MatLomax/mdtohtml',
    bin: 'mdtohtml',
    versionArgs: ['--version'],
    kind: 'zip', // a zip of the binary + a themes/ folder
    osMap: { linux: 'linux', win32: 'windows' }, // no macOS release published
    archMap: { x64: 'x86_64' },
    releases: 'https://github.com/MatLomax/mdtohtml/releases',
  },
};

const cwd = process.cwd();
const settingsPath = join(cwd, '.claude', 'settings.json');
const isWindows = process.platform === 'win32';

// Parsed command line; `insecure` is read by every download below.
let cli = { insecure: false };

// --- small helpers ---------------------------------------------------------

function bail() {
  cancel('Cancelled — no changes written.');
  process.exit(0);
}

function guard(value) {
  if (isCancel(value)) bail();
  return value;
}

function readJson(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) || {};
  } catch (err) {
    throw new Error(`${path} exists but is not valid JSON (${err.message}). Fix or remove it, then re-run.`);
  }
}

function writeJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function onPathDir(dir) {
  return (process.env.PATH || '').split(isWindows ? ';' : ':').includes(dir);
}

// --- release download / verify / place ------------------------------------

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function assetFor(tool) {
  const os = tool.osMap[process.platform];
  const arch = tool.archMap[process.arch];
  if (!os || !arch) return null;
  if (tool.kind === 'zip') return `${tool.bin}-${os}-${arch}.zip`;
  return `${tool.bin}-${os}-${arch}${os === 'windows' ? '.exe' : ''}`;
}

function moveInto(src, dst) {
  try {
    renameSync(src, dst); // fast path when src and dst share a filesystem
  } catch {
    copyFileSync(src, dst); // temp dir may be on another filesystem
    rmSync(src, { force: true });
  }
}

function extractZip(zip, dir) {
  mkdirSync(dir, { recursive: true });
  if (isWindows) {
    const z = zip.replace(/'/g, "''");
    const d = dir.replace(/'/g, "''");
    const r = spawnSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Path '${z}' -DestinationPath '${d}' -Force`], { stdio: 'ignore' });
    if (r.error || r.status !== 0) throw new Error('could not extract the zip (Expand-Archive failed)');
  } else {
    const r = spawnSync('unzip', ['-oq', zip, '-d', dir], { stdio: 'ignore' });
    if (r.error || r.status !== 0) throw new Error('could not extract the zip (is `unzip` installed?)');
  }
}

// addWindowsUserPath appends dir to the user PATH, preserving %VAR% indirections
// by reading/writing the raw REG_EXPAND_SZ value. A newly opened terminal reads
// the updated value from the registry (the installer tells the user to reopen).
function addWindowsUserPath(dir) {
  const d = dir.replace(/'/g, "''");
  const ps = [
    `$d='${d}'`,
    `$k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')`,
    `$raw=[string]$k.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)`,
    `$e=@($raw -split ';' | Where-Object {$_ -ne ''})`,
    `if($e -notcontains $d){$k.SetValue('Path',(($e+$d) -join ';'),[Microsoft.Win32.RegistryValueKind]::ExpandString)}`,
    `$k.Dispose()`,
  ].join('; ');
  spawnSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' });
}

// place installs the downloaded artifact and returns where the binary landed and
// whether it is already reachable on PATH.
function place(tool, artifact) {
  if (tool.kind === 'binary') {
    const binDir = isWindows ? join(process.env.LOCALAPPDATA || homedir(), 'Programs', tool.bin) : join(homedir(), '.local', 'bin');
    mkdirSync(binDir, { recursive: true });
    const target = join(binDir, tool.bin + (isWindows ? '.exe' : ''));
    moveInto(artifact, target);
    if (!isWindows) chmodSync(target, 0o755);
    if (isWindows) addWindowsUserPath(binDir);
    return { dir: binDir, onPath: onPathDir(binDir) };
  }
  // zip: extract the binary + themes/ together into an install dir.
  const installDir = isWindows ? join(process.env.LOCALAPPDATA || homedir(), 'Programs', tool.bin) : join(homedir(), '.local', 'share', tool.bin);
  extractZip(artifact, installDir);
  const exe = join(installDir, tool.bin + (isWindows ? '.exe' : ''));
  if (isWindows) {
    addWindowsUserPath(installDir);
    return { dir: installDir, onPath: onPathDir(installDir) };
  }
  chmodSync(exe, 0o755);
  const binDir = join(homedir(), '.local', 'bin');
  mkdirSync(binDir, { recursive: true });
  const link = join(binDir, tool.bin);
  rmSync(link, { force: true });
  symlinkSync(exe, link); // themes/ resolves through the symlink at runtime
  return { dir: binDir, onPath: onPathDir(binDir) };
}

// provision downloads + verifies + installs the latest release for a tool.
async function provision(id) {
  const tool = TOOLS[id];
  const asset = assetFor(tool);
  if (!asset) {
    return { ok: false, msg: `no prebuilt ${id} binary for ${process.platform}/${process.arch}; build from source or see ${tool.releases}` };
  }
  let rel;
  try {
    rel = await fetchJson(`https://api.github.com/repos/${tool.repo}/releases/latest`, { insecure: cli.insecure });
  } catch (e) {
    return { ok: false, msg: `could not reach the latest ${id} release: ${describeError(e)}` };
  }
  const a = (rel.assets || []).find((x) => x.name === asset);
  if (!a) return { ok: false, msg: `the latest ${id} release (${rel.tag_name}) has no asset ${asset}` };

  const artifact = join(tmpdir(), `${id}-${Date.now()}-${asset}`);
  try {
    await download(a.browser_download_url, artifact, { insecure: cli.insecure });
    const digest = (a.digest || '').startsWith('sha256:') ? a.digest.slice('sha256:'.length) : '';
    if (digest) {
      const actual = sha256(artifact);
      if (actual !== digest) throw new Error(`checksum mismatch (expected ${digest}, got ${actual})`);
    }
    const placed = place(tool, artifact);
    return { ok: true, version: rel.tag_name, verified: Boolean(digest), ...placed };
  } catch (e) {
    return { ok: false, msg: describeError(e) };
  } finally {
    rmSync(artifact, { force: true });
  }
}

// --- tool runtime checks ---------------------------------------------------

// onPath reports the tool's version via `<tool> <versionArgs>`, or not-found.
function onPath(id) {
  const tool = TOOLS[id];
  const r = spawnSync(tool.bin, tool.versionArgs, { encoding: 'utf8' });
  if (r.error || r.status !== 0) return { ok: false, version: null };
  return { ok: true, version: (r.stdout || '').trim() };
}

// worklog is attach-only: `worklog init` creates ./.worklog/tasks.db (idempotent).
function worklogInit() {
  const r = spawnSync('worklog', ['init'], { cwd, encoding: 'utf8' });
  return { ok: !r.error && r.status === 0, out: (r.stdout || r.stderr || '').trim() };
}

// setupTool verifies a tool and, when missing, offers to install its release.
async function setupTool(id) {
  const status = onPath(id);
  if (status.ok) return status;
  const doInstall = guard(
    await confirm({
      message: `${id} is not on PATH. Download and install the latest release now?`,
      initialValue: true,
    })
  );
  if (!doInstall) return status;
  log.message(`Downloading the latest ${id} release ...`);
  const res = await provision(id);
  if (!res.ok) {
    note(`Could not install ${id}: ${res.msg}`, id);
    return status;
  }
  // Make the freshly-installed binary reachable for the rest of THIS run (e.g.
  // `worklog init`). `res.onPath` was measured before this mutation, so it still
  // reflects whether a *new shell* would find it. The persistent PATH edit only
  // takes effect in future shells.
  if (res.dir) process.env.PATH = res.dir + (isWindows ? ';' : ':') + (process.env.PATH || '');
  return { ok: true, version: res.version, installedTo: res.dir, onPath: res.onPath, verified: res.verified };
}

// --- main ------------------------------------------------------------------

// parseCommandLine handles --help / --version (print and exit, before any
// network or prompt) and rejects unknown flags with exit code 2.
function parseCommandLine(argv) {
  let parsed;
  try {
    parsed = parseCli(argv);
  } catch (err) {
    console.error(`claude-plugins-install: ${parseErrorMessage(err)}\n\n${USAGE}`);
    process.exit(2);
  }
  if (parsed.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (parsed.version) {
    console.log(VERSION);
    process.exit(0);
  }
  return parsed;
}

async function main() {
  cli = parseCommandLine(process.argv.slice(2));

  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.error('claude-plugins-install is interactive — run it in a terminal (not piped or in CI).');
    process.exit(1);
  }

  if (cli.insecure) console.error(INSECURE_WARNING);

  const update = await selfUpdate({ ownVersion: VERSION, cli, fetchJson, spawn });
  if (update.action === 'exit') process.exit(update.code);

  intro('matlomax plugins');
  log.message(`Enabling the marketplace "${MARKETPLACE_ID}" (${REPO}) in:\n${cwd}`);

  const plugins = guard(
    await multiselect({
      message: 'Which plugins to enable in this repo? (all off by default — tick what you want)',
      options: [
        { value: 'worklog', label: 'worklog', hint: 'Per-project SQLite task & decision log (release binary, checked below)' },
        { value: 'mdtohtml', label: 'mdtohtml', hint: 'Convert extended Markdown to self-contained HTML (release binary, checked below)' },
        { value: 'image-to-html', label: 'image-to-html', hint: 'Reconstruct HTML from a mockup and gate the render against it' },
      ],
      initialValues: [],
      required: true,
    })
  );

  // Verify (and offer to install) each release-backed tool that was chosen.
  const toolStatus = {};
  for (const id of plugins) {
    if (TOOLS[id]) toolStatus[id] = await setupTool(id);
  }

  // With a usable worklog, offer to initialise this repo (else the plugin is inert).
  if (plugins.includes('worklog') && toolStatus.worklog && toolStatus.worklog.ok) {
    const doInit = guard(
      await confirm({
        message: 'Initialise worklog for this repo now? (creates ./.worklog/tasks.db — idempotent)',
        initialValue: true,
      })
    );
    if (doInit) {
      const r = worklogInit();
      toolStatus.worklog.initialised = r.ok;
      if (!r.ok) note(`worklog init did not complete: ${r.out || 'unknown error'}`, 'worklog');
    }
  }

  // --- write .claude/settings.json (deep-merge, never clobber) ---
  const settings = readJson(settingsPath);
  settings.extraKnownMarketplaces = settings.extraKnownMarketplaces || {};
  settings.extraKnownMarketplaces[MARKETPLACE_ID] = { source: { source: 'github', repo: REPO }, autoUpdate: true };
  settings.enabledPlugins = settings.enabledPlugins || {};
  for (const id of KNOWN_PLUGINS) {
    const key = `${id}@${MARKETPLACE_ID}`;
    if (plugins.includes(id)) settings.enabledPlugins[key] = true;
    else delete settings.enabledPlugins[key];
  }
  writeJson(settingsPath, settings);

  note(`Plugins enabled: ${plugins.join(', ')}\nWrote: .claude/settings.json`, 'Done');

  // Real per-tool checks (not blanket reminders).
  for (const id of plugins) {
    const st = toolStatus[id];
    if (!st) continue;
    const checks = [];
    if (st.ok) {
      checks.push(`[ok] ${id} on PATH${st.version ? ` (${st.version})` : ''}.`);
      if (st.installedTo) {
        checks.push(integrityLine({ verified: st.verified, insecure: cli.insecure }));
        if (!st.onPath) {
          checks.push(`[!] installed to ${st.installedTo}, which is not on your PATH yet. Add it, then reopen your shell.`);
        }
      }
    } else {
      checks.push(`[x] ${id} not on PATH — install a release from ${TOOLS[id].releases}, then re-run.`);
    }
    if (id === 'worklog') {
      if (st.initialised) checks.push('[ok] worklog initialised for this repo (.worklog/tasks.db).');
      else if (st.ok) checks.push('[!] worklog not initialised here — run `/worklog:init` (or `worklog init`) to activate it.');
    }
    note(checks.join('\n'), id);
  }

  // The one step the installer can't do for you — it runs outside Claude Code.
  outro('Reload Claude Code in this repo and accept the "trust this folder" dialog to activate the plugins.');
}

main().catch((err) => {
  cancel(describeError(err));
  process.exit(1);
});
