# shellcheck shell=bash
# Shared helpers for managing the `worklog` release binary.
# Sourced by update.sh and check-update.sh — not meant to be executed directly.

WORKLOG_REPO="${WORKLOG_REPO:-MatLomax/worklog}"

# Name of the release asset for this host, or empty on an unsupported platform.
# Releases are named worklog-<os>-<arch>[.exe] (e.g. worklog-linux-amd64).
worklog_asset_name() {
  local os arch
  case "$(uname -s)" in
    Linux)                os=linux ;;
    Darwin)               os=darwin ;;
    MINGW*|MSYS*|CYGWIN*) os=windows ;;
    *) return 0 ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64)  arch=amd64 ;;
    arm64|aarch64) arch=arm64 ;;
    *) return 0 ;;
  esac
  local name="worklog-${os}-${arch}"
  [ "$os" = windows ] && name="${name}.exe"
  printf '%s\n' "$name"
}

# Installed worklog version string, e.g. "v0.3.0" (or "dev" for a local build).
# Fails (non-zero) when worklog is not on PATH.
worklog_current_version() {
  command -v worklog >/dev/null 2>&1 || return 1
  worklog version 2>/dev/null | awk '{print $2}'
}

# GET a URL to stdout via curl or wget; 127 if neither is available.
# Honour WORKLOG_HTTP_TIMEOUT (seconds) so callers can keep it snappy.
worklog_http_get() {
  local url="$1" timeout="${WORKLOG_HTTP_TIMEOUT:-10}"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --max-time "$timeout" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- --timeout="$timeout" "$url"
  else
    return 127
  fi
}

# Download a URL to a file via curl or wget; 127 if neither is available.
worklog_http_download() {
  local url="$1" dest="$2" timeout="${WORKLOG_HTTP_TIMEOUT:-120}"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --max-time "$timeout" -o "$dest" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$dest" --timeout="$timeout" "$url"
  else
    return 127
  fi
}

# Latest release tag (e.g. "v0.3.0"), preferring an authenticated `gh` and
# falling back to the public REST API. Empty output means it couldn't be found.
# Set WORKLOG_TAG_HTTP_ONLY=1 to skip `gh` and use only the timeout-bounded HTTP
# path — `gh` honours no per-request deadline, so callers that must stay snappy
# (the session-start check) rely on WORKLOG_HTTP_TIMEOUT via curl/wget instead.
worklog_latest_tag() {
  local tag
  if [ "${WORKLOG_TAG_HTTP_ONLY:-0}" != 1 ] && command -v gh >/dev/null 2>&1; then
    tag="$(gh release view --repo "$WORKLOG_REPO" --json tagName -q .tagName 2>/dev/null)"
    [ -n "$tag" ] && { printf '%s\n' "$tag"; return 0; }
  fi
  tag="$(worklog_http_get "https://api.github.com/repos/${WORKLOG_REPO}/releases/latest" 2>/dev/null \
    | grep -m1 '"tag_name"' \
    | sed -E 's/.*"tag_name" *: *"([^"]+)".*/\1/')"
  [ -n "$tag" ] && printf '%s\n' "$tag"
}

# Names of the assets published on the latest release, one per line (empty when
# it can't be determined). Asset names all start with "worklog-", which lets the
# HTTP fallback extract them from the release JSON without a JSON parser.
worklog_release_assets() {
  if command -v gh >/dev/null 2>&1; then
    local names
    names="$(gh release view --repo "$WORKLOG_REPO" --json assets -q '.assets[].name' 2>/dev/null)"
    [ -n "$names" ] && { printf '%s\n' "$names"; return 0; }
  fi
  worklog_http_get "https://api.github.com/repos/${WORKLOG_REPO}/releases/latest" 2>/dev/null \
    | grep -oE '"worklog-[A-Za-z0-9._-]+"' \
    | tr -d '"' \
    | sort -u
}

# SHA-256 hex digest published for a given asset in the latest release, or
# empty when it cannot be determined reliably (caller decides how to proceed).
worklog_asset_digest() {
  local asset="$1" digest json
  if command -v gh >/dev/null 2>&1; then
    digest="$(gh release view --repo "$WORKLOG_REPO" --json assets \
      -q ".assets[] | select(.name==\"$asset\") | .digest" 2>/dev/null)"
    if [ -n "$digest" ]; then printf '%s\n' "${digest#sha256:}"; return 0; fi
  fi
  json="$(worklog_http_get "https://api.github.com/repos/${WORKLOG_REPO}/releases/latest" 2>/dev/null)" || return 0
  command -v python3 >/dev/null 2>&1 || return 0
  printf '%s' "$json" | python3 -c '
import sys, json
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
name = sys.argv[1]
for a in data.get("assets", []):
    if a.get("name") == name:
        d = a.get("digest") or ""
        print(d[len("sha256:"):] if d.startswith("sha256:") else "")
        break
' "$asset"
}

# SHA-256 of a file, via sha256sum or shasum; 127 if neither is available.
worklog_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    return 127
  fi
}

# Exit 0 iff semantic version A is strictly older than B (leading "v" optional).
# Any non-numeric field (e.g. "dev" or a pre-release) yields "not older", so a
# local/dev build is never nagged into an "update".
worklog_semver_lt() {
  local a="${1#v}" b="${2#v}"
  [ "$a" = "$b" ] && return 1
  local IFS=. i max x y
  # Deliberate split on '.' into dotted version fields; inputs are version
  # strings (digits/dots), never globs.
  # shellcheck disable=SC2206
  local -a A=($a) B=($b)
  max=${#A[@]}
  [ ${#B[@]} -gt "$max" ] && max=${#B[@]}
  for ((i = 0; i < max; i++)); do
    x="${A[i]:-0}"; y="${B[i]:-0}"
    case "$x$y" in *[!0-9]*) return 1 ;; esac
    [ "$x" -lt "$y" ] && return 0
    [ "$x" -gt "$y" ] && return 1
  done
  return 1
}
