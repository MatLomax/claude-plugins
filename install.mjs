#!/usr/bin/env node
// Interactive installer for the `matlomax` Claude Code plugin marketplace.
//
// Run from the root of the repo you want to enable the plugins in:
//   npx github:MatLomax/claude-plugins
//
// It multiselects the marketplace's plugins (all off by default) and deep-merges
// `.claude/settings.json` in the current repo — registering the marketplace and
// enabling exactly what you pick, never clobbering existing settings. When
// `worklog` is chosen it also verifies its runtime (Go 1.27+ and the `worklog`
// binary), can build the binary via `go install`, and can initialise the repo's
// worklog database — because worklog is attach-only and inert until then.

import { intro, outro, multiselect, confirm, note, log, isCancel, cancel } from '@clack/prompts';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const MARKETPLACE_ID = 'matlomax';
const REPO = 'MatLomax/claude-plugins';
const KNOWN_PLUGINS = ['worklog', 'image-to-html'];
const GO_MIN = [1, 27]; // worklog's go.mod: `go 1.27.0`

const cwd = process.cwd();
const settingsPath = join(cwd, '.claude', 'settings.json');

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

// --- worklog runtime -------------------------------------------------------

// Go toolchain: { ok, version, meets } — `meets` is version >= GO_MIN.
function checkGo() {
  const r = spawnSync('go', ['version'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return { ok: false, version: null, meets: false };
  const m = /go(\d+)\.(\d+)(?:\.(\d+))?/.exec(r.stdout || '');
  if (!m) return { ok: true, version: null, meets: false };
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const version = `${m[1]}.${m[2]}${m[3] ? '.' + m[3] : ''}`;
  const meets = major > GO_MIN[0] || (major === GO_MIN[0] && minor >= GO_MIN[1]);
  return { ok: true, version, meets };
}

// The `worklog` binary on PATH: { ok, version }. `worklog version` prints e.g.
// "worklog v0.1.0" (or "worklog dev" for a local build); ENOENT means not found.
function checkWorklog() {
  const r = spawnSync('worklog', ['version'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return { ok: false, version: null };
  return { ok: true, version: (r.stdout || '').trim() };
}

// Where `go install` drops binaries, for a PATH hint when it lands off-PATH.
function goBinDir() {
  const bin = (spawnSync('go', ['env', 'GOBIN'], { encoding: 'utf8' }).stdout || '').trim();
  if (bin) return bin;
  const gopath = (spawnSync('go', ['env', 'GOPATH'], { encoding: 'utf8' }).stdout || '').trim();
  if (gopath) return join(gopath.split(process.platform === 'win32' ? ';' : ':')[0], 'bin');
  return '$(go env GOPATH)/bin';
}

// worklog is attach-only: `worklog init` creates ./.worklog/tasks.db (idempotent).
function worklogInit() {
  const r = spawnSync('worklog', ['init'], { cwd, encoding: 'utf8' });
  return { ok: !r.error && r.status === 0, out: (r.stdout || r.stderr || '').trim() };
}

// Verify (and, on opt-in, provision + initialise) worklog. Returns the status the
// end-of-run checks report: { go, binary, initialised }.
async function worklogSetup() {
  const status = { go: checkGo(), binary: checkWorklog(), initialised: false };

  // Binary missing but Go present → offer to build it (v0.1.0 is a released tag).
  if (!status.binary.ok && status.go.ok && status.go.meets) {
    const build = guard(
      await confirm({
        message: `worklog is not on PATH. Build it now with \`go install\` (Go ${status.go.version} found)?`,
        initialValue: true,
      })
    );
    if (build) {
      log.message('Running `go install github.com/MatLomax/worklog/cmd/worklog@latest` — this can take a minute…');
      spawnSync('go', ['install', 'github.com/MatLomax/worklog/cmd/worklog@latest'], { stdio: 'inherit' });
      status.binary = checkWorklog();
      if (!status.binary.ok) {
        note(`Built worklog, but it is not on PATH — check that ${goBinDir()} is on your PATH, then reopen your shell.`, 'worklog');
      }
    }
  }

  // With a usable binary, offer to initialise this repo (else the plugin stays inert).
  if (status.binary.ok) {
    const doInit = guard(
      await confirm({
        message: 'Initialise worklog for this repo now? (creates ./.worklog/tasks.db — idempotent)',
        initialValue: true,
      })
    );
    if (doInit) {
      const r = worklogInit();
      status.initialised = r.ok;
      if (!r.ok) note(`worklog init did not complete: ${r.out || 'unknown error'}`, 'worklog');
    }
  }

  return status;
}

// --- main ------------------------------------------------------------------

async function main() {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.error('claude-plugins-install is interactive — run it in a terminal (not piped or in CI).');
    process.exit(1);
  }

  intro('matlomax plugins');
  log.message(`Enabling the marketplace "${MARKETPLACE_ID}" (${REPO}) in:\n${cwd}`);

  const plugins = guard(
    await multiselect({
      message: 'Which plugins to enable in this repo? (all off by default — tick what you want)',
      options: [
        { value: 'worklog', label: 'worklog', hint: 'Per-project SQLite task & decision log (Go binary, verified below)' },
        { value: 'image-to-html', label: 'image-to-html', hint: 'Reconstruct HTML from a mockup and gate the render against it' },
      ],
      initialValues: [],
      required: true,
    })
  );

  const worklogStatus = plugins.includes('worklog') ? await worklogSetup() : null;

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

  // Real checks for worklog's runtime (not blanket reminders).
  if (worklogStatus) {
    const st = worklogStatus;
    const checks = [];

    if (!st.go.ok) checks.push('✗ Go is not installed — needed to build worklog (https://go.dev/dl, 1.27+).');
    else if (!st.go.meets) checks.push(`⚠ Go ${st.go.version} found — worklog needs ${GO_MIN.join('.')}+.`);
    else checks.push(`✓ Go ${st.go.version}.`);

    checks.push(
      st.binary.ok
        ? `✓ worklog on PATH (${st.binary.version}).`
        : '✗ worklog not on PATH — install it: `go install github.com/MatLomax/worklog/cmd/worklog@latest`, or download a release from github.com/MatLomax/worklog/releases.'
    );

    if (st.initialised) checks.push('✓ worklog initialised for this repo (.worklog/tasks.db).');
    else if (st.binary.ok) checks.push('⚠ worklog not initialised here — run `/worklog:init` (or `worklog init`) to activate it.');

    note(checks.join('\n'), 'worklog');
  }

  // The one step the installer can't do for you — it runs outside Claude Code.
  outro('Reload Claude Code in this repo and accept the "trust this folder" dialog to activate the plugins.');
}

main().catch((err) => {
  cancel(err && err.message ? err.message : String(err));
  process.exit(1);
});
