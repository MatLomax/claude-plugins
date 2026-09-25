# claude-plugins

A private Claude Code plugin marketplace — a single central registry so skills
don't have to be duplicated and fragmented across projects. Registering the
marketplace enables **nothing**; every plugin is `defaultEnabled: false` and is
opted into **per project**.

## Install

From the **root of the repo you want to enable plugins in**, run:

```bash
npx https://matlomax.com/claude-plugins.tgz
```

This installs from a prebuilt, dependency-free tarball attached to the latest
GitHub release (`matlomax.com` 302-redirects to it) — installing never touches
the npm registry. On start the installer checks whether a newer release
exists and, if so, relaunches itself at that version automatically, so you
always run current code without re-typing the command.

`npx github:MatLomax/claude-plugins` still works: it runs from `main` and
pulls `@clack/prompts` from the npm registry instead.

The interactive installer lets you tick which plugins to enable (all off by
default), then **deep-merges** `.claude/settings.json` in that repo — registering
the marketplace and enabling exactly what you picked, never clobbering existing
settings, safe to re-run. When you enable a binary-backed plugin (`worklog`,
`mdtohtml`) it checks the binary is on PATH and, if missing, offers to **download
and install the latest release** for your platform (SHA-256 verified) — no
language toolchain needed. For `worklog` it also offers to run `worklog init` so
the repo's task log is live rather than inert. It is interactive by default and
then needs a terminal; with `--plugins` it runs without prompts or a terminal
(see [Non-interactive](#non-interactive)). At the end it reports what it
verified, then prints the `claude plugin install` commands for the plugins you
picked (see [below](#the-plugin-list-says-no-plugins-are-installed)). Then
reload Claude Code and accept the "trust this folder" dialog.

An installed binary lands in `~/.local/bin` on macOS and Linux (on Linux,
`mdtohtml` is unpacked to `~/.local/share/mdtohtml` and symlinked there; it has
no macOS release). The installer does not edit shell profiles: if that
directory is not on your PATH, the summary says so and shows the
`export PATH="$HOME/.local/bin:$PATH"` line to add to your shell profile. On
Windows it goes to `%LOCALAPPDATA%\Programs\<tool>`, which is appended to your
user PATH in the registry (keeping it a `REG_EXPAND_SZ` value, so `%VAR%`
entries survive), read back to confirm, and announced to running programs with
the same `WM_SETTINGCHANGE` broadcast `setx` sends. The summary reports whether
the directory was added, was already there, or could not be added (with the
reason and how to add it by hand). Programs that are already open keep their
old PATH: **fully quit Claude Desktop (from the system tray, not just its
window) and close any open terminals and IDEs, then reopen them.** Whenever a
binary was just installed, on any OS, the installer ends with a reminder to
restart Claude Code / Claude Desktop and open terminals.

If `.claude/settings.json` exists but is not valid JSON, is not a JSON object,
or has an `enabledPlugins`, `extraKnownMarketplaces` or
`extraKnownMarketplaces.matlomax` entry that is not a JSON object, the installer
stops (exit 1) before prompting or installing anything and leaves the file as it
is.

Flags:

- `--plugins=<name>[,<name>...]` — non-interactive mode; see [below](#non-interactive).
- `--install-tools` — auto-install missing plugin binaries in non-interactive mode (requires
  `--plugins`).
- `--no-worklog-init` — skip the automatic `worklog init` in non-interactive mode (requires
  `--plugins`).
- `--insecure` — skip TLS certificate verification for the installer's own downloads (see
  [troubleshooting](#behind-a-corporate-proxy-or-https-scanning-antivirus) below).
- `--no-self-update` — skip the check for a newer release and run this version as is (an escape
  hatch if a release is broken, or a way to run an older version from its versioned URL).
- `--help` (`-h`), `--version` — print and exit 0, whatever else is on the command line.

### Non-interactive

For scripts and CI, skip the picker entirely:

```bash
npx https://matlomax.com/claude-plugins.tgz --plugins=worklog,mdtohtml --install-tools
```

`--plugins=<name>[,<name>...]` (may also be repeated) selects plugins without prompting and makes
the run non-interactive — no prompts, no terminal required. Valid names: `worklog`, `mdtohtml`,
`image-to-html`. Listed plugins are enabled in `.claude/settings.json` (and the marketplace
registered); plugins you don't list are left as they are — non-interactive mode only adds, it
never disables (unlike the interactive picker, which also turns off unticked plugins). At least
one name is required; an unknown name is an error (exit 2).

`--install-tools` downloads and installs the latest release for any listed binary-backed plugin
(`worklog`, `mdtohtml`) whose binary isn't on PATH — the same as answering yes in the interactive
prompt (SHA-256 verified when the release publishes a checksum; installed where described
[above](#install)). Without it, a missing binary is only reported. When
`worklog` is listed and its binary ends up usable, `worklog init` runs automatically in the
current repo; `--no-worklog-init` skips that. `--install-tools` and `--no-worklog-init` only work
alongside `--plugins` — used without it, they're a usage error (exit 2).

Exit code is 1 if a listed binary-backed plugin ends up without a usable binary, if (on Windows)
a binary was installed but its directory could not be added to the user PATH (Claude Code would
not find it), or if `worklog init` ran and failed (settings are still written in every case, and
the reason is printed on stderr); 0 otherwise. Usage errors exit 2. Combines with `--insecure` and
`--no-self-update`.

The two PATH outcomes differ on purpose. On Windows the installer adds the install directory to
the user PATH itself, so a failed write is an error: exit 1. On macOS and Linux it only installs
into `~/.local/bin` and leaves shell profiles to you, so a `~/.local/bin` that is not on PATH is
not a failure: the run exits 0 and prints a warning on stderr (so CI logs show it) naming the tool
and the directory to add. On a CI runner, put `~/.local/bin` on PATH for later steps (on GitHub
Actions, `echo "$HOME/.local/bin" >> "$GITHUB_PATH"`).

## Manual setup

Prefer to wire it by hand?

```bash
# once per machine, inside Claude Code — registers the catalogue, enables nothing
/plugin marketplace add MatLomax/claude-plugins

# in a project that wants a skill, from a terminal in that repo — writes
# .claude/settings.json (committed)
claude plugin install image-to-html@matlomax --scope project
#   …or --scope local to keep it out of git
```

Update later with `/plugin marketplace update matlomax`.

## Troubleshooting

### The plugin list says no plugins are installed

Claude Desktop's plugin list (and `claude plugin list`) can say "no plugin
installed for this project" even though `.claude/settings.json` enables the
plugins. This marketplace's plugins are relative-path plugins: Claude loads
them straight from the marketplace because they are enabled in settings, with
no install record, and the plugin list only shows plugins that have one. An
explicit project-scope install creates the record, so the installer ends by
printing the marketplace registration plus one install line per plugin picked
in that run:

```bash
claude plugin marketplace add MatLomax/claude-plugins
claude plugin install <name>@matlomax --scope project
```

Run those in a terminal in the repo. (It is the `claude` shell command, not the
in-session `/plugin install`, which takes no `--scope` flag.) The
`marketplace add` line registers the marketplace with your Claude Code, which
the install needs; repeating it is harmless. In Claude Desktop, use the Code tab: **+ > Plugins > Add
plugin**, choose the plugin, then **this project**.

### A plugin's binary is "not found" after installing it

A binary installed by the installer is on the PATH of new programs only. On
Windows, fully quit Claude Desktop from the system tray and close every
terminal and IDE, then reopen them; if they still can't find it, sign out of
Windows and back in. If the summary said the directory could not be added to
your user PATH, add it by hand: Start > "Edit environment variables for your
account" > `Path` > New. On macOS and Linux, add `~/.local/bin` to PATH in your
shell profile and open a new terminal.

### Behind a corporate proxy or HTTPS-scanning antivirus

If the installer fails with `SELF_SIGNED_CERT_IN_CHAIN` or
`UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, something between you and GitHub is
re-signing HTTPS traffic with its own root certificate — a corporate proxy or
an antivirus product doing TLS inspection. Node ships its own CA bundle and
doesn't consult the OS certificate store, so even though your browser (which
does use the OS store) trusts the connection fine, Node doesn't.

**Proper fix** — tell Node to trust that root certificate:

1. Export the interceptor's root certificate. On Windows: `certmgr.msc` ->
   **Trusted Root Certification Authorities** -> find the proxy/AV's
   certificate -> right-click -> **All Tasks -> Export** -> Base-64 encoded
   X.509 (`.CER`).
2. Point Node at it:
   - Windows: `setx NODE_EXTRA_CA_CERTS "C:\path\root.cer"`
   - macOS/Linux: `export NODE_EXTRA_CA_CERTS=/path/root.cer` (add it to your
     shell profile to make it stick)
3. Open a **new** terminal (environment variable changes don't reach already-open
   shells) and re-run the install command.

**Quick one-off** — if you just need to get unblocked right now:

```bash
npx --strict-ssl=false https://matlomax.com/claude-plugins.tgz --insecure
```

`--strict-ssl=false` (before the URL) is npm's flag: npm downloads the
installer tarball itself, before the installer runs, so it needs its own
certificate checks turned off. `--insecure` (after the URL) is the
installer's flag: it skips certificate checks on the installer's own
downloads (the release check and the plugin binaries). Together they work
around the interception but mean any download during that run could be
tampered with in flight without detection — use the proper fix above when
you can. The same two flags go on whichever install URL you used (the GitHub
one below, or a pinned versioned one), alongside any other flags such as
`--no-self-update`.

**If `matlomax.com` itself is blocked**, install straight from GitHub:

```bash
npx https://github.com/MatLomax/claude-plugins/releases/latest/download/claude-plugins.tgz
```

(Behind an intercepting proxy, add the same two flags as above:
`npx --strict-ssl=false <that URL> --insecure`.)

**If the marketplace registration later fails to clone on Windows**, git is
hitting the same interception through its own TLS stack; make git use the
Windows certificate store instead:

```bash
git config --global http.sslBackend schannel
```

## Plugins

| Plugin | What it does |
|---|---|
| `image-to-html` | Reconstruct HTML from a mockup image and objectively gate the render against it — per-region SSIM, edge-XOR border detection, colour/tint sweeps, glyph measurement. Explicit-invoke only. |
| `worklog` | Per-project, SQLite-backed task & decision log for coding agents, remembered across sessions — task tree with blocking, GitHub-issue links, first-class decisions, and a per-session journal, over MCP. Run `/worklog:init` per project; `/worklog:update` (or the session-start auto-update) keeps the binary current. **Requires the [`worklog`](https://github.com/MatLomax/worklog) binary on PATH.** |
| `mdtohtml` | Convert extended Markdown to styled, self-contained HTML (themes, callouts, wikilinks, chips, KaTeX math, pre-rendered mermaid diagrams, a report hero). A skill teaches an agent the CLI; `/mdtohtml:update` (or the session-start auto-update) keeps the binary current. **Requires the [`mdtohtml`](https://github.com/MatLomax/mdtohtml) binary on PATH.** |

## Layout

```
install.mjs · package.json           # the `npx` interactive installer (repo root)
lib/                                 # installer modules: args, flow, net, place, plugins, selfupdate, tls, userpath
scripts/build.mjs                    # bundles install.mjs + deps into dist/ (npm run build)
scripts/check-tag.mjs                # fails a release whose tag differs from package.json
scripts/changelog-notes.mjs          # extracts a version's CHANGELOG section as release notes
test/                                # installer tests (npm test)
.github/workflows/test.yml           # runs the tests on push and pull request
.github/workflows/release.yml        # builds + publishes the release tarballs on a tag push
CHANGELOG.md                         # Keep a Changelog log for the installer
CLAUDE.md                            # repo process notes for agents working here
.claude-plugin/marketplace.json      # the catalogue
plugins/<name>/
├── .claude-plugin/plugin.json       # plugin manifest
└── one or more of:
    ├── skills/<name>/SKILL.md        # a skill + its scripts/ and assets/
    ├── .mcp.json                     # an MCP server
    ├── hooks/hooks.json              # SessionStart/Stop/… hooks
    └── commands/<name>.md            # a /plugin:command
```

Add a new plugin by dropping another `plugins/<name>/` and listing it in
`marketplace.json`. `worklog` is the MCP+hooks+command shape, `mdtohtml` is the
skill+hook+command shape, and `image-to-html` is the plain skill shape. See
[`CONVENTIONS.md`](CONVENTIONS.md) for the shared self-update contract every
binary-backed tool follows and how its plugin wires it up.

## Releasing

Maintainers only.

1. `npm test` — must pass.
2. Bump `version` in `package.json`.
3. In `CHANGELOG.md`, move the `[Unreleased]` entries under a new
   `## [X.Y.Z] - YYYY-MM-DD` heading, and leave `## [Unreleased]` empty above it.
4. Commit.
5. `git tag vX.Y.Z && git push origin vX.Y.Z`.

Pushing the tag triggers `.github/workflows/release.yml`, which checks the
tag matches `package.json`, runs the tests, builds with `npm run build`
(esbuild bundles `install.mjs` and `@clack/prompts` into `dist/`, dependency-free),
and uploads `claude-plugins-X.Y.Z.tgz` and `claude-plugins.tgz` to the GitHub
release, using that version's CHANGELOG section as the release notes.

`npm run build` produces the same tarballs locally — useful for testing a
release before tagging it:

```bash
npm run build
npx file:./dist/claude-plugins-X.Y.Z.tgz
```

### One-time Cloudflare setup (zone `matlomax.com`)

`https://matlomax.com/claude-plugins.tgz` is a DNS record + redirect rule on
the `matlomax.com` Cloudflare zone, set up once:

- A proxied `AAAA` record for the apex (`matlomax.com`) pointing at `100::`
  (a placeholder — Cloudflare proxies the request before that address is ever
  dialled).
- One **Single Redirect** rule: when *URI Full* **equals**
  `https://matlomax.com/claude-plugins.tgz`, redirect to the static URL
  `https://github.com/MatLomax/claude-plugins/releases/latest/download/claude-plugins.tgz`,
  **302**, **query string not preserved**.

Self-update relaunches at the versioned asset on the GitHub release
(`https://github.com/MatLomax/claude-plugins/releases/download/vX.Y.Z/claude-plugins-X.Y.Z.tgz`)
directly, so no versioned `matlomax.com` URL exists.
