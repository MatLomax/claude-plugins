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

- **`hooks/hooks.json`** wires auto-update to session start by running
  `<tool> update --auto` (plus any other hook the tool needs, e.g. worklog's
  `session-start` / `session-end`), every one of them in the guarded shape
  below. The tool's own `--auto` guarantees never-block/never-hang. (A tool's
  `--auto` prints plain text, which SessionStart feeds to the model's context,
  not a user-facing banner — deliberately, so the tool stays Claude-agnostic.)
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

### Hook command shape

Every command hook is a silent no-op (exit 0, no output) when its tool is not
on PATH, and otherwise runs the tool exactly as a bare invocation would: same
argv, stdout passed through (SessionStart stdout becomes model context), exit
code preserved. A bare `<tool> <args>` is not enough: a missing binary makes
every session start with a `command not found` hook error, which users hit
whenever the tool's directory is not on the Claude app's PATH (common with
Claude Desktop on Windows).

Claude Code runs a shell-form command hook (one without `args`) through `sh -c`
on macOS and Linux, Git Bash on Windows, or PowerShell (`pwsh.exe`, falling
back to `powershell.exe` 5.1) on Windows when Git Bash isn't installed. The
plugin cannot know which, and there is no per-OS hook field, so the one command
string must be correct in POSIX sh, bash and PowerShell. It is a sh/PowerShell
polyglot:

```
echo "\" | Out-Null <# " >/dev/null; if command -v <tool> >/dev/null 2>&1; then <tool> <args>; fi; exit $? #> ; if (Get-Command <tool> -CommandType Application -ErrorAction SilentlyContinue) { <tool> <args>; exit $LASTEXITCODE }; exit 0
```

- **sh / bash** read `"\" | Out-Null <# "` as one string (`\"` is an escaped
  quote) and echo it to `/dev/null`, run the `command -v` guard, and `exit $?`
  (the tool's exit code, or 0 when the guard skipped it). `#>` starts a
  comment, so sh never parses the PowerShell half.
- **PowerShell** reads `"\"` as a complete string (backslash is not an escape
  there) piped to `Out-Null`, so `<# ... #>` is a block comment hiding the sh
  half; it then runs its own `Get-Command` guard and exits with
  `$LASTEXITCODE` (without the explicit `exit`, a failing native command
  would surface as exit 1, not its own code).
- Only the lookup is guarded. Never append `|| true` or similar to the whole
  command: that would mask a real failure of a present tool.
- Do not set `args` or `shell` on these hooks. `args` (exec form) spawns the
  tool directly with no shell, so nothing can guard the lookup. `shell` pins
  one shell: `"powershell"` is documented for Windows only, and `"bash"` on
  Windows needs Git Bash, which is optional there.

In `hooks.json` the command is JSON-escaped (`"\"` becomes `\"\\\"`).
`test/hooks.test.mjs` pins every plugin hook to this exact shape and executes
each, with the tool absent and with a stand-in tool present: on Linux/macOS
under sh, bash and (when `pwsh` is available) PowerShell, with a `#!/bin/sh`
stand-in tool; on Windows (the CI Windows job) under Git Bash (when Git for
Windows is installed) with an extensionless `#!/bin/sh` stand-in, and under
PowerShell 7 (when `pwsh.exe` is available) and Windows PowerShell 5.1
(`powershell.exe`) with a `.cmd` stand-in.

### Adding a new tool

1. Give the tool a conforming `update` subcommand (§1) and publish release
   assets named `<tool>-<os>-<arch>[.exe|.zip]` with SHA-256 digests.
2. Add `plugins/<tool>/` with the glue above (§2), its hooks in the guarded
   shape, and list those hooks in `test/hooks.test.mjs`'s `EXPECTED`.
3. Register it in `marketplace.json`, add it to `install.mjs`'s known plugins +
   the offer-to-install list, and add a README row.
