---
description: Update the mdtohtml binary in place to the latest GitHub release
---

Run `mdtohtml update` in a shell using the Bash tool.

It checks the latest release at MatLomax/mdtohtml, and when a newer one exists
downloads this platform's release zip, verifies its SHA-256, and atomically
replaces the binary and its `themes/` folder in place. It is a safe no-op when
already current; pass `mdtohtml update --force` to reinstall the latest anyway,
or `mdtohtml update --check` to only report whether a newer release exists.

Then report the outcome to the user: the version change (`old -> new`), or that
it was already current. If it reports the install location is not writable,
relay its manual instruction verbatim — do not attempt to elevate privileges. A
release-binary install updates in place; a pipx/pip install is upgraded with
pipx/pip instead.
