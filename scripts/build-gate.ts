#!/usr/bin/env -S deno run -A
// scripts/build-gate.ts — dedicated heavy gate for in-place build-behaviour tests (chrome-agent-platform-h65e).
// Option D: moves build-behaviour coverage out of every lane's npm test into an explicitly-budgeted gate
// run during landing or on-demand.
//
// Enumerated coverage:
//   • tests/build-bootstrap.test.ts (per-file bound: 850s) — steady-state symlink bootstrap, GC of dangling v-boot
//     symlinks under dist-versions, live version counts, and archive packaging idempotence.
//   • tests/build-debug-mode.test.ts (per-file bound: 550s) — developer vs store target marker validation, sourcemap
//     inclusion/exclusion, and mode alternation integrity.
//   • tests/build-tool-bundling.test.ts (base serial window, measured ~10s; ceiling 720s under 4x load) — bundled-tool
//     generator verify-mode drift check, --regen-tools idempotence, and provenance validation.
//
// Total enforced ceiling: 2120s (~35 min under max load scale; ~8 min typical).

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
