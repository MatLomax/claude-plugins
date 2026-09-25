// Command-line parsing for the installer. Every flag is a boolean, so the
// parsed values fully describe the invocation (forwardArgs rebuilds it).

import { parseArgs } from 'node:util';

export const OPTIONS = {
  insecure: { type: 'boolean' },
  'no-self-update': { type: 'boolean' },
  version: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

// Flags never forwarded to a relaunch: the print-and-exit flags, and
// --no-self-update, which prevents the relaunch from happening at all.
const NOT_FORWARDED = new Set(['version', 'help', 'no-self-update']);

export const USAGE = `Usage: npx https://matlomax.com/claude-plugins.tgz [options]

Run it from the root of the repo you want to enable the matlomax Claude Code
plugins in. It asks which plugins to enable and writes .claude/settings.json.

Options:
  --insecure        Skip TLS certificate checks on the installer's own
                    downloads, for networks that intercept HTTPS. npm's own
                    download of the installer needs \`npx --strict-ssl=false\`
                    as well. The downloaded binaries' checksums then prove
                    nothing. Prefer NODE_EXTRA_CA_CERTS.
  --no-self-update  Skip the check for a newer installer release and run this
                    version as is.
  --version         Print the installer version and exit.
  -h, --help        Show this help and exit.`;

// parseCli parses argv strictly (unknown flags, values on boolean flags and
// positionals all throw) and returns every option as a plain boolean.
export function parseCli(argv) {
  const { values } = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: false });
  const out = {};
  for (const name of Object.keys(OPTIONS)) out[name] = Boolean(values[name]);
  return out;
}

// parseErrorMessage keeps the first sentence of a parseArgs error; the rest is
// advice about `--` positionals, which this CLI does not take.
export function parseErrorMessage(err) {
  const msg = err && err.message ? err.message : String(err);
  return msg.split('. ')[0].replace(/\.$/, '');
}

// forwardArgs rebuilds the flags a relaunched installer must receive.
export function forwardArgs(cli) {
  return Object.keys(OPTIONS)
    .filter((name) => cli[name] && !NOT_FORWARDED.has(name))
    .map((name) => `--${name}`);
}
