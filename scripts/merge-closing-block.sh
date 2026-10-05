#!/bin/bash
# merge-closing-block.sh — the ATOMIC ASSERT -> BRANCH -> ACT block that gates a landing push.
#
# WHY THIS IS A SCRIPT AND NOT A HABIT (chrome-agent-platform-jfbn): "dry-run the real target, then
# push, nothing between them" is REHEARSE-THEN-ACT, not ASSERT-THEN-ACT. Written literally it pushes
# UNCONDITIONALLY — including on '[rejected]' — so it has the preflight's cost and none of its
# protection, and it fails in exactly the case the preflight exists for. Correctness by vigilance is
# not the same claim as correctness by construction. Here the captured output DECIDES, and no action
# is taken that the assertion did not authorise.
#
# BRANCH ORDER IS LOAD-BEARING: '[rejected]' is tested FIRST. A rejection is the only branch that
# must win over every other match, because a refusal's output can carry sha lines that a positive
# update-row test would otherwise satisfy incidentally.
#
# EXITS — distinct, so a caller cannot read "nothing to land" as success:
#   0 OK               update row present, no '[rejected]', and the published sha IS this HEAD -> push
#   2 NOTHING_TO_LAND  'Everything up-to-date' -> DO NOT PUSH (this is NOT a pass); write-path probe
#   3 REFUSED          '[rejected]' -> DO NOT PUSH; fetch + re-merge + RE-GATE the merged tree
#   4 UNKNOWN          matched no branch -> DO NOT PUSH (a git wording change, a locale or a
#                      truncated capture must not fall through to a push)
#   5 MISMATCH         the dry run would publish a different commit than HEAD -> DO NOT PUSH
#   6 PUSH_FAILED      the assertion passed but the real push itself failed
# The last branch being "else: push" is the difference between a gate and an unconditional push
# wearing a gate's clothes.
#
# THE UPDATE-ROW TEST IS ANCHORED, AND IT ACCEPTS BOTH FORMS GIT PRINTS — measured on the j5yz
# landing (chrome-agent-platform-jfbn). A HEAD-anchored regex is what the fleet first settled on, and
# it MISSES the second form below, which is this project's own push discipline ("push an explicit
# 40-char sha, never a branch name"):
#   "  <old>..<new>  HEAD -> target"         when SRC=HEAD
#   "  <old>..<new>  <full-sha> -> target"   when SRC=<40-char sha>   <- no HEAD token at all
# So the portable test anchors on the refspec arrow rather than on the token HEAD. INDEXING, also
# measured: the value to compare against HEAD is the one AFTER '..' (the local/new side). The value
# BEFORE '..' is the REMOTE's current value — a rule that says "the first value is the local side"
# would refuse every valid push.
#
# USAGE
#   scripts/merge-closing-block.sh                     # act; PUSH_MODE=stub is the default
#   SRC=<sha> TARGET=refs/heads/main PUSH_MODE=real scripts/merge-closing-block.sh
#   scripts/merge-closing-block.sh --classify <file> [--head <sha>]    # parse only, no git, no push
#   scripts/merge-closing-block.sh --help
#
# REHEARSE WITH THE PUSH STUBBED, AND SAY WHICH BRANCHES WERE REAL: a stubbed branch proves the
# parser, not the world. A branch that has never been exercised is a branch relied on without
# evidence. tests/merge-closing-block.test.ts exercises all six codes, five of them against real git
# output, with controls asserting that neither the target refs nor any probe ref moved.
set -uo pipefail

EXIT_OK=0
EXIT_NOTHING_TO_LAND=2
EXIT_REFUSED=3
EXIT_UNKNOWN=4
EXIT_MISMATCH=5
EXIT_PUSH_FAILED=6

REMOTE="${REMOTE:-origin}"
SRC="${SRC:-HEAD}"
TARGET="${TARGET:-refs/heads/main}"
PUSH_MODE="${PUSH_MODE:-stub}"

# Anchored: a line that merely MENTIONS a branch (git advice, a hook's output, prose) cannot satisfy
# it. [^ ]+ is the refspec's local side and is deliberately not the literal token HEAD.
UPDATE_ROW_RE='^ *[0-9a-f]{7,}\.\.[0-9a-f]{7,} +[^ ]+ -> '

usage() {
  sed -n '2,60p' "$0" | sed 's/^# \{0,1\}//'
}

# classify <captured-output-file> [<head-sha>]
# Pure: reads a captured dry-run output and prints the decision. Returns the branch's exit code.
# This is separated from the git call ON PURPOSE, so the branch ORDER can be tested directly (a
# synthetic output containing BOTH '[rejected]' and an update row must decide REFUSED).
classify() {
  local out="$1" head="${2:-}" new=""
  if grep -q '\[rejected\]' "$out"; then
    echo "DECISION=REFUSED"
    grep -m1 '\[rejected\]' "$out" | sed 's/^ */  /'
    echo "ACTION=DO NOT PUSH -> fetch, re-merge, RE-GATE the merged tree (never a blind retry)"
    return "$EXIT_REFUSED"
  fi
  if grep -q 'Everything up-to-date' "$out"; then
    echo "DECISION=NOTHING_TO_LAND"
    echo "ACTION=DO NOT PUSH (this is not a pass)"
    return "$EXIT_NOTHING_TO_LAND"
  fi
  if grep -qE "$UPDATE_ROW_RE" "$out"; then
    new="$(grep -oE '[0-9a-f]{7,}\.\.[0-9a-f]{7,}' "$out" | head -1 | sed 's/.*\.\.//')"
    if [ -n "$head" ] && [ -n "$new" ]; then
      case "$head" in
        "$new"*) ;;
        *)
          echo "DECISION=MISMATCH (the dry run would publish '$new'; HEAD is '$head')"
          echo "ACTION=DO NOT PUSH"
          return "$EXIT_MISMATCH"
          ;;
      esac
    fi
    echo "DECISION=OK (update row present, no [rejected], published sha ${new:-unknown} IS this HEAD)"
    return "$EXIT_OK"
  fi
  echo "DECISION=UNKNOWN (the output matched no branch)"
  echo "ACTION=DO NOT PUSH (unrecognised output fails closed rather than falling through to a push)"
  return "$EXIT_UNKNOWN"
}

case "${1:-}" in
  --help | -h)
    usage
    exit "$EXIT_OK"
    ;;
  --classify)
    out="${2:?--classify needs a file of captured dry-run output}"
    head=""
    if [ "${3:-}" = "--head" ]; then
      head="${4:?--head needs a sha}"
    fi
    [ -f "$out" ] || { echo "no such file: $out" >&2; exit "$EXIT_UNKNOWN"; }
    classify "$out" "$head"
    exit $?
    ;;
  "")
    ;;
  *)
    echo "unknown argument: $1" >&2
    usage >&2
    exit "$EXIT_UNKNOWN"
    ;;
esac

head_sha="$(git rev-parse HEAD 2>/dev/null)" || {
  echo "not a git worktree here; nothing to assert" >&2
  exit "$EXIT_UNKNOWN"
}

capture="$(mktemp)"
trap 'rm -f "$capture"' EXIT

echo "dry-run: $REMOTE $SRC:$TARGET"
git push --dry-run "$REMOTE" "$SRC:$TARGET" >"$capture" 2>&1
dry_rc=$?
# The status is UNPIPED and the file is the artefact: "the status is the decoy; the line of output is
# the evidence" — a piped $? reports the last command in the pipe, not git.
echo "  dry-run rc=$dry_rc (captured unpiped into a file)"

classify "$capture" "$head_sha"
decision_rc=$?

case "$decision_rc" in
  "$EXIT_OK")
    if [ "$PUSH_MODE" = "real" ]; then
      echo "  assertion passed -> pushing"
      git push "$REMOTE" "$SRC:$TARGET"
      push_rc=$?
      echo "  PUSH rc=$push_rc"
      if [ "$push_rc" -ne 0 ]; then
        exit "$EXIT_PUSH_FAILED"
      fi
    else
      echo "  ACTION=WOULD PUSH NOW (PUSH_MODE=stub: the mutation is stubbed, the assertion is not)"
    fi
    ;;
  "$EXIT_NOTHING_TO_LAND")
    # Exercised in the one state where the real-target form has nothing to exercise.
    probe="refs/heads/tmp-merge-closing-block-probe-$$"
    git push --dry-run "$REMOTE" "HEAD:$probe" >"$capture" 2>&1
    probe_rc=$?
    if grep -q '\* \[new branch\]' "$capture"; then
      echo "  write-path probe: negotiation row present (rc=$probe_rc) -> auth/permission/ref-state OK"
    else
      echo "  write-path probe: NO negotiation row (rc=$probe_rc) -> investigate"
    fi
    ;;
esac

exit "$decision_rc"
