#!/usr/bin/env bash
# Update the `worklog` binary on PATH to the latest GitHub release.
#
# Detects this host's platform, compares the installed version against the
# latest release at $WORKLOG_REPO, and — when a newer one exists — downloads the
# matching asset, verifies its SHA-256, and atomically replaces the binary.
# A safe no-op when already current. Pass --force to reinstall regardless.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"

force=0
case "${1:-}" in
  --force) force=1 ;;
  "")      ;;
  *) echo "usage: update.sh [--force]" >&2; exit 2 ;;
esac

asset="$(worklog_asset_name)"
if [ -z "$asset" ]; then
  echo "worklog: no prebuilt release binary for $(uname -s)/$(uname -m)." >&2
  echo "Build from source instead: go install github.com/${WORKLOG_REPO}/cmd/worklog@latest" >&2
  exit 1
fi

current="$(worklog_current_version 2>/dev/null || true)"

tag="$(worklog_latest_tag)"
if [ -z "$tag" ]; then
  echo "worklog: could not determine the latest release (no gh/curl/wget, or offline)." >&2
  exit 1
fi

if [ "$force" -ne 1 ] && [ -n "$current" ]; then
  if [ "${current#v}" = "${tag#v}" ]; then
    echo "worklog is already up to date ($current)."
    exit 0
  fi
  # Only move forward automatically. A newer local/dev build (or a version that
  # doesn't compare as a release, e.g. "dev") is left untouched unless forced,
  # so /worklog:update never silently downgrades.
  if ! worklog_semver_lt "$current" "$tag"; then
    echo "Installed worklog ($current) is not older than the latest release ($tag); leaving it untouched."
    echo "Pass --force to install $tag anyway."
    exit 0
  fi
fi

# Confirm this platform's asset is actually published before downloading, so an
# unsupported-but-mapped host (e.g. an Intel Mac, or linux/arm64) gets the clear
# "build from source" message rather than a confusing 404. Skip the guard only
# when the asset list can't be fetched (network) — the download will error then.
assets="$(worklog_release_assets 2>/dev/null || true)"
if [ -n "$assets" ] && ! printf '%s\n' "$assets" | grep -Fxq "$asset"; then
  echo "worklog: the latest release ($tag) has no asset for $(uname -s)/$(uname -m) (expected $asset)." >&2
  echo "Build from source instead: go install github.com/${WORKLOG_REPO}/cmd/worklog@latest" >&2
  exit 1
fi

# Resolve the install target: the binary on PATH (symlinks followed), else a
# sensible default for a fresh install.
if command -v worklog >/dev/null 2>&1; then
  target="$(command -v worklog)"
  if command -v readlink >/dev/null 2>&1; then
    resolved="$(readlink -f "$target" 2>/dev/null || true)"
    [ -n "$resolved" ] && target="$resolved"
  fi
else
  target="${WORKLOG_INSTALL_DIR:-$HOME/.local/bin}/worklog"
  echo "worklog is not currently on PATH; installing to $target."
fi
targetdir="$(dirname "$target")"
mkdir -p "$targetdir" 2>/dev/null || true

url="https://github.com/${WORKLOG_REPO}/releases/download/${tag}/${asset}"

# Download into a temp file, verify, then move into place. Keep the temp file
# on the target filesystem when we can write there, so the final mv is atomic.
cleanup() { [ -n "${tmp:-}" ] && rm -f "$tmp" 2>/dev/null; return 0; }
trap cleanup EXIT

writable=0
[ -w "$targetdir" ] && writable=1

if [ "$writable" -eq 1 ]; then
  tmp="$(mktemp "$targetdir/.worklog.XXXXXX")"
else
  tmp="$(mktemp "${TMPDIR:-/tmp}/worklog.XXXXXX")"
fi

echo "Downloading $asset $tag ..."
if ! worklog_http_download "$url" "$tmp"; then
  echo "worklog: download failed: $url" >&2
  exit 1
fi

digest="$(worklog_asset_digest "$asset" 2>/dev/null || true)"
if [ -n "$digest" ]; then
  actual="$(worklog_sha256 "$tmp" 2>/dev/null || true)"
  if [ -z "$actual" ]; then
    echo "worklog: no sha256 tool found; skipped checksum verification." >&2
  elif [ "$actual" != "$digest" ]; then
    echo "worklog: CHECKSUM MISMATCH for $asset $tag" >&2
    echo "  expected $digest" >&2
    echo "  got      $actual" >&2
    exit 1
  fi
else
  echo "worklog: release digest unavailable; skipped checksum verification (download was over HTTPS)." >&2
fi

chmod 0755 "$tmp"

if [ "$writable" -eq 1 ]; then
  mv -f "$tmp" "$target"
  tmp=""  # consumed; don't let the trap remove the installed binary
  new="$(worklog_current_version 2>/dev/null || echo "$tag")"
  echo "Updated worklog: ${current:-none} -> ${new}"
else
  # Not writable — do not escalate privileges automatically. Hand back the
  # verified download and the exact command to finish the install.
  echo "worklog: $target is not writable by you." >&2
  echo "Downloaded and verified $tag at: $tmp" >&2
  echo "Finish the install with:" >&2
  echo "  sudo install -m 0755 $tmp $target" >&2
  tmp=""  # leave the verified file in place for the manual step
  exit 1
fi
