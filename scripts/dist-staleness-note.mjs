#!/usr/bin/env node
// scripts/dist-staleness-note.mjs — name a stale built extension at the moment
// it goes stale (chrome-agent-platform-1mz2).
//
// `extension/dist/dist.complete` binds the exact Git commit, every indexed
// source byte and the generated bundle bytes, so ANY commit invalidates a built
// tree — including the post-commit hook's own version bump and
// `git commit --amend`. Lanes met that as three red serial-phase tests whose
// message named a marker rather than the cause, paying a re-diagnosis each
// time. The post-commit hook runs this so the cause and the fix are printed
// before the next gate run.
//
// A NOTE, never a gate: it exits 0 whatever it finds, prints nothing when the
// build is current or absent, and never touches the tree. It validates the
// recorded target so a developer/enterprise build is judged against itself.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validateDistCompleteMarker } from "./dist-complete.mjs";

const root = process.cwd();
const distRoot = join(root, "extension", "dist");
const markerPath = join(distRoot, "dist.complete");

try {
  if (!existsSync(markerPath)) process.exit(0);

  // Judge the build against the target it was made for; an unreadable marker is
  // itself stale, so fall back to the target the serial phase requires.
  let target = "store";
  try {
    const recorded = JSON.parse(readFileSync(markerPath, "utf8"))?.target;
    if (typeof recorded === "string" && recorded) target = recorded;
  } catch { /* validateDistCompleteMarker reports the real defect */ }

  await validateDistCompleteMarker({ root, distRoot, expectedTarget: target });
} catch (error) {
  console.error(`[dist] the built extension is stale against this tree: ${error?.message ?? error}`);
  console.error("[dist] rebuild before the gate — npm run build:production  (npm run check:dist re-checks)");
}
process.exit(0);
