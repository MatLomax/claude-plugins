// The shared install flow driven in-process with the non-interactive
// decisions built from real parsed flags. Only `provision` (the GitHub
// download) is injected; tool probes and `worklog init` spawn real shim
// binaries found through the run's own PATH.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCli } from '../lib/args.mjs';
import { runInstall, nonInteractiveDecisions, nonInteractiveOutcome, installHints, restartLine, mergeSettings, readSettings } from '../lib/flow.mjs';
import { integrityLine } from '../lib/tls.mjs';
import { writeShim, shimCalls } from './shim.mjs';

const posixOnly = process.platform === 'win32' ? 'the shim binaries are POSIX executables' : false;

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'claude-plugins-flow-'));
  const s = { root, repo: join(root, 'repo'), bin: join(root, 'bin'), provisioned: join(root, 'provisioned') };
  for (const d of [s.repo, s.bin, s.provisioned]) mkdirSync(d);
  return s;
}

function recordingUi() {
  const out = { messages: [], notes: [], warnings: [], restart: [] };
  return {
    out,
    ui: {
      message: (t) => (t.startsWith('[!] Just installed:') ? out.restart : out.messages).push(t),
      note: (body, title) => out.notes.push({ title, body }),
      warn: (body, title) => out.warnings.push({ title, body }),
    },
  };
}

// flow runs runInstall for an argv, the way main() does in --plugins mode.
async function flow(s, argv, provision) {
  const cli = parseCli(argv);
  const env = { PATH: s.bin };
  const { ui, out } = recordingUi();
  const result = await runInstall({
    plugins: cli.plugins,
    additive: true,
    cwd: s.repo,
    env,
    platform: 'linux',
    insecure: cli.insecure,
    decisions: nonInteractiveDecisions(cli),
    provision,
    ui,
  });
  const settings = JSON.parse(readFileSync(join(s.repo, '.claude', 'settings.json'), 'utf8'));
  return { ...result, env, out, settings };
}

function recordingProvision(impl) {
  const calls = [];
  const provision = async (id) => {
    calls.push(id);
    return impl(id);
  };
  return { provision, calls };
}

test('provision is called only for a missing listed tool, and only with --install-tools', { skip: posixOnly }, async () => {
  for (const [argv, expectedCalls] of [
    [['--plugins=worklog,mdtohtml,image-to-html', '--install-tools'], ['mdtohtml']],
    [['--plugins=worklog,mdtohtml,image-to-html'], []],
    [['--plugins=worklog', '--install-tools'], []],
  ]) {
    const s = scratch();
    try {
      writeShim(s.bin, 'worklog');
      const { provision, calls } = recordingProvision(() => ({ ok: false, msg: 'offline' }));
      const r = await flow(s, argv, provision);
      assert.deepEqual(calls, expectedCalls, argv.join(' '));
      assert.equal(r.toolStatus.worklog.ok, true);
      assert.equal(r.toolStatus.worklog.initialised, true);
      assert.deepEqual(r.unusable, argv[0].includes('mdtohtml') ? ['mdtohtml'] : []);
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  }
});

test('a successful provision makes worklog usable for worklog init in the same run', { skip: posixOnly }, async () => {
  const s = scratch();
  try {
    const { provision, calls } = recordingProvision((id) => {
      writeShim(s.provisioned, id);
      return { ok: true, version: 'v9.9.9', verified: true, dir: s.provisioned, path: { windows: false, onPath: false } };
    });
    const r = await flow(s, ['--plugins=worklog', '--install-tools'], provision);
    assert.deepEqual(calls, ['worklog']);
    assert.equal(r.env.PATH, `${s.provisioned}:${s.bin}`);
    assert.deepEqual(shimCalls(s.provisioned), ['worklog init']);
    assert.ok(existsSync(join(s.repo, '.worklog', 'tasks.db')));
    assert.deepEqual(r.unusable, []);
    assert.equal(r.toolStatus.worklog.initialised, true);
    assert.deepEqual(r.out.messages, ['Downloading the latest worklog release ...']);
    const summary = r.out.notes.find((n) => n.title === 'worklog').body;
    assert.match(summary, /^\[ok\] worklog installed \(v9\.9\.9\)\.$/m);
    assert.doesNotMatch(summary, /on PATH \(/);
    assert.ok(summary.includes(integrityLine({ verified: true, insecure: false })));
    assert.ok(summary.includes(`[!] ${s.provisioned} is not on your PATH. Add it in your shell profile, e.g. export PATH="${s.provisioned}:$PATH", then open a new terminal.`), summary);
    assert.match(summary, /\[ok\] worklog initialised for this repo/);
    assert.deepEqual(r.pathFailed, []);
    assert.deepEqual(r.notOnPath, ['worklog']);
    assert.deepEqual(r.out.restart, [], 'a restart does not help a binary whose directory is not on PATH');
    assert.deepEqual(nonInteractiveOutcome(r, { installTools: true }), {
      code: 0,
      errors: [],
      warnings: [
        `worklog was installed to ${s.provisioned}, which is not on your PATH, so Claude Code will not find it until you add it in your shell profile (the worklog summary above shows the line), then open a new terminal and restart Claude Code.`,
      ],
    });
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('the restart reminder names only the tools installed into a directory already on PATH', { skip: posixOnly }, async () => {
  const s = scratch();
  try {
    const onPathDir = join(s.root, 'on-path');
    mkdirSync(onPathDir);
    const { provision } = recordingProvision((id) => {
      if (id === 'worklog') {
        writeShim(onPathDir, id);
        return { ok: true, version: 'v9.9.9', verified: true, dir: onPathDir, path: { windows: false, onPath: true } };
      }
      writeShim(s.provisioned, id);
      return { ok: true, version: 'v9.9.9', verified: true, dir: s.provisioned, path: { windows: false, onPath: false } };
    });
    const r = await flow(s, ['--plugins=worklog,mdtohtml', '--install-tools'], provision);
    assert.deepEqual(r.unusable, []);
    assert.deepEqual(r.notOnPath, ['mdtohtml']);
    assert.doesNotMatch(r.out.notes.find((n) => n.title === 'worklog').body, /not on your PATH/);
    assert.match(r.out.notes.find((n) => n.title === 'mdtohtml').body, /is not on your PATH/);
    assert.deepEqual(r.out.restart, [
      '[!] Just installed: worklog. Restart Claude Code / Claude Desktop and any open terminals so they pick up the new binary.',
    ]);
    const outcome = nonInteractiveOutcome(r, { installTools: true });
    assert.equal(outcome.code, 0);
    assert.deepEqual(outcome.errors, []);
    assert.equal(outcome.warnings.length, 1);
    assert.match(outcome.warnings[0], /^mdtohtml was installed to .*, which is not on your PATH/);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('a failed provision leaves the plugin unusable, skips init, and still writes settings', { skip: posixOnly }, async () => {
  const s = scratch();
  try {
    const { provision, calls } = recordingProvision(() => ({ ok: false, msg: 'could not reach the latest worklog release: offline' }));
    const r = await flow(s, ['--plugins=worklog', '--install-tools'], provision);
    assert.deepEqual(calls, ['worklog']);
    assert.deepEqual(r.unusable, ['worklog']);
    assert.equal(r.env.PATH, s.bin);
    assert.equal(existsSync(join(s.repo, '.worklog')), false);
    assert.deepEqual(r.out.warnings, [{ title: 'worklog', body: 'Could not install worklog: could not reach the latest worklog release: offline' }]);
    assert.match(r.out.notes.find((n) => n.title === 'worklog').body, /^\[x\] worklog not on PATH/);
    assert.deepEqual(r.out.restart, [], 'nothing was installed, so no restart reminder');
    assert.equal(r.settings.enabledPlugins['worklog@matlomax'], true);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('nonInteractiveDecisions maps the flags', async () => {
  const d = nonInteractiveDecisions(parseCli(['--plugins=worklog']));
  assert.equal(await d.installTool('worklog'), false);
  assert.equal(await d.initWorklog(), true);
  const e = nonInteractiveDecisions(parseCli(['--plugins=worklog', '--install-tools', '--no-worklog-init']));
  assert.equal(await e.installTool('worklog'), true);
  assert.equal(await e.initWorklog(), false);
});

test('mergeSettings: additive leaves unlisted known plugins, authoritative removes them', () => {
  const before = () => ({ theme: 'dark', enabledPlugins: { 'mdtohtml@matlomax': true, 'x@other': true } });
  const additive = mergeSettings(before(), ['worklog'], { additive: true });
  assert.deepEqual(additive.enabledPlugins, { 'mdtohtml@matlomax': true, 'x@other': true, 'worklog@matlomax': true });
  const authoritative = mergeSettings(before(), ['worklog'], { additive: false });
  assert.deepEqual(authoritative.enabledPlugins, { 'x@other': true, 'worklog@matlomax': true });
  for (const s of [additive, authoritative]) {
    assert.equal(s.theme, 'dark');
    assert.deepEqual(s.extraKnownMarketplaces.matlomax, { source: { source: 'github', repo: 'MatLomax/claude-plugins' }, autoUpdate: true });
  }
});

test('mergeSettings adds enabledPlugins keys in worklog, image-to-html, mdtohtml order in both modes', () => {
  for (const additive of [true, false]) {
    const merged = mergeSettings({}, ['worklog', 'mdtohtml', 'image-to-html'], { additive });
    assert.deepEqual(Object.keys(merged.enabledPlugins), ['worklog@matlomax', 'image-to-html@matlomax', 'mdtohtml@matlomax'], `additive: ${additive}`);
  }
});

test('readSettings: {} when absent, the object when valid, and throws for anything else', () => {
  const s = scratch();
  try {
    assert.deepEqual(readSettings(s.repo), {});
    mkdirSync(join(s.repo, '.claude'));
    const file = join(s.repo, '.claude', 'settings.json');
    writeFileSync(file, '{"theme":"dark"}');
    assert.deepEqual(readSettings(s.repo), { theme: 'dark' });
    for (const [content, kind] of [['[]', 'an array'], ['null', 'null'], ['0', 'a number'], ['"s"', 'a string'], ['true', 'a boolean']]) {
      writeFileSync(file, content);
      assert.throws(() => readSettings(s.repo), new RegExp(`must hold a JSON object, but it holds ${kind}\\.`), content);
    }
    for (const content of ['', '{ not json']) {
      writeFileSync(file, content);
      assert.throws(() => readSettings(s.repo), /exists but is not valid JSON/, JSON.stringify(content));
    }
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('readSettings: enabledPlugins, extraKnownMarketplaces and its matlomax entry must be objects when present', () => {
  const s = scratch();
  try {
    mkdirSync(join(s.repo, '.claude'));
    const file = join(s.repo, '.claude', 'settings.json');
    const ok = [
      {},
      { enabledPlugins: {}, extraKnownMarketplaces: {} },
      { enabledPlugins: { 'x@y': true }, extraKnownMarketplaces: { other: 'anything', matlomax: { autoUpdate: false } } },
    ];
    for (const value of ok) {
      writeFileSync(file, JSON.stringify(value));
      assert.deepEqual(readSettings(s.repo), value);
    }
    const bad = [
      [{ enabledPlugins: [] }, 'enabledPlugins', 'an array'],
      [{ enabledPlugins: 'x' }, 'enabledPlugins', 'a string'],
      [{ enabledPlugins: null }, 'enabledPlugins', 'null'],
      [{ enabledPlugins: {}, extraKnownMarketplaces: [] }, 'extraKnownMarketplaces', 'an array'],
      [{ extraKnownMarketplaces: 1 }, 'extraKnownMarketplaces', 'a number'],
      [{ extraKnownMarketplaces: { matlomax: true } }, 'extraKnownMarketplaces.matlomax', 'a boolean'],
      [{ extraKnownMarketplaces: { matlomax: [] } }, 'extraKnownMarketplaces.matlomax', 'an array'],
      [{ extraKnownMarketplaces: { matlomax: null } }, 'extraKnownMarketplaces.matlomax', 'null'],
    ];
    for (const [value, key, kind] of bad) {
      writeFileSync(file, JSON.stringify(value));
      const escaped = key.replace('.', '\\.');
      assert.throws(() => readSettings(s.repo), new RegExp(`settings\\.json must hold a JSON object at "${escaped}", but it holds ${kind}\\. Fix or remove it`), JSON.stringify(value));
    }
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('runInstall rejects an unmergeable settings.json before probing, provisioning or initialising', { skip: posixOnly }, async () => {
  for (const content of ['{ not json', '[]', '{"enabledPlugins":"x"}', '{"enabledPlugins":[],"extraKnownMarketplaces":[]}']) {
    const s = scratch();
    try {
      writeShim(s.bin, 'worklog');
      mkdirSync(join(s.repo, '.claude'));
      writeFileSync(join(s.repo, '.claude', 'settings.json'), content);
      const { provision, calls } = recordingProvision(() => assert.fail('provision must not run'));
      await assert.rejects(flow(s, ['--plugins=worklog,mdtohtml', '--install-tools'], provision), /settings\.json/);
      assert.deepEqual(calls, []);
      assert.deepEqual(shimCalls(s.bin), []);
      assert.equal(readFileSync(join(s.repo, '.claude', 'settings.json'), 'utf8'), content);
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  }
});

test('runInstall reports initFailed when worklog init fails, and only then', { skip: posixOnly }, async () => {
  for (const [initFails, argv, expected] of [
    [true, ['--plugins=worklog'], true],
    [false, ['--plugins=worklog'], false],
    [true, ['--plugins=worklog', '--no-worklog-init'], false],
  ]) {
    const s = scratch();
    try {
      writeShim(s.bin, 'worklog', { initFails });
      const r = await flow(s, argv, async () => assert.fail('provision must not run'));
      assert.equal(r.initFailed, expected, argv.join(' '));
      assert.equal(r.settings.enabledPlugins['worklog@matlomax'], true);
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  }
});

test('a Windows install whose user PATH update failed is reported and listed in pathFailed', { skip: posixOnly }, async () => {
  const s = scratch();
  try {
    const { provision } = recordingProvision((id) => {
      writeShim(s.provisioned, id);
      return { ok: true, version: 'v9.9.9', verified: true, dir: s.provisioned, path: { windows: true, ok: false, added: false, broadcast: false, error: 'Requested registry access is not allowed.' } };
    });
    const r = await flow(s, ['--plugins=worklog,image-to-html', '--install-tools'], provision);
    assert.deepEqual(r.unusable, []);
    assert.deepEqual(r.pathFailed, ['worklog']);
    assert.deepEqual(r.notOnPath, []);
    const summary = r.out.notes.find((n) => n.title === 'worklog').body;
    assert.ok(
      summary.includes(`[x] could not add ${s.provisioned} to your user PATH: Requested registry access is not allowed. Add it by hand (Start > "Edit environment variables for your account").`),
      summary
    );
    assert.doesNotMatch(summary, /not on your PATH/);
    assert.deepEqual(r.out.restart, [], 'a restart does not help a binary whose directory is not on the user PATH');
    assert.deepEqual(nonInteractiveOutcome(r, { installTools: true }), {
      code: 1,
      errors: [
        `worklog was installed to ${s.provisioned}, but that directory could not be added to your user PATH (Requested registry access is not allowed), so Claude Code will not find it. Add it by hand (Start > "Edit environment variables for your account"), then restart Claude Code.`,
      ],
      warnings: [],
    });
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('the install-hints note lists exactly the plugins of this run, after the tool summaries', { skip: posixOnly }, async () => {
  const s = scratch();
  try {
    writeShim(s.bin, 'mdtohtml');
    const r = await flow(s, ['--plugins=mdtohtml,image-to-html'], async () => assert.fail('provision must not run'));
    const titles = r.out.notes.map((n) => n.title);
    assert.deepEqual(titles, ['Done', 'mdtohtml', 'Show them as installed in Claude']);
    const body = r.out.notes.at(-1).body;
    assert.deepEqual(body.match(/claude plugin install \S+ --scope project/g), [
      'claude plugin install mdtohtml@matlomax --scope project',
      'claude plugin install image-to-html@matlomax --scope project',
    ]);
    assert.match(body, /^They are enabled in \.claude\/settings\.json already; installing them explicitly also makes them show as installed in Claude's plugin list\.$/m);
    assert.doesNotMatch(body, /\/plugin install/, 'the in-session command takes no --scope');
    assert.match(body, /^Claude Desktop: in the Code tab, \+ > Plugins > Add plugin > choose the plugin > this project\.$/m);
    assert.match(r.out.notes.find((n) => n.title === 'mdtohtml').body, /^\[ok\] mdtohtml on PATH \(mdtohtml v9\.9\.9-shim\)\.$/m);
    assert.deepEqual(r.out.restart, []);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('installHints: one line per plugin, singular wording for one, null for none', () => {
  assert.equal(installHints([]), null);
  assert.equal(
    installHints(['worklog']),
    [
      "It is enabled in .claude/settings.json already; installing it explicitly also makes it show as installed in Claude's plugin list.",
      'Claude Code, in a terminal in this repo:',
      '  claude plugin marketplace add MatLomax/claude-plugins',
      '  claude plugin install worklog@matlomax --scope project',
      'Claude Desktop: in the Code tab, + > Plugins > Add plugin > choose the plugin > this project.',
    ].join('\n')
  );
});

test('restartLine names the tools just installed, or is null', () => {
  assert.equal(restartLine([]), null);
  assert.equal(restartLine(['worklog', 'mdtohtml']), '[!] Just installed: worklog, mdtohtml. Restart Claude Code / Claude Desktop and any open terminals so they pick up the new binary.');
});

test('nonInteractiveOutcome: exit 1 with one line per problem, 0 when there is none', () => {
  const clean = { toolStatus: {}, unusable: [], pathFailed: [], notOnPath: [], initFailed: false };
  assert.deepEqual(nonInteractiveOutcome(clean, { installTools: false }), { code: 0, errors: [], warnings: [] });
  assert.deepEqual(nonInteractiveOutcome({ ...clean, unusable: ['mdtohtml'] }, { installTools: false }), {
    code: 1,
    errors: ['no usable binary for mdtohtml. Re-run with --install-tools, or install it by hand and re-run.'],
    warnings: [],
  });
  assert.deepEqual(nonInteractiveOutcome({ ...clean, unusable: ['worklog', 'mdtohtml'] }, { installTools: true }).errors, [
    'no usable binary for worklog, mdtohtml. Install them by hand, then re-run.',
  ]);
  const pathFailed = {
    ...clean,
    toolStatus: { mdtohtml: { ok: true, installedTo: 'C:\\P\\mdtohtml', path: { windows: true, ok: false, error: 'PowerShell exited with code 1\n' } } },
    pathFailed: ['mdtohtml'],
    initFailed: true,
  };
  assert.deepEqual(nonInteractiveOutcome(pathFailed, { installTools: true }), {
    code: 1,
    errors: [
      'mdtohtml was installed to C:\\P\\mdtohtml, but that directory could not be added to your user PATH (PowerShell exited with code 1), so Claude Code will not find it. Add it by hand (Start > "Edit environment variables for your account"), then restart Claude Code.',
      'worklog init failed in this repo (see above). Fix the cause, then run `worklog init` here or re-run.',
    ],
    warnings: [],
  });
  const notOnPath = {
    ...clean,
    toolStatus: { worklog: { ok: true, installedTo: '/home/u/.local/bin', path: { windows: false, onPath: false } } },
    notOnPath: ['worklog'],
  };
  assert.deepEqual(nonInteractiveOutcome(notOnPath, { installTools: true }), {
    code: 0,
    errors: [],
    warnings: [
      'worklog was installed to /home/u/.local/bin, which is not on your PATH, so Claude Code will not find it until you add it in your shell profile (the worklog summary above shows the line), then open a new terminal and restart Claude Code.',
    ],
  });
});
