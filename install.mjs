#!/usr/bin/env node
// Installer for the `matlomax` Claude Code plugin marketplace.
//
// Run from the root of the repo you want to enable the plugins in:
//   npx https://matlomax.com/claude-plugins.tgz
//
// Interactively it multiselects the marketplace's plugins (all off by default)
// and deep-merges `.claude/settings.json` in the current repo — registering the
// marketplace and setting exactly the plugins you tick as enabled (the
// multiselect is authoritative for this marketplace's plugins; unrelated
// settings are left untouched). For a plugin backed by a CLI binary (worklog,
// mdtohtml) it offers to install that binary by downloading the latest release
// for your platform (SHA-256 verified when the release publishes a checksum)
// and placing it in %LOCALAPPDATA%\Programs\<tool> on Windows, which it adds
// to the user PATH and announces to running programs, or in ~/.local/bin on
// macOS and Linux, where it only warns if that is not on PATH; after that each tool keeps itself current via its own
// `<tool> update`. It never requires a language toolchain.
//
// `--plugins=<names>` runs the same flow without prompts or a terminal: the
// listed plugins are enabled (others left as they are), a missing binary is
// installed only with `--install-tools`, `worklog init` runs unless
// `--no-worklog-init`, and the exit code is 1 when a listed plugin's binary is
// not usable, was installed on Windows but could not be added to the user
// PATH, or `worklog init` failed.
//
// Before anything else it checks GitHub for a newer installer release and, if
// there is one, relaunches as `npx <that release's claude-plugins-<v>.tgz>`
// with the same flags (`--no-self-update` skips this). `--insecure` skips
// certificate checks on the installer's own downloads for networks that
// intercept HTTPS; see `--help`.

import { intro, outro, multiselect, confirm, note, log, isCancel, cancel } from '@clack/prompts';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseCli, parseErrorMessage, USAGE } from './lib/args.mjs';
import { fetchJson, download } from './lib/net.mjs';
import { describeError, INSECURE_WARNING } from './lib/tls.mjs';
import { selfUpdate } from './lib/selfupdate.mjs';
import { MARKETPLACE_ID, REPO, PLUGINS, TOOLS } from './lib/plugins.mjs';
import { runInstall, nonInteractiveDecisions, nonInteractiveOutcome, readSettings } from './lib/flow.mjs';
import { placeRelease } from './lib/place.mjs';

// The installer's version is the package.json shipped beside this script (in
// the repo and in the release tarball alike).
const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;

const cwd = process.cwd();

// The PATH this process started with, before the run prepends install dirs to
// it: whether an install dir is on it is what a new shell would see.
const startPath = process.env.PATH || '';

// Parsed command line; `insecure` is read by every download below.
let cli = { insecure: false };

// --- output ----------------------------------------------------------------

// The interactive run draws with clack; the non-interactive run prints plain
// lines (clack's box drawing is noise in a CI log), with problems on stderr.
const clackUi = {
  intro,
  message: (text) => log.message(text),
  note,
  warn: note,
  outro,
  fail: cancel,
};

const plainUi = {
  intro: (title) => console.log(title),
  message: (text) => console.log(text),
  note: (body, title) => console.log(`${title}:\n${body.replace(/^/gm, '  ')}`),
  warn: (body, title) => console.error(`${title}: ${body}`),
  outro: (text) => console.log(text),
  fail: (text) => console.error(`claude-plugins-install: ${text}`),
};

let ui = clackUi;

// --- small helpers ---------------------------------------------------------

function bail() {
  cancel('Cancelled — no changes written.');
  process.exit(0);
}

function guard(value) {
  if (isCancel(value)) bail();
  return value;
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

// place installs the downloaded artifact (see placeRelease) and returns where
// the binary landed (`dir`) and the PATH report for it (`path`).
function place(tool, artifact) {
  return placeRelease(tool, artifact, {
    platform: process.platform,
    home: homedir(),
    localAppData: process.env.LOCALAPPDATA,
    startPath,
  });
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

// --- main ------------------------------------------------------------------

// parseCommandLine handles --help / --version (print and exit, before any
// network or prompt, even when the rest of the command line is invalid) and
// rejects unknown flags and bad flag combinations with exit code 2.
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

// interactiveDecisions answers the flow's questions with prompts.
const interactiveDecisions = {
  installTool: async (id) =>
    guard(
      await confirm({
        message: `${id} is not on PATH. Download and install the latest release now?`,
        initialValue: true,
      })
    ),
  initWorklog: async () =>
    guard(
      await confirm({
        message: 'Initialise worklog for this repo now? (creates ./.worklog/tasks.db — idempotent)',
        initialValue: true,
      })
    ),
};

async function choosePlugins() {
  return guard(
    await multiselect({
      message: 'Which plugins to enable in this repo? (all off by default — tick what you want)',
      options: PLUGINS.map((p) => ({ value: p.id, label: p.id, hint: p.hint })),
      initialValues: [],
      required: true,
    })
  );
}

async function main() {
  cli = parseCommandLine(process.argv.slice(2));
  const interactive = cli.plugins === null;
  ui = interactive ? clackUi : plainUi;

  if (interactive && (!process.stdout.isTTY || !process.stdin.isTTY)) {
    console.error('claude-plugins-install is interactive — run it in a terminal, or pass --plugins to run without prompts (see --help).');
    process.exit(1);
  }

  if (cli.insecure) console.error(INSECURE_WARNING);

  const update = await selfUpdate({ ownVersion: VERSION, cli, fetchJson, spawn });
  if (update.action === 'exit') process.exit(update.code);

  // A settings.json the installer cannot merge into fails the run here, before
  // any prompt, download or `worklog init`.
  readSettings(cwd);

  ui.intro('matlomax plugins');
  ui.message(`Enabling the marketplace "${MARKETPLACE_ID}" (${REPO}) in:\n${cwd}`);

  const plugins = interactive ? await choosePlugins() : cli.plugins;

  const result = await runInstall({
    plugins,
    additive: !interactive,
    cwd,
    env: process.env,
    insecure: cli.insecure,
    decisions: interactive ? interactiveDecisions : nonInteractiveDecisions(cli),
    provision,
    ui,
  });

  // The one step the installer can't do for you — it runs outside Claude Code.
  ui.outro('Reload Claude Code in this repo and accept the "trust this folder" dialog to activate the plugins.');

  if (interactive) return;
  const { code, errors, warnings } = nonInteractiveOutcome(result, { installTools: Boolean(cli['install-tools']) });
  for (const line of warnings) console.error(`claude-plugins-install: warning: ${line}`);
  for (const line of errors) console.error(`claude-plugins-install: ${line}`);
  if (code) process.exit(code);
}

main().catch((err) => {
  ui.fail(describeError(err));
  process.exit(1);
});
