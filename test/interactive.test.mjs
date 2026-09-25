// The installer run as a real process in interactive mode, on a
// pseudo-terminal: keystrokes drive the clack prompts. A scratch repo is the
// cwd, HOME, the temp dir and every install dir point at scratch, PATH holds
// only shim binaries, and a preloaded network tripwire kills the process on
// any outgoing connection.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeShim, shimCalls, writeNetGuard } from './shim.mjs';
import { python3Path, runInPty } from './pty.mjs';

const script = fileURLToPath(new URL('../install.mjs', import.meta.url));
const python = process.platform === 'win32' ? null : python3Path();
const skip =
  process.platform === 'win32'
    ? 'the pseudo-terminal relay and the shim binaries are POSIX-only'
    : python
      ? false
      : 'no python3 with the pty module on PATH to host the pseudo-terminal';

const MARKETPLACE = { source: { source: 'github', repo: 'MatLomax/claude-plugins' }, autoUpdate: true };

// Keys as a terminal sends them.
const DOWN = '\u001b[B';
const SPACE = ' ';
const ENTER = '\r';

// hinted lists the plugins named in the output's `claude plugin install` hint lines
// (inside clack's note box).
function hinted(output) {
  return [...output.matchAll(/claude plugin install (\S+)@matlomax --scope project/g)].map((m) => m[1]);
}

// assertHintsBeforeOutro checks the install-hints note comes after the
// per-tool summaries (and the Done note) and before the closing trust-dialog
// line.
function assertHintsBeforeOutro(output) {
  const hints = output.indexOf('Show them as installed in Claude');
  const before = Math.max(output.indexOf('Plugins enabled:'), output.lastIndexOf('[ok] '), output.lastIndexOf('[!] '), output.lastIndexOf('[x] '));
  assert.ok(output.indexOf('Plugins enabled:') > 0, output);
  assert.ok(hints > before, output);
  assert.ok(hints < output.indexOf('Reload Claude Code in this repo'), output);
  assert.doesNotMatch(output, /\/plugin install/);
  assert.match(output, /Claude Desktop: in the Code tab, \+ > Plugins > Add plugin > choose the plugin > this project\./);
}

const PICKER = /Which plugins to enable in this repo\?[\s\S]*image-to-html/;

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'claude-plugins-tty-'));
  const s = { root, repo: join(root, 'repo'), bin: join(root, 'bin'), home: join(root, 'home'), tmp: join(root, 'tmp') };
  for (const d of [s.repo, s.bin, s.home, s.tmp]) mkdirSync(d);
  s.guard = writeNetGuard(root);
  s.settings = join(s.repo, '.claude', 'settings.json');
  return s;
}

function writeSettings(s, content) {
  mkdirSync(join(s.repo, '.claude'), { recursive: true });
  writeFileSync(s.settings, content);
}

// start runs the installer (no --plugins, so interactive) with
// --no-self-update on a pseudo-terminal, with an env that owns nothing of the
// real user's.
function start(s) {
  const env = {
    PATH: s.bin,
    HOME: s.home,
    USERPROFILE: s.home,
    LOCALAPPDATA: join(s.home, 'AppData', 'Local'),
    XDG_DATA_HOME: join(s.home, '.local', 'share'),
    TMPDIR: s.tmp,
    TMP: s.tmp,
    TEMP: s.tmp,
    TERM: 'xterm-256color',
  };
  return runInPty(python, [process.execPath, '--import', s.guard, script, '--no-self-update'], { cwd: s.repo, env, timeout: 30000 });
}

test('the picker is authoritative: ticking only image-to-html enables it, removes mdtohtml, keeps unrelated plugins', { skip }, async () => {
  const s = scratch();
  try {
    writeSettings(s, JSON.stringify({ enabledPlugins: { 'mdtohtml@matlomax': true, 'x@y': true } }));
    const tty = start(s);
    await tty.waitFor(PICKER);
    // Options are worklog, mdtohtml, image-to-html; all start unticked.
    tty.write(DOWN + DOWN + SPACE + ENTER);
    const { code, output } = await tty.exit;
    assert.equal(code, 0, output);
    assert.doesNotMatch(output, /NETWORK-ATTEMPT/);
    assert.match(output, /Plugins enabled: image-to-html(?![,\w-])/);
    assert.match(output, /Reload Claude Code in this repo/);
    assert.deepEqual(hinted(output), ['image-to-html']);
    assertHintsBeforeOutro(output);
    assert.deepEqual(JSON.parse(readFileSync(s.settings, 'utf8')), {
      enabledPlugins: { 'x@y': true, 'image-to-html@matlomax': true },
      extraKnownMarketplaces: { matlomax: MARKETPLACE },
    });
    assert.deepEqual(shimCalls(s.bin), []);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('interactively a failed worklog init is reported but the run still exits 0', { skip }, async () => {
  const s = scratch();
  try {
    writeShim(s.bin, 'worklog', { initFails: true });
    const tty = start(s);
    await tty.waitFor(PICKER);
    tty.write(SPACE + ENTER); // tick worklog, the first option
    await tty.waitFor(/Initialise worklog for this repo now\?/);
    tty.write(ENTER); // accept the default: yes
    const { code, output } = await tty.exit;
    assert.equal(code, 0, output);
    assert.doesNotMatch(output, /NETWORK-ATTEMPT/);
    assert.deepEqual(shimCalls(s.bin), ['worklog version', 'worklog init']);
    assert.match(output, /worklog init did not complete: worklog: cannot create \.worklog\/tasks\.db: read-only file system/);
    assert.match(output, /\[!\] worklog not initialised here/);
    assert.doesNotMatch(output, /claude-plugins-install: worklog init failed/);
    assert.deepEqual(hinted(output), ['worklog']);
    assertHintsBeforeOutro(output);
    assert.deepEqual(JSON.parse(readFileSync(s.settings, 'utf8')), {
      extraKnownMarketplaces: { matlomax: MARKETPLACE },
      enabledPlugins: { 'worklog@matlomax': true },
    });
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('interactively the install hints list exactly the ticked plugins', { skip }, async () => {
  const s = scratch();
  try {
    writeShim(s.bin, 'worklog');
    writeShim(s.bin, 'mdtohtml');
    const tty = start(s);
    await tty.waitFor(PICKER);
    tty.write(DOWN + SPACE + DOWN + SPACE + ENTER); // tick mdtohtml and image-to-html
    const { code, output } = await tty.exit;
    assert.equal(code, 0, output);
    assert.doesNotMatch(output, /NETWORK-ATTEMPT/);
    assert.deepEqual(hinted(output).sort(), ['image-to-html', 'mdtohtml']);
    assertHintsBeforeOutro(output);
    assert.match(output, /\[ok\] mdtohtml on PATH \(mdtohtml v9\.9\.9-shim\)\./);
    assert.doesNotMatch(output, /Just installed/);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('interactively a settings.json the merge cannot write into fails with exit 1 before the picker and is left untouched', { skip }, async () => {
  for (const content of ['[]', '{ not json', '{"enabledPlugins":"x"}', '{"extraKnownMarketplaces":{"matlomax":[]}}']) {
    const s = scratch();
    try {
      writeShim(s.bin, 'worklog');
      writeSettings(s, content);
      const { code, output } = await start(s).exit;
      assert.equal(code, 1, `${content}: ${output}`);
      assert.match(output, /settings\.json (must hold a JSON object|exists but is not valid JSON)/, content);
      assert.doesNotMatch(output, /Which plugins/, content);
      assert.doesNotMatch(output, /NETWORK-ATTEMPT/, content);
      assert.equal(readFileSync(s.settings, 'utf8'), content);
      assert.deepEqual(shimCalls(s.bin), []);
      assert.equal(existsSync(join(s.repo, '.worklog')), false);
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  }
});
