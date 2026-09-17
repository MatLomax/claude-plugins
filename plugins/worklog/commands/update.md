---
description: Update the worklog binary to the latest GitHub release
---

Run `worklog update` in a shell using the Bash tool.

It compares the installed `worklog` version against the latest release at
MatLomax/worklog, and when a newer one exists downloads the matching asset over
HTTPS, verifies its SHA-256, and atomically replaces the binary on PATH. It is a
safe no-op when already up to date and will not downgrade a newer local or dev
build; pass `worklog update --force` to reinstall the latest anyway, or
`worklog update --check` to only report whether a newer release exists.

Then report the outcome to the user: the version change (`old -> new`), or that
it was already current. If it reports the install target is not writable, relay
its `sudo install …` line to the user verbatim — do not attempt to elevate
privileges yourself. The MCP server picks up the new binary on the next session,
so suggest reloading if they just upgraded.
