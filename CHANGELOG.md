# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
