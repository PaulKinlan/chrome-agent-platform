#!/usr/bin/env bash
# bd-sync-bound.sh — a bounded, holder-naming wrapper for `bd dolt push` / `bd dolt pull`
# (chrome-agent-platform-qhuf2; the hub-side shim fix is filed as fleet-cilm5).
#
# The fleet bd shim serializes every bd call through `flock -w 300 "$HOME/.fleet/bd-sync.lock"`,
# but -w bounds the WAIT, never the HOLDER: a hung `bd dolt push` (git send-pack stuck) holds
# the lock AND the embedded dolt DB indefinitely — measured 25+ minutes on 2026-10-31, with
# every lane write failing under the misleading "database is locked by another dolt process"
# while two detached jobs burned 600s/900s bounds. The shim is hub-owned, so THIS wrapper is
# the project-side mitigation for sync calls:
#
#   scripts/bd-sync-bound.sh push [bd dolt args...]
#   scripts/bd-sync-bound.sh pull [bd dolt args...]
#
# Contract:
#   1. HOLDER NAMED: a sidecar ($CAP_BD_SYNC_HOLDER, default ~/.fleet/bd-sync.holder)
#      records pid + command + start time while we hold the lock. A contender that times
#      out WAITING prints the ALIVE holder lines and the kill guidance (exit 3), instead
#      of retrying blind for an hour. Dead pids are filtered; the sidecar is removed on
#      exit.
#   2. WAIT BOUNDED: flock -w "$CAP_BD_SYNC_WAIT" (default 120s). Expiry is a LOUD
#      failure naming the holder, never a silent queue.
#   3. HOLD BOUNDED: the bd child runs under `timeout --kill-after=15
#      "$CAP_BD_SYNC_HOLD"` (default 180s), so a hung git send-pack dies and releases
#      both the flock and the embedded dolt DB. Exit 124/137 means the bound killed a
#      hung network sync — a failure of the network, not of bd.
#   4. NESTED SAFE: the shim execs bd under ITS OWN flock on the SAME lock file, so the
#      wrapper always sets FLEET_BD_LOCKED=1 for its child (the shim's documented
#      bypass) — without it, the shim's flock would wait on ours and deadlock on
#      ourselves. When the CALLER is already inside that bypass, the wrapper skips its
#      own lock and holder bookkeeping entirely and just bounds the call.
set -u

command -v flock >/dev/null 2>&1 || { echo "bd-sync-bound: flock not found" >&2; exit 2; }
command -v timeout >/dev/null 2>&1 || { echo "bd-sync-bound: timeout not found" >&2; exit 2; }
command -v bd >/dev/null 2>&1 || { echo "bd-sync-bound: bd not found on PATH" >&2; exit 2; }

case "${1:-}" in
  push|pull) sub="$1"; shift ;;
  *) echo "usage: bd-sync-bound.sh push|pull [bd dolt args...]" >&2; exit 2 ;;
esac

LOCK_FILE="${CAP_BD_SYNC_LOCK:-$HOME/.fleet/bd-sync.lock}"
HOLDER_FILE="${CAP_BD_SYNC_HOLDER:-$HOME/.fleet/bd-sync.holder}"
WAIT="${CAP_BD_SYNC_WAIT:-120}"
HOLD="${CAP_BD_SYNC_HOLD:-180}"

if [ "${FLEET_BD_LOCKED:-}" = "1" ]; then
  # Already serialized by an outer holder: bound only. No sidecar, no flock of ours.
  rc=0
  timeout --kill-after=15 "$HOLD" bd dolt "$sub" "$@" || rc=$?
  exit "$rc"
fi

printf 'pid=%s cmd=bd-dolt-%s start=%s\n' "$$" "$sub" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$HOLDER_FILE" 2>/dev/null || true
# Only the lock HOLDER may remove the sidecar: a losing contender exits via this trap
# too, and deleting the file then would destroy the winner's holder record — exactly
# the evidence the loss message just printed. A loser's stale line is dead pid data;
# the next winner prunes it on acquire and every read filters live pids only.
acquired=0
trap '[ "$acquired" = 1 ] && rm -f "$HOLDER_FILE"' EXIT
# NB: a bare `exec 9>file` only — adding e.g. `2>/dev/null` to the same exec would
# redirect the SHELL's stderr for its whole life (exec redirections stick), and every
# diagnostic below would vanish into /dev/null.
exec 9>"$LOCK_FILE"

# Alive-holder lines: a sidecar line names a holder only while its pid still exists.
alive_holder_lines() {
  [ -f "$HOLDER_FILE" ] || return 0
  while IFS= read -r line; do
    case "$line" in
      pid=*)
        p=$(printf '%s' "$line" | sed -n 's/^pid=\([0-9]*\).*/\1/p')
        if [ -n "$p" ] && [ "$p" != "$$" ] && [ -d "/proc/$p" ]; then echo "  $line"; fi ;;
    esac
  done < "$HOLDER_FILE"
}

if ! flock -w "$WAIT" 9; then
  {
    echo "bd-sync-bound: '$LOCK_FILE' still held after ${WAIT}s. Alive holder(s):"
    alive_holder_lines
    echo "bd-sync-bound: kill the pid above (inspect: tr '\\0' ' ' < /proc/<pid>/cmdline) and retry this command."
    echo "bd-sync-bound: the fleet shim bounds the flock WAIT, never the HOLDER (qhuf2 / fleet-cilm5)."
  } >&2
  exit 3
fi

# We hold the lock: prune dead lines, then re-stamp so the sidecar names the REAL holder.
acquired=1
tmp="$HOLDER_FILE.tmp.$$"
alive_holder_lines > "$tmp" 2>/dev/null || true
printf 'pid=%s cmd=bd-dolt-%s start=%s\n' "$$" "$sub" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$tmp" 2>/dev/null || true
mv "$tmp" "$HOLDER_FILE" 2>/dev/null || true

rc=0
FLEET_BD_LOCKED=1 timeout --kill-after=15 "$HOLD" bd dolt "$sub" "$@" || rc=$?
if [ "$rc" -ge 124 ] && [ "$rc" -le 137 ]; then
  echo "bd-sync-bound: bd dolt $sub hit the ${HOLD}s hold bound (exit $rc) - the sync network hung;" \
    "the lock is released now. Retry later; 'bd dolt pull' first if the push diverged." >&2
fi
exit "$rc"
