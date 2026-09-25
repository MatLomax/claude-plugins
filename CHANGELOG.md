# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.1] - 2026-09-25

### Added

- Non-interactive mode: `--plugins=<name>[,<name>...]` (repeatable) selects plugins without
  prompting and makes the run non-interactive — no prompts, no terminal required, so it works in
  scripts and CI. Valid names: `worklog`, `mdtohtml`, `image-to-html`. Listed plugins are enabled
  in `.claude/settings.json` (and the marketplace registered); plugins not listed are left as
  they are — it only adds, never disables, unlike the interactive picker. At least one name is
  required; an unknown name is an error (exit 2).
- `--install-tools` downloads and installs the latest release for any listed binary-backed plugin
  (`worklog`, `mdtohtml`) whose binary isn't on PATH, the same as answering yes in the
  interactive prompt (SHA-256 checked when the release publishes a checksum; on Windows the
  install dir is added to the user PATH, on macOS and Linux the binary goes to `~/.local/bin`
  and the summary warns if that is not on PATH); without it a missing binary is only
  reported. With `worklog` listed and its binary usable, `worklog init` runs automatically in the
  current repo; `--no-worklog-init` skips it. Both flags require `--plugins`, otherwise it's a
  usage error (exit 2).
- Exit code 1 if a listed binary-backed plugin ends up without a usable binary, or if
  `worklog init` ran and failed (settings are still written in both cases, with the reason on
  stderr); 0 otherwise. `--help`, `-h` and `--version` print and exit 0 whatever else is on the
  command line, even an invalid `--plugins` list or a flag that does not parse (a flag's value,
  as in `--plugins=--help`, is not the flag).
- The end of every run (interactive and `--plugins`) lists, for each plugin picked in that run,
  the terminal command `claude plugin install <name>@matlomax --scope project` (after a
  `claude plugin marketplace add MatLomax/claude-plugins` line) and the Claude
  Desktop route (Code tab, + > Plugins > Add plugin > the plugin > this project). The plugins already load from
  `.claude/settings.json`, but without an explicit install Claude's plugin list shows none
  installed.
- When a binary was installed, the run ends with a reminder to restart Claude Code / Claude
  Desktop and any open terminals so they pick it up. Tools a restart cannot help are left out of
  it: on Windows those whose directory could not be added to the user PATH, on macOS and Linux
  those installed into a directory that is not on PATH; with none left, there is no reminder.
- Non-interactive mode exits 1 when a binary was installed on Windows but its directory could not
  be added to the user PATH, since Claude Code would not find it; stderr names the tool, the
  directory and the reason. On macOS and Linux a binary installed into a `~/.local/bin` that is
  not on PATH still exits 0 (the install succeeded; adding the directory to PATH is a shell-profile
  step left to the user) but prints a warning on stderr naming the tool and the directory, so CI
  logs show it.

### Changed

- A `.claude/settings.json` that is valid JSON but not a JSON object (an array, `null`, a
  number, a string, a boolean), or whose `enabledPlugins`, `extraKnownMarketplaces` or
  `extraKnownMarketplaces.matlomax` is present but not a JSON object, is now an error (exit 1)
  and is left untouched, like invalid JSON already was. All of these are checked before any
  binary is downloaded or `worklog init` runs; interactively, before the plugin picker.
- When a relaunched newer installer exits non-zero, the message now says it exited with that
  code (its own output is above) and offers the manual `npx` command only for the case where it
  never started because npm could not download it.

### Fixed

- Windows: adding an installed binary's directory to the user PATH now checks that it worked (the
  PowerShell result, and the registry value read back), broadcasts the change
  (`WM_SETTINGCHANGE`) so Claude Desktop and other programs started afresh from Explorer see it
  without signing out, and reports the outcome: added (then fully quit Claude Desktop from the
  system tray and reopen it and any terminals/IDEs), already there, or failed with the reason and
  how to add it by hand. An existing entry that differs only by a trailing backslash or a %VAR%
  spelling counts as present, so it is not added twice. It no longer always prints the wrong "not
  on your PATH yet. Add it" line. Paths containing typographic apostrophes (such as `O’Brien`) are
  quoted correctly for PowerShell, including when unpacking the mdtohtml zip.
- A freshly installed binary is reported as `[ok] <tool> installed (<version>)` rather than "on
  PATH", which was only true inside the installer's own process; a binary found already
  installed is still reported as on PATH.
- macOS and Linux: when `~/.local/bin` is not on PATH, the summary names the exact
  `export PATH="$HOME/.local/bin:$PATH"` line for the shell profile. Whether it is on PATH is
  measured against the PATH the installer started with, so installing a second tool into the
  same directory no longer hides the warning, and a PATH entry with a trailing `/` counts.
- Windows: the Windows PowerShell 5.1 steps the installer runs (unpacking the mdtohtml zip,
  updating the user PATH and broadcasting the change) start without `PSModulePath`, so when the
  installer is launched from PowerShell 7 they use 5.1's own module path instead of inheriting
  7's, which Microsoft documents can make 5.1 load the wrong modules.
- The worklog and mdtohtml plugins' session hooks no longer error when their binary is not on
  PATH: they do nothing. With the binary on PATH they run it as before and pass its exit code
  through.

## [1.0.0] - 2026-09-25

### Added

- The installer ships as a prebuilt, dependency-free tarball attached to
  GitHub releases. `npx https://matlomax.com/claude-plugins.tgz` installs it
  without ever touching the npm registry (`matlomax.com` 302-redirects to the
  tarball on the latest GitHub release).
- Self-update: on start, the installer checks the latest GitHub release and,
  if a newer one exists, relaunches itself via
  `npx -y https://github.com/MatLomax/claude-plugins/releases/download/v<version>/claude-plugins-<version>.tgz`
  with the same arguments. If it cannot relaunch itself it prints that
  command and stops.
- `--no-self-update` skips the check for a newer release and runs the
  current version as is: an escape hatch if a release is broken, and a way
  to run an older version from its versioned release URL.
- `--insecure` skips TLS certificate verification for the installer's own
  downloads, for use behind a corporate proxy or HTTPS-scanning antivirus
  that re-signs traffic with an untrusted root. Prints a warning; the
  SHA-256 checksum check is meaningless in this mode, since the checksum
  itself arrives over the same unverified connection. npm downloads the
  installer tarball itself before the installer runs, so behind a full
  interceptor the one-off form is
  `npx --strict-ssl=false https://matlomax.com/claude-plugins.tgz --insecure`.
- `--help` and `--version` flags.
- A hint printed when a download fails with a certificate-chain error
  (`SELF_SIGNED_CERT_IN_CHAIN` / `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`),
  explaining that the network is intercepting HTTPS and giving the two ways
  out: trust the interceptor's root certificate via `NODE_EXTRA_CA_CERTS`,
  or re-run the same `npx` command (whichever URL and flags it used) with
  `--strict-ssl=false` before the URL and `--insecure` after it, e.g.
  `npx --strict-ssl=false https://matlomax.com/claude-plugins.tgz --insecure`.

### Changed

- `@clack/prompts` is pinned to exactly `1.7.0` (was a caret range), so the
  bundled release tarball is reproducible.
- The installer requires Node 20.12 or newer (`@clack/prompts` 1.7.0 already
  did; `engines` now says so).

[Unreleased]: https://github.com/MatLomax/claude-plugins/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/MatLomax/claude-plugins/releases/tag/v1.0.1
[1.0.0]: https://github.com/MatLomax/claude-plugins/releases/tag/v1.0.0
