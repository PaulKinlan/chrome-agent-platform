#!/usr/bin/env -S deno run -A
// scripts/build-gate.ts — dedicated heavy gate for in-place build-behaviour tests (chrome-agent-platform-h65e).
// Option D: moves build-behaviour coverage out of every lane's npm test into an explicitly-budgeted gate
// run during landing or on-demand.
//
// Enumerated coverage:
//   • tests/build-bootstrap.test.ts (per-file bound: 650s) — steady-state symlink bootstrap, GC of dangling v-boot
//     symlinks under dist-versions, live version counts, and archive packaging idempotence.
//   • tests/build-debug-mode.test.ts (per-file bound: 950s) — developer vs store target marker validation, sourcemap
//     inclusion/exclusion, and mode alternation integrity.
//   • tests/build-tool-bundling.test.ts (base serial window, measured ~10s; ceiling 720s under 4x load) — bundled-tool
//     generator verify-mode drift check, --regen-tools idempotence, and provenance validation.
//
// Total enforced ceiling: 2320s (~39 min under max load scale; measured 31-36 s on an Apple-silicon workstation after jjsz).
// Re-derived 2026-10-17 (chrome-agent-platform-tn7wh). A first pass set both windows from the MEASURED work (83.8s/57.4s
// on a loaded 8-core box) x3 = 350s each; that was WRONG and review finding chrome-agent-platform-rppwx caught it. These
// files run SEQUENTIAL real builds under their own bounds, and a later child cannot be NAMED until the earlier ones have
// finished, so the window must cover the whole declared child count (2 and 3) x PRODUCTION_BUILD_TIMEOUT_MS, not one
// child bound. The windows are therefore derived in scripts/test-partition.mjs and the invariant is asserted by
// tests/test-partition-guard.test.ts. Note build-debug-mode RISES 550s -> 950s: the old 550s was already below
// 3 x 300s and so never guaranteed child attribution. The ceiling rises with it; it is a bound, not a runtime cost.

import { fileURLToPath } from "node:url";
import { runSerialFiles } from "./lib/serial-phase.mjs";
import { BUILD_GATE_FILES } from "./test-partition.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

export function main(args = Deno.args): number {
  const cliFiles = args.filter((a) => !a.startsWith("-"));
  const files = cliFiles.length > 0 ? cliFiles : [...BUILD_GATE_FILES];
  console.log(`build-gate: running ${files.length} build-behaviour test(s) serially:`);
  for (const f of files) {
    console.log(`  - ${f}`);
  }
  const rc = runSerialFiles(files, { cwd: ROOT });
  if (rc === 0) {
    console.log(`\nbuild-gate: ALL ${files.length} BUILD-BEHAVIOUR TESTS GREEN`);
  } else {
    console.error(`\nbuild-gate: FAILED with exit code ${rc}`);
  }
  return rc;
}

if (import.meta.main) {
  const code = main();
  Deno.exit(code);
}
