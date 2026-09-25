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
the repo's task log is live rather than inert. It needs a terminal (it is
interactive) and, at the end, reports what it verified. Then reload Claude Code
and accept the "trust this folder" dialog.

Flags: `--insecure` (skip TLS certificate verification for the installer's
own downloads — see [troubleshooting](#behind-a-corporate-proxy-or-https-scanning-antivirus)
below), `--no-self-update` (skip the check for a newer release and run this
version as is — an escape hatch if a release is broken, or a way to run an
older version from its versioned URL), `--help`, `--version`.

## Manual setup

Prefer to wire it by hand?

```bash
# once per machine — registers the catalogue, enables nothing
/plugin marketplace add MatLomax/claude-plugins

# in a project that wants a skill — writes .claude/settings.json (committed)
/plugin install image-to-html@matlomax --scope project
#   …or --scope local to keep it out of git
```

Update later with `/plugin marketplace update matlomax`.

## Troubleshooting

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
lib/                                 # installer modules: args, net, tls, selfupdate
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
