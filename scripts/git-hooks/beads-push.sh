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
bd dolt push > "$LOG" 2>&1
RC=$?
if [ "$RC" -ne 0 ]; then
  printf '%s\n' "beads: dolt push FAILED (exit ${RC}) at ${TS} — run 'bd dolt pull' (then 'bd dolt push'); if it diverged, 'bd conflicts' — full output: ${LOG}" >&2
fi
exit 0
