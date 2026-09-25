// Command-line parsing for the installer. The parsed values fully describe the
// invocation (forwardArgs rebuilds it): every flag is a boolean except
// --plugins, which is the validated plugin list, or null when absent.

import { parseArgs } from 'node:util';
import { PLUGIN_IDS } from './plugins.mjs';

export const OPTIONS = {
  plugins: { type: 'string', multiple: true },
  'install-tools': { type: 'boolean' },
  'no-worklog-init': { type: 'boolean' },
  insecure: { type: 'boolean' },
  'no-self-update': { type: 'boolean' },
  version: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

// Flags never forwarded to a relaunch: the print-and-exit flags, and
// --no-self-update, which prevents the relaunch from happening at all.
const NOT_FORWARDED = new Set(['version', 'help', 'no-self-update']);

// Flags that only mean something in the non-interactive (--plugins) mode.
const NEEDS_PLUGINS = ['install-tools', 'no-worklog-init'];

export const USAGE = `Usage: npx https://matlomax.com/claude-plugins.tgz [options]

Run it from the root of the repo you want to enable the matlomax Claude Code
plugins in. It asks which plugins to enable and writes .claude/settings.json.
With --plugins it asks nothing and needs no terminal, e.g. in CI:
  npx https://matlomax.com/claude-plugins.tgz --plugins=worklog,mdtohtml --install-tools

Options:
  --plugins=<names>   Enable these plugins without prompting: a comma list
                      and/or repeated flag of ${PLUGIN_IDS.join(', ')}.
                      Plugins not listed are left as they are. Exits 1 if a
                      listed plugin's binary is not usable.
  --install-tools     With --plugins: download and install a listed plugin's
                      missing binary (otherwise it is only reported).
  --no-worklog-init   With --plugins: skip \`worklog init\` in this repo.
  --insecure          Skip TLS certificate checks on the installer's own
                      downloads, for networks that intercept HTTPS. npm's own
                      download of the installer needs \`npx --strict-ssl=false\`
                      as well. The downloaded binaries' checksums then prove
                      nothing. Prefer NODE_EXTRA_CA_CERTS.
  --no-self-update    Skip the check for a newer installer release and run
                      this version as is.
  --version           Print the installer version and exit.
  -h, --help          Show this help and exit.`;

// UsageError is a command line that parses but does not make sense; its
// message is shown to the user whole.
export class UsageError extends Error {}

// parsePlugins splits comma lists, trims, and returns the named plugins
// deduplicated in canonical order. Empty or unknown names throw.
export function parsePlugins(values) {
  const names = values.flatMap((v) => v.split(',')).map((s) => s.trim()).filter(Boolean);
  const valid = PLUGIN_IDS.join(', ');
  if (names.length === 0) throw new UsageError(`--plugins needs at least one plugin name (valid: ${valid})`);
  const unknown = [...new Set(names.filter((n) => !PLUGIN_IDS.includes(n)))];
  if (unknown.length) {
    const list = unknown.map((n) => `'${n}'`).join(', ');
    throw new UsageError(`unknown plugin${unknown.length > 1 ? 's' : ''} ${list} (valid: ${valid})`);
  }
  return PLUGIN_IDS.filter((id) => names.includes(id));
}

// printFlagsIn reports which print-and-exit flags appear in argv as exact
// tokens (`--help`, `-h`, `--version`) before any `--` terminator. A flag's
// value such as `--plugins=--help` is one token and does not count.
function printFlagsIn(argv) {
  const end = argv.indexOf('--');
  const flags = end === -1 ? argv : argv.slice(0, end);
  return { help: flags.includes('--help') || flags.includes('-h'), version: flags.includes('--version') };
}

// parseCli parses argv strictly (unknown flags, values on boolean flags and
// positionals all throw) and returns every boolean option as a plain boolean
// and `plugins` as the validated list or null. --help and --version win over
// every error: when either appears in argv, a command line that does not parse
// gives the all-false options with that flag set, and the usage checks (plugin
// names, flags that need --plugins) are skipped, since the run only prints and
// exits; `plugins` is then null when it is invalid.
export function parseCli(argv) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: false }));
  } catch (err) {
    const print = printFlagsIn(argv);
    if (!print.help && !print.version) throw err;
    values = print;
  }
  const out = {};
  for (const [name, opt] of Object.entries(OPTIONS)) {
    if (opt.type === 'boolean') out[name] = Boolean(values[name]);
  }
  const printOnly = out.help || out.version;
  out.plugins = null;
  if (values.plugins !== undefined) {
    try {
      out.plugins = parsePlugins(values.plugins);
    } catch (err) {
      if (!printOnly) throw err;
    }
  }
  if (!out.plugins && !printOnly) {
    const orphan = NEEDS_PLUGINS.find((name) => out[name]);
    if (orphan) throw new UsageError(`--${orphan} only applies with --plugins (the non-interactive mode)`);
  }
  return out;
}

// parseErrorMessage keeps the first sentence of a parseArgs error, which ends
// at a full stop followed by a space or a newline; the rest is advice about
// `--` positionals or option values starting with a dash. A UsageError is
// kept whole.
export function parseErrorMessage(err) {
  if (err instanceof UsageError) return err.message;
  const msg = err && err.message ? err.message : String(err);
  return msg.split(/\.(?:\s|$)/)[0];
}

// forwardArgs rebuilds the flags a relaunched installer must receive. The
// plugin list goes as one --plugins=<name> per plugin, since the relaunch only
// accepts shell-safe arguments and a comma is not one.
export function forwardArgs(cli) {
  const out = [];
  for (const [name, opt] of Object.entries(OPTIONS)) {
    if (NOT_FORWARDED.has(name)) continue;
    if (opt.type === 'string') {
      for (const v of cli[name] || []) out.push(`--${name}=${v}`);
    } else if (cli[name]) {
      out.push(`--${name}`);
    }
  }
  return out;
}
