import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCli, parseErrorMessage, forwardArgs, USAGE, UsageError } from '../lib/args.mjs';
import { relaunchPlan } from '../lib/selfupdate.mjs';

test('parseCli: no flags gives all-false options and no plugin list', () => {
  assert.deepEqual(parseCli([]), {
    plugins: null,
    'install-tools': false,
    'no-worklog-init': false,
    insecure: false,
    'no-self-update': false,
    version: false,
    help: false,
  });
});

test('parseCli: recognises --insecure, --no-self-update, --version, --help and -h', () => {
  assert.equal(parseCli(['--insecure']).insecure, true);
  assert.equal(parseCli(['--no-self-update'])['no-self-update'], true);
  assert.equal(parseCli(['--no-self-update']).insecure, false);
  assert.equal(parseCli(['--version']).version, true);
  assert.equal(parseCli(['--help']).help, true);
  assert.equal(parseCli(['-h']).help, true);
});

test('parseCli: rejects unknown flags, positionals and values on boolean flags', () => {
  assert.throws(() => parseCli(['--bogus']), (e) => parseErrorMessage(e) === "Unknown option '--bogus'");
  assert.throws(() => parseCli(['foo']), (e) => parseErrorMessage(e) === "Unexpected argument 'foo'");
  assert.throws(() => parseCli(['--insecure=yes']), (e) => parseErrorMessage(e) === "Option '--insecure' does not take an argument");
  assert.throws(() => parseCli(['--self-update']), (e) => parseErrorMessage(e) === "Unknown option '--self-update'");
});

test('forwardArgs: forwards --insecure only, never the print-and-exit flags or --no-self-update', () => {
  assert.deepEqual(forwardArgs(parseCli([])), []);
  assert.deepEqual(forwardArgs(parseCli(['--insecure'])), ['--insecure']);
  assert.deepEqual(forwardArgs(parseCli(['--insecure', '--no-self-update'])), ['--insecure']);
  assert.deepEqual(forwardArgs({ insecure: true, 'no-self-update': true, help: true, version: true }), ['--insecure']);
});

test('parseCli --plugins: comma lists and repeats, trimmed, deduplicated, canonical order', () => {
  assert.deepEqual(parseCli(['--plugins=worklog']).plugins, ['worklog']);
  assert.deepEqual(parseCli(['--plugins', 'image-to-html,worklog']).plugins, ['worklog', 'image-to-html']);
  assert.deepEqual(parseCli(['--plugins=mdtohtml', '--plugins= worklog , mdtohtml,', '--plugins=worklog']).plugins, ['worklog', 'mdtohtml']);
  assert.deepEqual(parseCli(['--plugins=image-to-html,mdtohtml,worklog']).plugins, ['worklog', 'mdtohtml', 'image-to-html']);
});

test('parseCli --plugins: empty and unknown names are usage errors naming the valid plugins', () => {
  for (const argv of [['--plugins='], ['--plugins', ''], ['--plugins=,', '--plugins= ']]) {
    assert.throws(() => parseCli(argv), (e) => e instanceof UsageError && parseErrorMessage(e) === '--plugins needs at least one plugin name (valid: worklog, mdtohtml, image-to-html)');
  }
  assert.throws(() => parseCli(['--plugins=worklog,nope']), (e) => parseErrorMessage(e) === "unknown plugin 'nope' (valid: worklog, mdtohtml, image-to-html)");
  assert.throws(() => parseCli(['--plugins=Worklog,x', '--plugins=x']), (e) => parseErrorMessage(e) === "unknown plugins 'Worklog', 'x' (valid: worklog, mdtohtml, image-to-html)");
  assert.throws(() => parseCli(['--plugins']), (e) => /argument missing/.test(parseErrorMessage(e)));
});

test('parseCli: --install-tools and --no-worklog-init need --plugins', () => {
  assert.throws(() => parseCli(['--install-tools']), (e) => parseErrorMessage(e) === '--install-tools only applies with --plugins (the non-interactive mode)');
  assert.throws(() => parseCli(['--no-worklog-init']), (e) => parseErrorMessage(e) === '--no-worklog-init only applies with --plugins (the non-interactive mode)');
  const ok = parseCli(['--plugins=worklog', '--install-tools', '--no-worklog-init']);
  assert.equal(ok['install-tools'], true);
  assert.equal(ok['no-worklog-init'], true);
  assert.equal(parseCli(['--install-tools', '--help']).help, true, '--help still prints usage');
});

test('parseCli: --help and --version skip plugin validation, leaving plugins null when invalid', () => {
  assert.equal(parseCli(['--help', '--plugins=nope']).plugins, null);
  assert.equal(parseCli(['--version', '--plugins=']).plugins, null);
  assert.deepEqual(parseCli(['--help', '--plugins=worklog']).plugins, ['worklog']);
  assert.throws(() => parseCli(['--plugins=nope']), UsageError);
});

test('parseCli: --help, -h and --version win over any parse error, as exact tokens before --', () => {
  for (const argv of [['--help', '--plugins'], ['--plugins', '--help'], ['--plugins', '-h'], ['-h', '--bogus'], ['--insecure=yes', '--help'], ['foo', '--help']]) {
    const out = parseCli(argv);
    assert.equal(out.help, true, argv.join(' '));
    assert.equal(out.version, false, argv.join(' '));
    assert.equal(out.plugins, null, argv.join(' '));
  }
  const v = parseCli(['--plugins', '--version']);
  assert.equal(v.version, true);
  assert.equal(v.help, false);
  assert.throws(() => parseCli(['--plugins=--help']), UsageError, 'a --plugins value is not the --help flag');
  assert.throws(() => parseCli(['--plugins=-h', '--bogus']), (e) => parseErrorMessage(e) === "Unknown option '--bogus'");
  assert.throws(() => parseCli(['--', '--help']), (e) => /Unexpected argument '--help'/.test(parseErrorMessage(e)), 'after -- it is a positional');
  assert.throws(() => parseCli(['--helpx']), (e) => parseErrorMessage(e) === "Unknown option '--helpx'");
});

test('parseErrorMessage: keeps only the first sentence, ended by a full stop and a space or newline', () => {
  assert.throws(() => parseCli(['--plugins', '--install-tools']), (e) => parseErrorMessage(e) === "Option '--plugins' argument is ambiguous");
  assert.equal(parseErrorMessage(new Error("Unknown option '--a.b'. More advice.")), "Unknown option '--a.b'");
  assert.equal(parseErrorMessage(new Error('Single sentence.')), 'Single sentence');
  assert.equal(parseErrorMessage(new UsageError('kept whole. really.')), 'kept whole. really.');
});

test('parseCli: negated forms are not accepted (allowNegative stays off)', () => {
  assert.throws(() => parseCli(['--no-install-tools']), (e) => parseErrorMessage(e) === "Unknown option '--no-install-tools'");
  assert.throws(() => parseCli(['--worklog-init']), (e) => parseErrorMessage(e) === "Unknown option '--worklog-init'");
  assert.throws(() => parseCli(['--no-insecure']), (e) => parseErrorMessage(e) === "Unknown option '--no-insecure'");
});

test('forwardArgs: one --plugins=<name> per plugin plus the mode flags', () => {
  assert.deepEqual(forwardArgs(parseCli(['--plugins=image-to-html,worklog', '--install-tools', '--no-worklog-init', '--insecure', '--no-self-update'])), [
    '--plugins=worklog',
    '--plugins=image-to-html',
    '--install-tools',
    '--no-worklog-init',
    '--insecure',
  ]);
  assert.deepEqual(forwardArgs(parseCli(['--plugins=mdtohtml'])), ['--plugins=mdtohtml']);
});

test('forwardArgs round-trips through parseCli and is accepted by relaunchPlan on win32 and posix', () => {
  const cli = parseCli(['--plugins=worklog,mdtohtml,image-to-html', '--install-tools', '--no-worklog-init', '--insecure']);
  const forwarded = forwardArgs(cli);
  assert.deepEqual(parseCli(forwarded), { ...cli, 'no-self-update': false });
  for (const platform of ['win32', 'linux']) {
    const plan = relaunchPlan({ version: '1.2.3', forwarded, insecure: true, platform, env: {} });
    const argv = platform === 'win32' ? plan.command.split(' ').slice(3) : plan.args.slice(2);
    assert.deepEqual(argv, forwarded, platform);
  }
});

test('USAGE documents every flag', () => {
  for (const flag of ['--plugins', '--install-tools', '--no-worklog-init', '--insecure', '--no-self-update', '--version', '--help']) assert.match(USAGE, new RegExp(flag));
  assert.match(USAGE, /npx --strict-ssl=false/);
  assert.match(USAGE, /npx https:\/\/matlomax\.com\/claude-plugins\.tgz --plugins=worklog,mdtohtml --install-tools/);
});
