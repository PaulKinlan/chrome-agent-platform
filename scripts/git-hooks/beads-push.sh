#!/bin/sh
# beads-push.sh — the post-commit hook's Dolt push, made LOUD on failure
# (chrome-agent-platform-f151).
#
# The hook used to run `bd dolt push 2>/dev/null &`: stderr was discarded and
# the background job's exit code never checked, so a rejected push
# (non-fast-forward divergence, no network) failed silently on every commit.
# This helper keeps the push safe to run from a background subshell (a commit
# is never blocked) but stops hiding failure: the full output is captured to
# <git-dir>/beads-push.log, and a single named line is printed to stderr with
# the exit code, the UTC timestamp, the log path and the remediation. It
# prints NOTHING on success and always exits 0.
#
# Runs from the committing checkout's root (where git runs every hook); never
# locate the repo via $0 — from a linked worktree that is the primary's file.
LOG="$(git rev-parse --git-dir 2>/dev/null)/beads-push.log"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
# chrome-agent-platform-qhuf2: route the push through the bounded, holder-naming
# wrapper when this checkout has it (a worktree off an older main may not — same
# guard as the staleness note: missing must never crash a commit). A hung git
# send-pack then dies at the hold bound instead of holding ~/.fleet/bd-sync.lock
# and the dolt DB forever.
# qhuf2 review P1: the raw fallback stays possible but is LOUD, never silent —
# the first cut fell back quietly, which made the wrapper guidance rather than
# enforcement. An unbounded push is exactly the 2026-10-31 hang (25+ min lock
# hold), so the fallback names itself on stderr (the f151 loud channel this hook
# already uses) and in the log.
if [ -x scripts/bd-sync-bound.sh ]; then
  scripts/bd-sync-bound.sh push > "$LOG" 2>&1
else
  printf '%s\n' "beads: WARNING — scripts/bd-sync-bound.sh is MISSING in this checkout; running an UNBOUNDED raw 'bd dolt push'. A hung send-pack will hold ~/.fleet/bd-sync.lock with NO hold bound (qhuf2). Fix: update this checkout so the wrapper exists." | tee "$LOG" >&2
  bd dolt push >> "$LOG" 2>&1
fi
RC=$?
if [ "$RC" -ne 0 ]; then
  printf '%s\n' "beads: dolt push FAILED (exit ${RC}) at ${TS} — run 'bd dolt pull' (then 'bd dolt push'); if it diverged, 'bd conflicts' — full output: ${LOG}" >&2
fi
exit 0
