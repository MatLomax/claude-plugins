// The marketplace's catalogue as the installer sees it: which plugins exist,
// in the order they are offered, and which are backed by a release binary.

export const MARKETPLACE_ID = 'matlomax';
export const REPO = 'MatLomax/claude-plugins';

// Every plugin the installer manages, in canonical (menu) order.
export const PLUGINS = [
  { id: 'worklog', hint: 'Per-project SQLite task & decision log (release binary, checked below)' },
  { id: 'mdtohtml', hint: 'Convert extended Markdown to self-contained HTML (release binary, checked below)' },
  { id: 'image-to-html', hint: 'Reconstruct HTML from a mockup and gate the render against it' },
];

export const PLUGIN_IDS = PLUGINS.map((p) => p.id);

// The order newly enabled plugins are added to `enabledPlugins` in
// .claude/settings.json. It is the order earlier installer releases wrote, so
// a re-run produces the same file; it differs from the menu order on purpose.
export const SETTINGS_ORDER = ['worklog', 'image-to-html', 'mdtohtml'];

// Plugins backed by a release CLI binary the installer can provision. Asset
// naming and layout differ per tool, so each carries its own mapping.
export const TOOLS = {
  worklog: {
    repo: 'MatLomax/worklog',
    bin: 'worklog',
    versionArgs: ['version'],
    kind: 'binary', // a bare executable
    osMap: { linux: 'linux', darwin: 'darwin', win32: 'windows' },
    archMap: { x64: 'amd64', arm64: 'arm64' },
    releases: 'https://github.com/MatLomax/worklog/releases',
  },
  mdtohtml: {
    repo: 'MatLomax/mdtohtml',
    bin: 'mdtohtml',
    versionArgs: ['--version'],
    kind: 'zip', // a zip of the binary + a themes/ folder
    osMap: { linux: 'linux', win32: 'windows' }, // no macOS release published
    archMap: { x64: 'x86_64' },
    releases: 'https://github.com/MatLomax/mdtohtml/releases',
  },
};
