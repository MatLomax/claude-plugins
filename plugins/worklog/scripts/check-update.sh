#!/usr/bin/env bash
# SessionStart hook: quietly note when a newer `worklog` release is available.
#
# Never blocks or fails the session — every failure path exits 0 silently. The
# result is cached so it hits the network at most once per WORKLOG_UPDATE_CHECK_TTL
# seconds, with a short timeout so session start is never delayed.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh" 2>/dev/null || exit 0

command -v worklog >/dev/null 2>&1 || exit 0
current="$(worklog_current_version 2>/dev/null || true)"
[ -n "$current" ] || exit 0

cache_dir="${XDG_CACHE_HOME:-${HOME:-/tmp}/.cache}/worklog"
cache="$cache_dir/update-check"
ttl="${WORKLOG_UPDATE_CHECK_TTL:-86400}"
now="$(date +%s 2>/dev/null || echo 0)"

latest=""
if [ -f "$cache" ]; then
  read -r ts cached_tag < "$cache" 2>/dev/null || true
  if [ -n "${ts:-}" ] && [ "${ts}" -eq "${ts}" ] 2>/dev/null \
     && [ "$((now - ts))" -lt "$ttl" ]; then
    latest="${cached_tag:-}"
  fi
fi

if [ -z "$latest" ]; then
  # HTTP-only + a hard 3s timeout: `gh` honours no per-request deadline, so
  # skip it here to guarantee session start is never delayed by a network stall.
  latest="$(WORKLOG_TAG_HTTP_ONLY=1 WORKLOG_HTTP_TIMEOUT=3 worklog_latest_tag 2>/dev/null || true)"
  [ -n "$latest" ] || exit 0  # offline / unreachable: stay silent
  mkdir -p "$cache_dir" 2>/dev/null || true
  printf '%s %s\n' "$now" "$latest" > "$cache" 2>/dev/null || true
fi

if worklog_semver_lt "$current" "$latest"; then
  echo "worklog: a newer release is available (${current} -> ${latest}). Run /worklog:update to upgrade."
fi
exit 0
