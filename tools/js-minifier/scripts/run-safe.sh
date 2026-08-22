#!/usr/bin/env bash
set -euo pipefail

root=$(cd -- "$(dirname -- "$0")/.." && pwd)
safe=/home/paulkinlan/journal/scripts/safe-build-env.sh
scanner=/home/paulkinlan/journal/scripts/check-build-log-secrets.py

[[ $# -ge 2 ]] || { echo "usage: $0 LOG-NAME command [args...]" >&2; exit 64; }
name=$1
shift
[[ $name =~ ^[A-Za-z0-9._-]+$ ]] || { echo "invalid log name" >&2; exit 64; }
mkdir -p "$root/logs"
log="$root/logs/$name.log"
scan="$root/logs/$name.scan.log"
[[ ! -e $log && ! -L $log && ! -e $scan && ! -L $scan ]] || {
  echo "refusing to overwrite log" >&2
  exit 73
}

set +e
"$safe" --artifact-dir "$root" -- "$@" >"$log" 2>&1
status=$?
set -e

set +e
"$safe" --artifact-dir "$root/logs" -- /usr/bin/python3 -S "$scanner" "$log" >"$scan" 2>&1
scan_status=$?
set -e
if [[ $scan_status -ne 0 ]]; then
  echo "log scan failed for $name (status $scan_status)" >&2
  exit "$scan_status"
fi
if [[ $status -ne 0 ]]; then
  echo "safe command failed for $name (status $status)" >&2
  exit "$status"
fi
printf 'safe command passed; log scan passed: %s\n' "$name"
