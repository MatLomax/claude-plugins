---
description: Update the worklog binary to the latest GitHub release
---

Run the bundled updater with the Bash tool:

`bash "${CLAUDE_PLUGIN_ROOT}/scripts/update.sh"`

It detects this machine's platform, compares the installed `worklog` version
against the latest release at MatLomax/worklog, and — when a newer one exists —
downloads the matching asset over HTTPS, verifies its SHA-256 (whenever the
release publishes a digest and a hashing tool is available; otherwise it prints
that verification was skipped and relies on TLS), and atomically replaces the
binary on PATH. It is a safe no-op when already up to date, and it will not
downgrade a newer local or dev build unless you pass `--force`.

To reinstall the latest release even when the versions already match — or to
overwrite a newer local build — pass `--force`:
`bash "${CLAUDE_PLUGIN_ROOT}/scripts/update.sh" --force`.

Then report the outcome to the user: the version change (`old -> new`), or that
it was already current. If the script reports the install target is not writable,
relay its `sudo install …` line to the user verbatim — do not attempt to elevate
privileges yourself. The MCP server picks up the new binary on the next session,
so suggest reloading if they just upgraded.
