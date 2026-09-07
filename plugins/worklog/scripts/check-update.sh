#!/usr/bin/env bash
# SessionStart hook: keep the `worklog` binary current.
#
# When a newer release exists, auto-update in the background by default; set
# WORKLOG_AUTO_UPDATE=0 (or false/no/off) to opt out and only be notified.
#
# Never blocks or fails the session: the network check is cached to at most once
# per WORKLOG_UPDATE_CHECK_TTL seconds with a short timeout, the install runs
# detached in the background, and every failure path exits 0 silently.
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

# Already current, or a local/dev build that doesn't compare as older: nothing to do.
worklog_semver_lt "$current" "$latest" || exit 0

# Opt out of auto-install: notify only, and point at the manual command.
if worklog_auto_update_disabled; then
  echo "worklog: a newer release is available (${current} -> ${latest}). Run /worklog:update to upgrade."
  exit 0
fi

# Auto-install path. Only when the binary can actually be replaced in place;
# otherwise fall back to the notice with the manual (sudo) route update.sh prints.
target="$(command -v worklog)"
if command -v readlink >/dev/null 2>&1; then
  resolved="$(readlink -f "$target" 2>/dev/null || true)"
  [ -n "$resolved" ] && target="$resolved"
fi
if [ ! -w "$(dirname "$target")" ]; then
  echo "worklog: a newer release is available (${current} -> ${latest}), but $target is not writable. Run /worklog:update for the sudo install command."
  exit 0
fi

# Single-flight: one background install at a time, shared across concurrent
# session starts. Reclaim a lock left behind by a crashed run (older than an
# hour) so a stale lock can never disable auto-update permanently.
lock="$cache_dir/auto-update.lock"
mkdir -p "$cache_dir" 2>/dev/null || true
if ! mkdir "$lock" 2>/dev/null; then
  # Lock held. Reclaim it only when stale (a crashed prior run), and do so
  # atomically: renaming the lock aside is a single rename() that exactly one
  # racer can win, so two simultaneous session starts can't both steal it and
  # launch duplicate installs.
  lock_mtime="$(stat -c %Y "$lock" 2>/dev/null || stat -f %m "$lock" 2>/dev/null || echo "$now")"
  if [ "$((now - lock_mtime))" -lt 3600 ]; then
    exit 0  # fresh lock: another session is already updating
  fi
  if ! mv "$lock" "$lock.stale.$$" 2>/dev/null; then
    exit 0  # another session won the steal
  fi
  rmdir "$lock.stale.$$" 2>/dev/null || true
  mkdir "$lock" 2>/dev/null || exit 0  # lost the re-acquire; let them run
fi

echo "worklog: auto-updating ${current} -> ${latest} in the background; the new version is used from your next session (set WORKLOG_AUTO_UPDATE=0 to disable)."

# Detach fully so session start is never delayed; release the lock when done.
log="$cache_dir/auto-update.log"
# shellcheck disable=SC2016  # $1/$2/$3 are expanded by the CHILD bash, by design
nohup bash -c '"$1/update.sh" >"$2" 2>&1; rmdir "$3" 2>/dev/null || true' \
  _ "$here" "$log" "$lock" >/dev/null 2>&1 &
disown 2>/dev/null || true
exit 0
