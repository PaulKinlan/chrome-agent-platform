#!/bin/bash
# External evidence runner — FAIL-CLOSED: set -euo pipefail + aggregation;
# every gate exit=0; HEAD+CLEAN status verified before AND after each gate
# (dirty status FAILS the run); fresh chrome-journeys (119) at the exact SHA;
# the picker manifest's commit FIELD is parsed (no broad grep); the repo ROOT
# is scanned for stray lock/owner/stage temps.
set -euo pipefail
ROOT=/home/paulkinlan/cap-provider-picker
# Durable evidence root — mirrors scripts/lib/durable-root.mjs: /tmp here is
# RAM-backed tmpfs and evidence must survive a reboot. CAP_DURABLE_ROOT
# overrides (empty = unset), else $HOME/cap-evidence.
EVIDENCE_ROOT="${CAP_DURABLE_ROOT:-$HOME/cap-evidence}"
mkdir -p "$EVIDENCE_ROOT"
OUT=$(mktemp -d "$EVIDENCE_ROOT/cap-evidence-XXXXXX")
cd "$ROOT"
START_SHA=$(git rev-parse HEAD)
STAMP() { date -u +%FT%TZ; }
echo "run.start=$(STAMP) sha=$START_SHA" > "$OUT/00-meta.txt"
FAILED=0

note_fail() { echo "# FATAL: $1" >> "$OUT/00-meta.txt"; FAILED=1; }

GATE() { # GATE <name> <command...>
  local name=$1; shift
  local log="$OUT/$name.log"
  {
    echo "# sha=$(git rev-parse HEAD)"
    echo "# timestamp=$(STAMP)"
    echo "# command=$*"
    echo "# status_before=$(git status --porcelain | wc -l) changes"
    echo "# branch=$(git rev-parse --abbrev-ref HEAD)"
    echo
  } > "$log"
  if "$@" >> "$log" 2>&1; then echo "exit=0" >> "$log"; else echo "exit=$?" >> "$log"; note_fail "gate $name nonzero"; fi
  {
    echo "# post_sha=$(git rev-parse HEAD)"
    echo "# post_status=$(git status --porcelain | wc -l) changes"
  } >> "$log"
  [ "$(git rev-parse HEAD)" = "$START_SHA" ] || note_fail "HEAD moved during $name"
  [ "$(git status --porcelain | wc -l)" -eq 0 ] || note_fail "dirty worktree after $name"
  echo "gate $name: $(grep -oE 'exit=[0-9]+' "$log" | tail -1)"
}

GATE 10-unit node scripts/run-tests.mjs
GATE 11-build node build.mjs
# build leftovers + marker + repo-root strays
{
  echo "leftovers=$(ls -d extension/.dist-stage-* extension/.dist-link-* extension/.dist-prev-* extension/.build.lock* .build.lock* .lock-stage-* .lock-quarantine-* .owner.tmp-* 2>/dev/null | wc -l)"
  echo "marker=$(test -f extension/dist/dist.complete && echo present || echo MISSING)"
} >> "$OUT/11-build.log" 2>&1
[ "$(grep -oE 'leftovers=[0-9]+' "$OUT/11-build.log" | cut -d= -f2)" -eq 0 ] || note_fail "build leftovers present"
grep -q "marker=present" "$OUT/11-build.log" || note_fail "dist.complete missing"
GATE 12-gallery deno run -A scripts/component-gallery-smoke.ts
# The suite refuses a direct invocation by design (supervisor nonce + the
# inherited canonical flock); the supervisor is the only entry point.
GATE 13-security bash scripts/security-suite-supervisor.sh
GATE 14-drift-gallery npm run check:gallery
GATE 15-drift-changelog npm run check:changelog
GATE 16-picker50 deno run -A scripts/agent-provider-picker.ts
GATE 17-package node scripts/package-extension.mjs
GATE 18-package-load deno run -A scripts/validate-package-load.ts
GATE 19-chrome-119 deno run -A scripts/chrome-journeys.ts

# Deterministic picker artifact: the journey's own manifest records its dir —
# parse the printed manifest path (single source), then PARSE the manifest's
# commit FIELD and require equality with START_SHA (no broad grep).
PICKER_DIR=$(sed -n 's/^manifest: \(.*\)\/manifest.json.*/\1/p' "$OUT/16-picker50.log" | tail -1)
if [ -n "$PICKER_DIR" ] && [ -f "$PICKER_DIR/manifest.json" ]; then
  cp -r "$PICKER_DIR" "$OUT/picker-run"
  PICKER_SHA=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).commit ?? '')" "$OUT/picker-run/manifest.json")
  [ "$PICKER_SHA" = "$START_SHA" ] || note_fail "picker manifest commit field ($PICKER_SHA) != $START_SHA"
else
  note_fail "picker evidence dir not found"
fi

for f in "$OUT"/*.log; do
  grep -q "^exit=0$" "$f" || note_fail "$f not exit=0"
done

# repo-root stray sweep (post-run)
[ "$(ls .lock-stage-* .lock-quarantine-* .owner.tmp-* .build.lock* 2>/dev/null | wc -l)" -eq 0 ] || note_fail "repo-root temp strays present"

echo "run.end=$(STAMP) sha=$START_SHA failed=$FAILED" >> "$OUT/00-meta.txt"
echo "EVIDENCE_DIR=$OUT"
[ "$FAILED" -eq 0 ] || exit 1
