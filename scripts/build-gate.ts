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

//
// SELECTIVE (chrome-agent-platform-6gk81): the default (no explicit files) form decides from a
// CONTENT key over this tier's own inputs whether the three tests can tell this tree apart from a
// tree that already passed them (scripts/lib/build-tier-inputs.mjs carries the rule, the safety
// argument for what is out of the key, and the fail-closed direction). A matching recorded PASS
// skips the 92s; any byte of build machinery, any of the tier's own tests, and every failure mode
// (no record, unreadable durable root, a record for another key, CAP_BUILD_TIER=force) RUNS it.
// There is no env var that skips the tier: a build gate's own tier must not be switchable off.
//
// Why this is not a coverage hole: the tier asserts build MECHANICS (symlink boot, GC of v-boot and
// metadata residue, one live version, two-build determinism, dev/store mode alternation, generator
// idempotence+provenance). Its product-content dimensions are already asserted on EVERY gate by
// build:production (generated-file sync, docs/about/changelog sync, oracle scan, reachability, the
// 52-binary Wasm manifest) plus npm test's build-smoke, dist-complete-source-authority and
// bundled-tool-packages. Measured before this change: test:build 92s of a 341s union gate.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSerialFiles } from "./lib/serial-phase.mjs";
import { BUILD_GATE_FILES } from "./test-partition.mjs";
import { buildTierMode, recordBuildTierPass, resolveBuildTier } from "./lib/build-tier-inputs.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The tree's own version, or null when package.json is unreadable (then the key is version-blind). */
async function treeVersion(): Promise<string | null> {
  try {
    const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
    return typeof pkg?.version === "string" && pkg.version !== "" ? pkg.version : null;
  } catch {
    return null;
  }
}

export async function main(args = Deno.args): Promise<number> {
  const cliFiles = args.filter((a) => !a.startsWith("-"));
  const explicit = cliFiles.length > 0;
  const files = explicit ? cliFiles : [...BUILD_GATE_FILES];

  // An explicit request names its own files, so it always runs; only the default form is selected.
  const decision = explicit
    ? null
    : await resolveBuildTier({ root: ROOT, version: await treeVersion(), mode: buildTierMode(Deno.env.toObject()) });

  if (decision && !decision.run) {
    console.log(`build-gate: SKIP ${files.length} build-behaviour test(s) — ${decision.reason}`);
    console.log(
      "build-gate: what still verified this tree in this gate: build:production (generated-file sync, docs/about/changelog, " +
        "oracle scan, reachability, Wasm manifest) and npm test (build-smoke, dist-complete-source-authority, bundled-tool-packages)",
    );
    console.log(`build-gate: tier: ${JSON.stringify({ ran: false, key: decision.key, inputs: decision.inputs, reason: decision.reason })}`);
    return 0;
  }
  if (decision) {
    console.log(`build-gate: SELECTIVE — ${decision.reason} (${decision.inputs} input file(s), key ${String(decision.key).slice(0, 12)})`);
  }

  console.log(`build-gate: running ${files.length} build-behaviour test(s) serially:`);
  for (const f of files) {
    console.log(`  - ${f}`);
  }
  const rc = runSerialFiles(files, { cwd: ROOT });
  if (rc === 0) {
    console.log(`\nbuild-gate: ALL ${files.length} BUILD-BEHAVIOUR TESTS GREEN`);
    if (decision?.key) {
      // Only a PASS may record, so a failing tier can never license a later skip.
      const recorded = await recordBuildTierPass({ key: decision.key, suites: files, exitCode: rc });
      console.log(`build-gate: PASS record ${recorded.written ? "written" : `not written (${recorded.reason})`} for input key ${decision.key.slice(0, 12)}`);
    }
  } else {
    console.error(`\nbuild-gate: FAILED with exit code ${rc}`);
  }
  return rc;
}

if (import.meta.main) {
  const code = await main();
  Deno.exit(code);
}
