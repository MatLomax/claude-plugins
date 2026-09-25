import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { parseCli } from '../lib/args.mjs';
import { parseSemver, isNewer, fetchLatestVersion, relaunchPlan, manualCommand, selfUpdate, LATEST_RELEASE_API, RELAUNCH_ENV } from '../lib/selfupdate.mjs';

test('parseSemver: accepts X.Y.Z with optional v, rejects the rest', () => {
  assert.deepEqual(parseSemver('1.2.3'), [1, 2, 3]);
  assert.deepEqual(parseSemver('v10.0.12'), [10, 0, 12]);
  for (const bad of ['1.2', '1.2.3-rc.1', '1.2.3+build', 'latest', '', null, undefined, 'v1.2.3.4']) {
    assert.equal(parseSemver(bad), null, String(bad));
  }
});

test('isNewer: numeric comparison, strictly greater only', () => {
  assert.equal(isNewer('1.0.1', '1.0.0'), true);
  assert.equal(isNewer('1.10.0', '1.9.9'), true); // numeric, not lexical
  assert.equal(isNewer('2.0.0', '1.99.99'), true);
  assert.equal(isNewer('1.0.0', '1.0.0'), false);
  assert.equal(isNewer('1.0.0', '1.0.1'), false);
  assert.equal(isNewer('0.9.10', '0.10.0'), false);
  assert.equal(isNewer('garbage', '1.0.0'), false);
  assert.equal(isNewer('2.0.0', 'garbage'), false);
});

test('fetchLatestVersion: strips the v and returns normalised X.Y.Z', async () => {
  let seen;
  const fetchJson = async (url, opts) => { seen = { url, opts }; return { tag_name: 'v1.4.0' }; };
  assert.equal(await fetchLatestVersion({ fetchJson, insecure: true }), '1.4.0');
  assert.equal(seen.url, LATEST_RELEASE_API);
  assert.equal(seen.opts.insecure, true);
  assert.ok(seen.opts.signal instanceof AbortSignal);
});

test('fetchLatestVersion: fails open to null', async () => {
  const cases = [
    async () => { throw Object.assign(new Error('offline'), { code: 'ENOTFOUND' }); },
    async () => { throw new Error('GitHub API returned 403'); },
    async () => { throw new SyntaxError('Unexpected token'); },
    async () => ({}),
    async () => ({ tag_name: 'v2.0.0-beta.1' }),
    async () => null,
  ];
  for (const fetchJson of cases) assert.equal(await fetchLatestVersion({ fetchJson }), null);
});

test('relaunchPlan: posix runs npx without a shell and marks the child relaunched', () => {
  const env = { PATH: '/usr/bin', HOME: '/home/u' };
  const plan = relaunchPlan({ version: '1.2.3', forwarded: [], insecure: false, platform: 'linux', env });
  assert.equal(plan.command, 'npx');
  assert.deepEqual(plan.args, ['-y', 'https://github.com/MatLomax/claude-plugins/releases/download/v1.2.3/claude-plugins-1.2.3.tgz']);
  assert.equal(plan.options.shell, false);
  assert.equal(plan.options.stdio, 'inherit');
  assert.deepEqual(plan.options.env, { PATH: '/usr/bin', HOME: '/home/u', [RELAUNCH_ENV]: '1' });
  assert.equal(plan.manual, 'npx https://github.com/MatLomax/claude-plugins/releases/download/v1.2.3/claude-plugins-1.2.3.tgz');
  assert.equal(env[RELAUNCH_ENV], undefined, 'caller env is not mutated');
});

test('relaunchPlan: win32 runs one command string through a shell, with no args array (DEP0190)', () => {
  const plan = relaunchPlan({ version: '1.2.3', forwarded: ['--insecure'], insecure: true, platform: 'win32', env: {} });
  assert.equal(plan.command, 'npx -y https://github.com/MatLomax/claude-plugins/releases/download/v1.2.3/claude-plugins-1.2.3.tgz --insecure');
  assert.deepEqual(plan.args, []);
  assert.equal(plan.options.shell, true);
  assert.equal(plan.options.env.npm_config_strict_ssl, 'false');
});

test('relaunchPlan: --insecure turns off npm strict-ssl and forwards the flag', () => {
  const plan = relaunchPlan({ version: '2.0.0', forwarded: ['--insecure'], insecure: true, platform: 'linux', env: {} });
  assert.equal(plan.options.env.npm_config_strict_ssl, 'false');
  assert.equal(plan.options.env[RELAUNCH_ENV], '1');
  assert.equal(plan.manual, 'npx --strict-ssl=false https://github.com/MatLomax/claude-plugins/releases/download/v2.0.0/claude-plugins-2.0.0.tgz --insecure');
  assert.equal(manualCommand('2.0.0', [], false), 'npx https://github.com/MatLomax/claude-plugins/releases/download/v2.0.0/claude-plugins-2.0.0.tgz');
});

test('relaunchPlan: refuses arguments that are not shell-safe', () => {
  for (const bad of ['a&b', 'x"y', '%PATH%', 'a b', 'x|y', '^']) {
    assert.throws(() => relaunchPlan({ version: '1.0.0', forwarded: [bad], insecure: false, platform: 'win32', env: {} }), /unsafe argument/);
  }
});

// fakeSpawn records the call and emits the given outcome on the next tick.
function fakeSpawn(outcome) {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    setImmediate(() => (outcome.error ? child.emit('error', outcome.error) : child.emit('exit', outcome.code, null)));
    return child;
  };
  return { spawn, calls };
}

function run(overrides) {
  const lines = [];
  const opts = {
    ownVersion: '1.0.0',
    cli: { insecure: false },
    fetchJson: async () => ({ tag_name: 'v1.1.0' }),
    env: { PATH: '/bin' },
    platform: 'linux',
    out: (l) => lines.push(l),
    ...overrides,
  };
  return selfUpdate(opts).then((r) => ({ r, lines }));
}

test('selfUpdate: --no-self-update skips the check without fetching or spawning', async () => {
  const { spawn, calls } = fakeSpawn({ code: 0 });
  const fetchJson = async () => { assert.fail('--no-self-update must not fetch the latest release'); };
  const { r, lines } = await run({ cli: { insecure: false, 'no-self-update': true }, fetchJson, spawn });
  assert.deepEqual(r, { action: 'continue' });
  assert.equal(calls.length, 0);
  assert.deepEqual(lines, []);
});

test('selfUpdate: skipped entirely when already relaunched', async () => {
  let fetched = false;
  const { spawn, calls } = fakeSpawn({ code: 0 });
  const { r } = await run({ env: { [RELAUNCH_ENV]: '1' }, fetchJson: async () => { fetched = true; return { tag_name: 'v9.0.0' }; }, spawn });
  assert.deepEqual(r, { action: 'continue' });
  assert.equal(fetched, false);
  assert.equal(calls.length, 0);
});

test('selfUpdate: continues when latest is equal, older or unknown', async () => {
  for (const fetchJson of [async () => ({ tag_name: 'v1.0.0' }), async () => ({ tag_name: 'v0.9.0' }), async () => { throw new Error('offline'); }]) {
    const { spawn, calls } = fakeSpawn({ code: 0 });
    const { r, lines } = await run({ fetchJson, spawn });
    assert.deepEqual(r, { action: 'continue' });
    assert.equal(calls.length, 0);
    assert.deepEqual(lines, []);
  }
});

test('selfUpdate: newer release relaunches and exits 0 when the child succeeds', async () => {
  const { spawn, calls } = fakeSpawn({ code: 0 });
  const { r, lines } = await run({ spawn, cli: { insecure: true, help: false, version: false } });
  assert.deepEqual(r, { action: 'exit', code: 0 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'npx');
  assert.deepEqual(calls[0].args, ['-y', 'https://github.com/MatLomax/claude-plugins/releases/download/v1.1.0/claude-plugins-1.1.0.tgz', '--insecure']);
  assert.equal(calls[0].options.env[RELAUNCH_ENV], '1');
  assert.equal(calls[0].options.env.npm_config_strict_ssl, 'false');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /newer installer v1\.1\.0 available .*relaunching/);
});

test('selfUpdate: child failure exits with its code and prints the manual command', async () => {
  const { spawn } = fakeSpawn({ code: 7 });
  const { r, lines } = await run({ spawn });
  assert.deepEqual(r, { action: 'exit', code: 7 });
  assert.equal(
    lines.at(-1),
    '[x] the newer installer v1.1.0 exited with code 7 (see its output above). If it never started (npm could not download it), run it yourself:\n' +
      '  npx https://github.com/MatLomax/claude-plugins/releases/download/v1.1.0/claude-plugins-1.1.0.tgz'
  );
});

test('selfUpdate: spawn error exits non-zero with the manual command, never continues', async () => {
  const { spawn } = fakeSpawn({ error: Object.assign(new Error('spawn npx ENOENT'), { code: 'ENOENT' }) });
  const { r, lines } = await run({ spawn });
  assert.deepEqual(r, { action: 'exit', code: 1 });
  assert.match(lines.at(-1), /could not start npx[\s\S]*npx https:\/\/github\.com\/MatLomax\/claude-plugins\/releases\/download\/v1\.1\.0\/claude-plugins-1\.1\.0\.tgz$/);

  const throwing = () => { throw new Error('EINVAL'); };
  const second = await run({ spawn: throwing });
  assert.deepEqual(second.r, { action: 'exit', code: 1 });
});

test('selfUpdate: a non-interactive run relaunches with its plugins and mode flags', async () => {
  for (const platform of ['linux', 'win32']) {
    const { spawn, calls } = fakeSpawn({ code: 0 });
    const cli = parseCli(['--plugins=worklog,mdtohtml', '--install-tools', '--no-worklog-init']);
    const { r } = await run({ spawn, cli, platform });
    assert.deepEqual(r, { action: 'exit', code: 0 });
    const flags = ['--plugins=worklog', '--plugins=mdtohtml', '--install-tools', '--no-worklog-init'];
    const url = 'https://github.com/MatLomax/claude-plugins/releases/download/v1.1.0/claude-plugins-1.1.0.tgz';
    if (platform === 'win32') assert.equal(calls[0].command, ['npx', '-y', url, ...flags].join(' '));
    else assert.deepEqual(calls[0].args, ['-y', url, ...flags]);
  }
});
