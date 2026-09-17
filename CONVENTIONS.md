# Conventions

This marketplace is thin glue. The tools it wires up (worklog, mdtohtml) own
their real behaviour; a plugin only points Claude Code at a tool that is already
on the user's PATH. This document is the single source of truth for two
conventions every current and future entry follows. It is referenced by the
tool repos, so keep it current.

## 1. Tool self-update contract (Claude-agnostic)

A tool distributed here keeps itself current with a native `update` subcommand
built into the tool itself — not a script shipped in the plugin. The tool owns
*how* to update; the plugin only decides *when* (see §2). This keeps update
logic in one place per tool, cross-platform for free (the binary runs on every
OS), and useful to anyone from a plain shell, with no dependency the tool did
not already have.

A conforming `update` subcommand:

- **Reports a real version.** The running binary must self-report a true version
  so the comparison has something to work with (a build that reports `dev` /
  `(devel)` / empty is treated as a local build and is never auto-updated).
- **`<tool> update`** — check the latest GitHub release; when newer, download
  this platform's release asset, verify its SHA-256 against the GitHub asset
  digest, and **atomically replace the binary in place** (safe while the binary
  is running: on Windows the running file is moved aside and restored, and any
  failed swap keeps the downloaded binary so the install is never left broken).
  Prints `<tool> updated <old> -> <new>` or that it is already current.
- **`<tool> update --check`** — report whether a newer release exists; change
  nothing.
- **`<tool> update --force`** — reinstall the latest even when versions match
  (still verifies the checksum).
- **`<tool> update --auto`** — the background path §2's hook calls. It **must
  never block, hang, or fail the caller** (always exit 0): opt out via
  `<TOOL>_AUTO_UPDATE=0`, TTL-gate the network check, bound it so a stalled DNS
  resolver cannot hang session start, single-flight it, throttle to one attempt
  per release per interval, and run the actual download/replace **detached** in
  the background (the new version is used from the next run). A non-writable
  target prints a manual install command; it never escalates privileges.

Release assets are named `<tool>-<os>-<arch>[.exe|.zip]`. Versions compare
forward-only (never downgrade); a non-numeric field means "not older", so a dev
or pre-release build is never auto-updated.

## 2. Plugin glue convention (Claude-specific)

A plugin here is `plugins/<name>/` containing `.claude-plugin/plugin.json` plus
only the glue a tool needs:

- **`hooks/hooks.json`** wires auto-update to session start with a single
  cross-platform command: `<tool> update --auto`. A bare tool invocation is
  valid in both bash and PowerShell, so no per-OS script or shell dispatch is
  needed. SessionStart can never block a session, so a missing binary is at worst
  a benign notice. The tool's own `--auto` guarantees never-block/never-hang.
  (A tool's `--auto` prints plain text, which SessionStart feeds to the model's
  context, not a user-facing banner — deliberately, so the tool stays
  Claude-agnostic.)
- **`commands/update.md`** exposes `/<name>:update` (a command's slash name is
  its file basename), which runs `<tool> update` for an on-demand upgrade.
- Other glue as the tool needs it: `.mcp.json` (an MCP server), extra
  `commands/`, `skills/<name>/SKILL.md` (a skill).

Provisioning the binary is **not** the plugin's job at runtime. The `npx`
installer (`install.mjs`) offers to install a missing binary by downloading the
tool's latest release asset for the platform and placing it on PATH; after that
the tool's own `update` keeps it current. Each plugin is registered in
`.claude-plugin/marketplace.json` (`defaultEnabled: false`) and listed in the
README.

### Adding a new tool

1. Give the tool a conforming `update` subcommand (§1) and publish release
   assets named `<tool>-<os>-<arch>[.exe|.zip]` with SHA-256 digests.
2. Add `plugins/<tool>/` with the glue above (§2).
3. Register it in `marketplace.json`, add it to `install.mjs`'s known plugins +
   the offer-to-install list, and add a README row.
