// The installer's flow once the plugins are chosen: verify (and optionally
// provision) each release-backed tool, optionally run `worklog init`, merge
// .claude/settings.json, and report per tool. The interactive and the
// non-interactive (--plugins) runs share it; they differ only in the
// `decisions` (prompts vs flags) and the `ui` (clack vs plain lines).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { MARKETPLACE_ID, REPO, SETTINGS_ORDER, TOOLS } from './plugins.mjs';
import { integrityLine } from './tls.mjs';
import { pathLines } from './userpath.mjs';

// readSettings returns the repo's .claude/settings.json as an object ({} when
// the file is absent). It throws, so the installer never overwrites a settings
// file it cannot merge into, when the file is not valid JSON, when its JSON is
// not a plain object (an array, null, a number, a string, a boolean), or when
// one of the entries the merge writes into is present but not a plain object:
// `enabledPlugins`, `extraKnownMarketplaces` and
// `extraKnownMarketplaces.<MARKETPLACE_ID>`.
export function readSettings(cwd) {
  const path = settingsPathFor(cwd);
  if (!existsSync(path)) return {};
  let value;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`${path} exists but is not valid JSON (${err.message}). Fix or remove it, then re-run.`);
  }
  if (!isPlainObject(value)) {
    throw new Error(`${path} must hold a JSON object, but it holds ${jsonKind(value)}. Fix or remove it, then re-run.`);
  }
  const nested = [
    ['enabledPlugins', value.enabledPlugins],
    ['extraKnownMarketplaces', value.extraKnownMarketplaces],
    [`extraKnownMarketplaces.${MARKETPLACE_ID}`, isPlainObject(value.extraKnownMarketplaces) ? value.extraKnownMarketplaces[MARKETPLACE_ID] : undefined],
  ];
  for (const [key, entry] of nested) {
    if (entry !== undefined && !isPlainObject(entry)) {
      throw new Error(`${path} must hold a JSON object at "${key}", but it holds ${jsonKind(entry)}. Fix or remove it, then re-run.`);
    }
  }
  return value;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// jsonKind names the type of a parsed JSON value that is not an object.
function jsonKind(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

function settingsPathFor(cwd) {
  return join(cwd, '.claude', 'settings.json');
}

function writeJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

// nonInteractiveDecisions answers the flow's questions from the parsed flags:
// install a missing tool only with --install-tools, and run `worklog init`
// unless --no-worklog-init.
export function nonInteractiveDecisions(cli) {
  return {
    installTool: async () => Boolean(cli['install-tools']),
    initWorklog: async () => !cli['no-worklog-init'],
  };
}

// probeTool reports the tool's version via `<tool> <versionArgs>`, or not-found.
export function probeTool(id, env) {
  const tool = TOOLS[id];
  const r = spawnSync(tool.bin, tool.versionArgs, { encoding: 'utf8', env });
  if (r.error || r.status !== 0) return { ok: false, version: null };
  return { ok: true, version: (r.stdout || '').trim() };
}

// worklog is attach-only: `worklog init` creates ./.worklog/tasks.db (idempotent).
function worklogInit(cwd, env) {
  const r = spawnSync('worklog', ['init'], { cwd, env, encoding: 'utf8' });
  return { ok: !r.error && r.status === 0, out: (r.stdout || r.stderr || '').trim() };
}

// setupTool verifies a tool and, when missing and the decision says so,
// installs its release via `provision`.
async function setupTool(id, { env, platform, decisions, provision, ui }) {
  const status = probeTool(id, env);
  if (status.ok) return status;
  if (!(await decisions.installTool(id))) return status;
  ui.message(`Downloading the latest ${id} release ...`);
  const res = await provision(id);
  if (!res.ok) {
    ui.warn(`Could not install ${id}: ${res.msg}`, id);
    return status;
  }
  // Make the freshly-installed binary reachable for the rest of THIS run (e.g.
  // `worklog init`). Whether new processes find it is `res.path`, reported by
  // the install itself.
  if (res.dir) env.PATH = res.dir + (platform === 'win32' ? ';' : ':') + (env.PATH || '');
  return { ok: true, version: res.version, installedTo: res.dir, path: res.path, verified: res.verified };
}

// mergeSettings registers the marketplace and enables `plugins`, adding new
// keys in SETTINGS_ORDER. With `additive` the other known plugins are left as
// they are; otherwise the selection is authoritative and unselected known
// plugins are removed. Unrelated settings are never touched.
export function mergeSettings(settings, plugins, { additive }) {
  settings.extraKnownMarketplaces = settings.extraKnownMarketplaces || {};
  settings.extraKnownMarketplaces[MARKETPLACE_ID] = { source: { source: 'github', repo: REPO }, autoUpdate: true };
  settings.enabledPlugins = settings.enabledPlugins || {};
  for (const id of SETTINGS_ORDER) {
    const key = `${id}@${MARKETPLACE_ID}`;
    if (plugins.includes(id)) settings.enabledPlugins[key] = true;
    else if (!additive) delete settings.enabledPlugins[key];
  }
  return settings;
}

// summaryLines is the real per-tool check shown at the end (not a blanket
// reminder). A binary found on PATH is reported as on PATH; one installed by
// this run as installed, followed by where it went and whether new processes
// will find it.
export function summaryLines(id, st, { insecure = false, home = '' } = {}) {
  const checks = [];
  if (st.ok) {
    const version = st.version ? ` (${st.version})` : '';
    if (st.installedTo) {
      checks.push(`[ok] ${id} installed${version}.`);
      checks.push(integrityLine({ verified: st.verified, insecure }));
      checks.push(...pathLines(st.installedTo, st.path, { home }));
    } else {
      checks.push(`[ok] ${id} on PATH${version}.`);
    }
  } else {
    checks.push(`[x] ${id} not on PATH — install a release from ${TOOLS[id].releases}, then re-run.`);
  }
  if (id === 'worklog') {
    if (st.initialised) checks.push('[ok] worklog initialised for this repo (.worklog/tasks.db).');
    else if (st.ok) checks.push('[!] worklog not initialised here — run `/worklog:init` (or `worklog init`) to activate it.');
  }
  return checks;
}

// installHints is the note listing how to install each of `plugins`
// explicitly at project scope, so Claude's plugin list shows them as
// installed. It is null when `plugins` is empty. The terminal command is
// `claude plugin install ... --scope project`: the in-session `/plugin install`
// takes no --scope flag. The `marketplace add` line comes first because the
// install fails on a machine whose Claude Code has not registered the
// marketplace yet; repeating it is harmless.
export function installHints(plugins) {
  if (!plugins.length) return null;
  const one = plugins.length === 1;
  return [
    `${one ? 'It is' : 'They are'} enabled in .claude/settings.json already; installing ${one ? 'it' : 'them'} explicitly also makes ${one ? 'it' : 'them'} show as installed in Claude's plugin list.`,
    'Claude Code, in a terminal in this repo:',
    `  claude plugin marketplace add ${REPO}`,
    ...plugins.map((id) => `  claude plugin install ${id}@${MARKETPLACE_ID} --scope project`),
    'Claude Desktop: in the Code tab, + > Plugins > Add plugin > choose the plugin > this project.',
  ].join('\n');
}

// restartLine is the closing reminder after this run installed binaries that
// new processes will find (`installed` lists their tools), or null when there
// are none. runInstall leaves out the tools a restart cannot help: those whose
// directory could not be added to the Windows user PATH, and those installed on
// macOS or Linux into a directory that is not on the PATH the installer started
// with.
export function restartLine(installed) {
  if (!installed.length) return null;
  return `[!] Just installed: ${installed.join(', ')}. Restart Claude Code / Claude Desktop and any open terminals so they pick up the new binary.`;
}

// runInstall carries out the flow for the chosen `plugins` and resolves to
// { toolStatus, unusable, pathFailed, notOnPath, initFailed }: `unusable` lists
// the chosen release-backed plugins left without a usable binary, `pathFailed`
// those whose binary this run installed on Windows but could not add to the
// user PATH (so Claude Code will not find it), `notOnPath` those whose binary
// this run installed on macOS or Linux into a directory that is not on the
// PATH the installer started with, and `initFailed` is true when
// `worklog init` ran and did not succeed. `env` is read and, after a
// provision, updated (PATH) for the rest of the run. settings.json is
// validated before any tool is installed or initialised, and re-read when it
// is written.
export async function runInstall({
  plugins,
  additive,
  cwd,
  env,
  platform = process.platform,
  insecure = false,
  decisions,
  provision,
  ui,
}) {
  readSettings(cwd);

  // Verify (and maybe install) each release-backed tool that was chosen.
  const toolStatus = {};
  for (const id of plugins) {
    if (TOOLS[id]) toolStatus[id] = await setupTool(id, { env, platform, decisions, provision, ui });
  }

  // With a usable worklog, maybe initialise this repo (else the plugin is inert).
  let initFailed = false;
  if (plugins.includes('worklog') && toolStatus.worklog && toolStatus.worklog.ok) {
    if (await decisions.initWorklog()) {
      const r = worklogInit(cwd, env);
      toolStatus.worklog.initialised = r.ok;
      initFailed = !r.ok;
      if (!r.ok) ui.warn(`worklog init did not complete: ${r.out || 'unknown error'}`, 'worklog');
    }
  }

  // --- write .claude/settings.json (deep-merge, never clobber) ---
  writeJson(settingsPathFor(cwd), mergeSettings(readSettings(cwd), plugins, { additive }));

  ui.note(`Plugins enabled: ${plugins.join(', ')}\nWrote: .claude/settings.json`, 'Done');

  const home = env.HOME || env.USERPROFILE || '';
  for (const id of plugins) {
    if (toolStatus[id]) ui.note(summaryLines(id, toolStatus[id], { insecure, home }).join('\n'), id);
  }

  const hints = installHints(plugins);
  if (hints) ui.note(hints, 'Show them as installed in Claude');

  const installed = plugins.filter((id) => toolStatus[id] && toolStatus[id].installedTo);
  const pathFailed = installed.filter((id) => toolStatus[id].path && toolStatus[id].path.windows && !toolStatus[id].path.ok);
  const notOnPath = installed.filter((id) => toolStatus[id].path && !toolStatus[id].path.windows && !toolStatus[id].path.onPath);
  const restart = restartLine(installed.filter((id) => !pathFailed.includes(id) && !notOnPath.includes(id)));
  if (restart) ui.message(restart);

  const unusable = plugins.filter((id) => toolStatus[id] && !toolStatus[id].ok);
  return { toolStatus, unusable, pathFailed, notOnPath, initFailed };
}

// nonInteractiveOutcome turns runInstall's result into the --plugins run's
// exit code and its closing stderr lines, `errors` and `warnings`: exit 1 when
// a listed binary-backed plugin has no usable binary, when a binary was
// installed on Windows but its directory could not be added to the user PATH
// (Claude Code will not find it), or when `worklog init` failed; otherwise 0.
// A binary installed on macOS or Linux into a directory that is not on PATH is
// a warning, not an error: the install succeeded, and putting ~/.local/bin on
// PATH is the user's own shell-profile step.
export function nonInteractiveOutcome({ toolStatus, unusable, pathFailed, notOnPath, initFailed }, { installTools }) {
  const errors = [];
  if (unusable.length) {
    const it = unusable.length > 1 ? 'them' : 'it';
    const how = installTools ? `Install ${it} by hand, then re-run.` : `Re-run with --install-tools, or install ${it} by hand and re-run.`;
    errors.push(`no usable binary for ${unusable.join(', ')}. ${how}`);
  }
  for (const id of pathFailed) {
    const st = toolStatus[id];
    const reason = String(st.path.error || 'unknown error').replace(/\s+/g, ' ').replace(/[.\s]+$/, '');
    errors.push(
      `${id} was installed to ${st.installedTo}, but that directory could not be added to your user PATH (${reason}), so Claude Code will not find it. Add it by hand (Start > "Edit environment variables for your account"), then restart Claude Code.`
    );
  }
  if (initFailed) {
    errors.push('worklog init failed in this repo (see above). Fix the cause, then run `worklog init` here or re-run.');
  }
  const warnings = notOnPath.map(
    (id) => `${id} was installed to ${toolStatus[id].installedTo}, which is not on your PATH, so Claude Code will not find it until you add it in your shell profile (the ${id} summary above shows the line), then open a new terminal and restart Claude Code.`
  );
  return { code: errors.length ? 1 : 0, errors, warnings };
}
