// The installer run as a real process in non-interactive mode (--plugins):
// no terminal, a scratch repo as cwd, HOME, the temp dir and every install dir
// pointed at scratch, PATH holding only shim binaries (or nothing), and a
// preloaded network tripwire: by default it kills the process on any outgoing
// connection; in record mode it logs the attempt and refuses it, so the
// installer's real network paths run and see the network as offline.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { writeShim, shimCalls, writeNetGuard, netRecord, writeFakeRelease } from './shim.mjs';
import { TOOLS } from '../lib/plugins.mjs';

const script = fileURLToPath(new URL('../install.mjs', import.meta.url));
const posixOnly = process.platform === 'win32' ? 'the shim binaries are POSIX executables' : false;

// scratch creates a repo dir, a bin dir (the child's whole PATH), a home and
// a temp dir. `record` switches the tripwire to record mode, logging to
// s.netLog.
function scratch({ record = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'claude-plugins-ni-'));
  const s = { root, repo: join(root, 'repo'), bin: join(root, 'bin'), home: join(root, 'home'), tmp: join(root, 'tmp') };
  for (const d of [s.repo, s.bin, s.home, s.tmp]) mkdirSync(d);
  s.netLog = join(root, 'net.log');
  s.guard = writeNetGuard(root, record ? { record: s.netLog } : {});
  return s;
}

// run starts the installer with stdin closed and stdout/stderr piped, so it
// has no terminal, and an env that owns nothing of the real user's. `path`
// replaces the child's PATH and `preload` the network tripwire.
function run(s, args, { path = s.bin, preload = s.guard } = {}) {
  const env = {
    PATH: path,
    HOME: s.home,
    USERPROFILE: s.home,
    LOCALAPPDATA: join(s.home, 'AppData', 'Local'),
    XDG_DATA_HOME: join(s.home, '.local', 'share'),
    TMPDIR: s.tmp,
    TMP: s.tmp,
    TEMP: s.tmp,
  };
  return spawnSync(process.execPath, ['--import', preload, script, ...args], {
    cwd: s.repo,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20000,
  });
}

function settings(s) {
  return JSON.parse(readFileSync(join(s.repo, '.claude', 'settings.json'), 'utf8'));
}

// tree lists every file and directory under `dir`, relative to it.
function tree(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = prefix + e.name;
    return e.isDirectory() ? [rel + '/', ...tree(join(dir, e.name), rel + '/')] : [rel];
  });
}

// Box drawing (U+2500-U+257F) and ANSI escapes are what clack would print.
function assertPlain(r) {
  assert.doesNotMatch(r.stdout + r.stderr, /[\u2500-\u257f]|\u001b\[/, 'non-interactive output must be plain lines');
}

// hinted lists the plugins named in the output's `claude plugin install` hint lines.
function hinted(output) {
  return [...output.matchAll(/^\s*claude plugin install (\S+)@matlomax --scope project$/gm)].map((m) => m[1]);
}

const MARKETPLACE = { source: { source: 'github', repo: 'MatLomax/claude-plugins' }, autoUpdate: true };

test('the network tripwire really fires on an outgoing connection', { skip: posixOnly }, () => {
  const s = scratch();
  try {
    const r = spawnSync(process.execPath, ['--import', s.guard, '-e', "require('node:https').get('https://api.github.com/')"], { encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 99, r.stderr);
    assert.match(r.stderr, /NETWORK-ATTEMPT/);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('--plugins merges settings.json additively and keeps unrelated keys', { skip: posixOnly }, () => {
  const s = scratch();
  try {
    mkdirSync(join(s.repo, '.claude'));
    writeFileSync(
      join(s.repo, '.claude', 'settings.json'),
      JSON.stringify({ theme: 'dark', enabledPlugins: { 'mdtohtml@matlomax': true, 'other@elsewhere': false } })
    );
    const r = run(s, ['--plugins=image-to-html', '--no-self-update']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(settings(s), {
      theme: 'dark',
      enabledPlugins: { 'mdtohtml@matlomax': true, 'other@elsewhere': false, 'image-to-html@matlomax': true },
      extraKnownMarketplaces: { matlomax: MARKETPLACE },
    });
    assert.match(r.stdout, /Plugins enabled: image-to-html/);
    assert.equal(r.stderr, '');
    assertPlain(r);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('--plugins=worklog with the binary on PATH runs worklog init by default and exits 0', { skip: posixOnly }, () => {
  const s = scratch();
  try {
    writeShim(s.bin, 'worklog');
    const r = run(s, ['--plugins=worklog', '--no-self-update']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(shimCalls(s.bin), ['worklog version', 'worklog init']);
    assert.ok(existsSync(join(s.repo, '.worklog', 'tasks.db')));
    assert.match(r.stdout, /\[ok\] worklog on PATH \(worklog v9\.9\.9-shim\)\./);
    assert.match(r.stdout, /\[ok\] worklog initialised for this repo/);
    assert.equal(settings(s).enabledPlugins['worklog@matlomax'], true);
    assertPlain(r);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('--no-worklog-init leaves the repo uninitialised and still exits 0', { skip: posixOnly }, () => {
  const s = scratch();
  try {
    writeShim(s.bin, 'worklog');
    const r = run(s, ['--plugins', 'worklog', '--no-worklog-init', '--no-self-update']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(shimCalls(s.bin), ['worklog version']);
    assert.equal(existsSync(join(s.repo, '.worklog')), false);
    assert.match(r.stdout, /\[!\] worklog not initialised here/);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('a missing binary without --install-tools is reported, settings still written, exit 1, no download', { skip: posixOnly }, () => {
  const s = scratch();
  try {
    writeShim(s.bin, 'worklog');
    const r = run(s, ['--plugins=worklog,mdtohtml', '--no-self-update']);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.doesNotMatch(r.stderr, /NETWORK-ATTEMPT/);
    assert.doesNotMatch(r.stdout, /Downloading/);
    assert.match(r.stdout, /\[x\] mdtohtml not on PATH/);
    assert.match(r.stdout, /\[ok\] worklog initialised/);
    assert.match(r.stderr, /no usable binary for mdtohtml\. Re-run with --install-tools/);
    const st = settings(s);
    assert.equal(st.enabledPlugins['worklog@matlomax'], true);
    assert.equal(st.enabledPlugins['mdtohtml@matlomax'], true);
    assert.deepEqual(st.extraKnownMarketplaces.matlomax, MARKETPLACE);
    assert.equal(existsSync(join(s.home, '.local')), false, 'nothing was installed into HOME');
    assertPlain(r);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('the install hints list exactly the listed plugins, after the tool summaries and before the closing line', { skip: posixOnly }, () => {
  for (const [list, expected] of [
    ['worklog,image-to-html', ['worklog', 'image-to-html']],
    ['mdtohtml', ['mdtohtml']],
  ]) {
    const s = scratch();
    try {
      writeShim(s.bin, 'worklog');
      writeShim(s.bin, 'mdtohtml');
      const r = run(s, [`--plugins=${list}`, '--no-worklog-init', '--no-self-update']);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.deepEqual(hinted(r.stdout), expected, r.stdout);
      const hints = r.stdout.indexOf('Show them as installed in Claude:\n');
      assert.ok(hints > r.stdout.lastIndexOf('[ok] '), 'after the per-tool summaries');
      assert.ok(hints < r.stdout.indexOf('Reload Claude Code in this repo'), 'before the closing line');
      assert.match(r.stdout, expected.length > 1
        ? /^ {2}They are enabled in \.claude\/settings\.json already; installing them explicitly also makes them show as installed in Claude's plugin list\.$/m
        : /^ {2}It is enabled in \.claude\/settings\.json already; installing it explicitly also makes it show as installed in Claude's plugin list\.$/m);
      assert.doesNotMatch(r.stdout, /\/plugin install/);
      assert.match(r.stdout, /^ {2}Claude Desktop: in the Code tab, \+ > Plugins > Add plugin > choose the plugin > this project\.$/m);
      assert.doesNotMatch(r.stdout, /Just installed/, 'nothing was installed');
      assert.equal(r.stderr, '');
      assertPlain(r);
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  }
});

test('flag errors exit 2 before any work', () => {
  const s = scratch();
  try {
    const cases = [
      [['--plugins='], /--plugins needs at least one plugin name \(valid: worklog, mdtohtml, image-to-html\)/],
      [['--plugins=worklog,nope'], /unknown plugin 'nope' \(valid: worklog, mdtohtml, image-to-html\)/],
      [['--install-tools'], /--install-tools only applies with --plugins/],
      [['--no-worklog-init'], /--no-worklog-init only applies with --plugins/],
    ];
    for (const [args, message] of cases) {
      const r = run(s, args);
      assert.equal(r.status, 2, `${args}: ${r.stderr}`);
      assert.equal(r.stdout, '');
      assert.match(r.stderr, /^claude-plugins-install: /);
      assert.match(r.stderr, message);
      assert.match(r.stderr, /\n\nUsage:/);
    }
    assert.equal(existsSync(join(s.repo, '.claude')), false);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('the record-mode tripwire logs the attempt and refuses it instead of exiting', { skip: posixOnly }, () => {
  const s = scratch({ record: true });
  try {
    const code = "require('node:https').get('https://api.github.com/x').on('error', (e) => { console.log(e.code); process.exitCode = 3; })";
    const r = spawnSync(process.execPath, ['--import', s.guard, '-e', code], { encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 3, r.stderr);
    assert.equal(r.stdout, 'ECONNREFUSED\n');
    assert.deepEqual(netRecord(s.netLog), ['get https://api.github.com/x', 'connect api.github.com:443']);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('without --no-self-update the real update check reaches for GitHub, fails open, and the run completes', { skip: posixOnly }, () => {
  const s = scratch({ record: true });
  try {
    const r = run(s, ['--plugins=image-to-html']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(netRecord(s.netLog), ['get https://api.github.com/repos/MatLomax/claude-plugins/releases/latest', 'connect api.github.com:443']);
    assert.equal(r.stderr, '');
    assert.deepEqual(settings(s), { enabledPlugins: { 'image-to-html@matlomax': true }, extraKnownMarketplaces: { matlomax: MARKETPLACE } });
    assertPlain(r);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('--install-tools with nothing on PATH runs the real provision, reports the failure, exits 1 and writes only settings.json', { skip: posixOnly }, () => {
  const s = scratch({ record: true });
  try {
    const r = run(s, ['--plugins=worklog', '--install-tools', '--no-self-update']);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.deepEqual(netRecord(s.netLog), ['get https://api.github.com/repos/MatLomax/worklog/releases/latest', 'connect api.github.com:443']);
    assert.match(r.stdout, /Downloading the latest worklog release \.\.\./);
    assert.match(r.stderr, /^worklog: Could not install worklog: could not reach the latest worklog release: connect ECONNREFUSED api\.github\.com/m);
    assert.match(r.stdout, /\[x\] worklog not on PATH/);
    assert.match(r.stderr, /no usable binary for worklog\. Install it by hand, then re-run\./);
    assert.equal(settings(s).enabledPlugins['worklog@matlomax'], true);
    assert.deepEqual(tree(s.root).sort(), ['bin/', 'home/', 'net-record.mjs', 'net.log', 'repo/', 'repo/.claude/', 'repo/.claude/settings.json', 'tmp/']);
    assertPlain(r);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('a failed worklog init exits 1 with the reason on stderr, and settings are still written', { skip: posixOnly }, () => {
  const s = scratch();
  try {
    writeShim(s.bin, 'worklog', { initFails: true });
    const r = run(s, ['--plugins=worklog', '--no-self-update']);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.deepEqual(shimCalls(s.bin), ['worklog version', 'worklog init']);
    assert.match(r.stderr, /^worklog: worklog init did not complete: worklog: cannot create \.worklog\/tasks\.db: read-only file system$/m);
    assert.match(r.stderr, /claude-plugins-install: worklog init failed in this repo \(see above\)/);
    assert.doesNotMatch(r.stderr, /no usable binary/);
    assert.match(r.stdout, /\[ok\] worklog on PATH/);
    assert.match(r.stdout, /\[!\] worklog not initialised here/);
    assert.equal(settings(s).enabledPlugins['worklog@matlomax'], true);
    assertPlain(r);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('enabledPlugins keys are written in worklog, image-to-html, mdtohtml order', { skip: posixOnly }, () => {
  const s = scratch();
  try {
    writeShim(s.bin, 'worklog');
    writeShim(s.bin, 'mdtohtml');
    const r = run(s, ['--plugins=mdtohtml,image-to-html,worklog', '--no-worklog-init', '--no-self-update']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(Object.keys(settings(s).enabledPlugins), ['worklog@matlomax', 'image-to-html@matlomax', 'mdtohtml@matlomax']);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('a settings.json that is not a JSON object, or whose merged entries are not objects, fails with exit 1 before any tool work and is left untouched', { skip: posixOnly }, () => {
  const cases = [
    ['[]', /must hold a JSON object, but it holds an array/],
    ['null', /must hold a JSON object, but it holds null/],
    ['42', /must hold a JSON object, but it holds a number/],
    ['"x"', /must hold a JSON object, but it holds a string/],
    ['{ not json', /exists but is not valid JSON/],
    ['{"enabledPlugins":[],"extraKnownMarketplaces":[]}', /must hold a JSON object at "enabledPlugins", but it holds an array/],
    ['{"enabledPlugins":"x"}', /must hold a JSON object at "enabledPlugins", but it holds a string/],
    ['{"extraKnownMarketplaces":[]}', /must hold a JSON object at "extraKnownMarketplaces", but it holds an array/],
    ['{"extraKnownMarketplaces":{"matlomax":"x"}}', /must hold a JSON object at "extraKnownMarketplaces\.matlomax", but it holds a string/],
  ];
  for (const [content, message] of cases) {
    const s = scratch();
    try {
      writeShim(s.bin, 'worklog');
      mkdirSync(join(s.repo, '.claude'));
      const file = join(s.repo, '.claude', 'settings.json');
      writeFileSync(file, content);
      const r = run(s, ['--plugins=worklog,image-to-html', '--install-tools', '--no-self-update']);
      assert.equal(r.status, 1, `${content}: ${r.stdout + r.stderr}`);
      assert.match(r.stderr, /^claude-plugins-install: .*settings\.json /);
      assert.match(r.stderr, message);
      assert.equal(readFileSync(file, 'utf8'), content);
      assert.deepEqual(shimCalls(s.bin), [], 'no version probe, no worklog init');
      assert.equal(existsSync(join(s.repo, '.worklog')), false);
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  }
});

test('a malformed settings.json with --install-tools and nothing on PATH fails before any download', { skip: posixOnly }, () => {
  const s = scratch({ record: true });
  try {
    mkdirSync(join(s.repo, '.claude'));
    writeFileSync(join(s.repo, '.claude', 'settings.json'), '{ not json');
    const r = run(s, ['--plugins=worklog', '--install-tools', '--no-self-update']);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /exists but is not valid JSON/);
    assert.deepEqual(netRecord(s.netLog), [], 'provision never ran');
    assert.doesNotMatch(r.stdout, /Downloading/);
    assert.deepEqual(tree(s.home), []);
    assert.deepEqual(tree(s.tmp), []);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

// fakeWorklogRelease serves a latest worklog release (tag v9.9.9, sha256
// digest) whose asset for this platform is a worklog shim, and returns the
// preload for run() and the directory whose calls.log the installed shim
// appends to.
function fakeWorklogRelease(s) {
  const tool = TOOLS.worklog;
  const os = tool.osMap[process.platform];
  const asset = `worklog-${os}-${tool.archMap[process.arch]}${os === 'windows' ? '.exe' : ''}`;
  const release = join(s.root, 'release');
  mkdirSync(release);
  const bin = writeShim(release, 'worklog');
  const url = `https://github.com/MatLomax/worklog/releases/download/v9.9.9/${asset}`;
  const digest = 'sha256:' + createHash('sha256').update(readFileSync(bin)).digest('hex');
  const preload = writeFakeRelease(s.root, {
    'https://api.github.com/repos/MatLomax/worklog/releases/latest': { json: { tag_name: 'v9.9.9', assets: [{ name: asset, browser_download_url: url, digest }] } },
    [url]: { file: bin },
  });
  return { preload, release };
}

const noWorklogAsset = TOOLS.worklog.osMap[process.platform] && TOOLS.worklog.archMap[process.arch] ? false : 'no worklog release asset for this platform';

test('--install-tools into a ~/.local/bin that is not on PATH exits 0 with a stderr warning and no restart reminder', { skip: posixOnly || noWorklogAsset }, () => {
  const s = scratch();
  try {
    const { preload, release } = fakeWorklogRelease(s);
    const r = run(s, ['--plugins=worklog', '--install-tools', '--no-self-update'], { preload });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const binDir = join(s.home, '.local', 'bin');
    assert.ok(existsSync(join(binDir, 'worklog')), 'the release was installed into ~/.local/bin');
    assert.deepEqual(shimCalls(release), ['worklog init'], 'worklog init ran through the installed binary');
    assert.match(r.stdout, /\[ok\] worklog installed \(v9\.9\.9\)\./);
    assert.ok(r.stdout.includes(`[!] ${binDir} is not on your PATH. Add it in your shell profile, e.g. export PATH="$HOME/.local/bin:$PATH", then open a new terminal.`), r.stdout);
    assert.doesNotMatch(r.stdout, /Just installed/);
    assert.equal(
      r.stderr,
      `claude-plugins-install: warning: worklog was installed to ${binDir}, which is not on your PATH, so Claude Code will not find it until you add it in your shell profile (the worklog summary above shows the line), then open a new terminal and restart Claude Code.\n`
    );
    assert.equal(settings(s).enabledPlugins['worklog@matlomax'], true);
    assertPlain(r);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('--install-tools into a ~/.local/bin already on PATH exits 0 with the restart reminder and nothing on stderr', { skip: posixOnly || noWorklogAsset }, () => {
  const s = scratch();
  try {
    const { preload, release } = fakeWorklogRelease(s);
    const binDir = join(s.home, '.local', 'bin');
    const r = run(s, ['--plugins=worklog', '--install-tools', '--no-self-update'], { preload, path: `${s.bin}:${binDir}` });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(shimCalls(release), ['worklog init']);
    assert.match(r.stdout, /\[ok\] worklog installed \(v9\.9\.9\)\./);
    assert.doesNotMatch(r.stdout, /not on your PATH/);
    assert.match(r.stdout, /^\[!\] Just installed: worklog\. Restart Claude Code \/ Claude Desktop and any open terminals so they pick up the new binary\.$/m);
    assert.equal(r.stderr, '');
    assertPlain(r);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});
