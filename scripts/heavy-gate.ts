#!/usr/bin/env -S deno run -A
// scripts/heavy-gate.ts — dedicated tier for WASM and heavy binary fixture tests (chrome-agent-platform-o29c0).
// Moves WASM execution and large binary fixture tests (56.6 MB in packages/bundled/evidence, wasm-tools, and docs/admissions)
// out of the default npm test parallel phase into a dedicated tier to prevent RAM spikes and CPU starvation.
//
// Enumerated coverage:
//   19 test files in HEAVY_GATE_FILES covering Pyodide in-process execution, image codecs (AVIF, JXL, ZXing, CompressOps,
//   ImageOps, OxiPNG), WASI preview1 runtime, UNIX tools, CallExport, external sort, and Emscripten schema-2 module audits.
//
// TWO PHASES since chrome-agent-platform-rvht7, because one of those files does not belong in a parallel batch:
//   1. PARALLEL — the RAM/CPU-saturating suites, `deno test --parallel` exactly as before.
//   2. WALL-CLOCK — WALL_CLOCK_HEAVY_FILES (today: the NTP boot timing contract), run AFTER the batch, ONE FILE
//      AT A TIME, with no --parallel. Each such suite acquires its own quiet window first
//      (lib/heavy-quiet-acquire.ts): the batch that just finished is by design the least quiet thing on the
//      box, so a wall-clock budget measured beside it was measuring the neighbours. A window that never
//      arrives inside its bound is an ENVIRONMENTAL REFUSAL (exit 75 + CAP_ENVIRONMENTAL_REFUSAL), never a
//      product FAIL.
// Ceiling: 1200s (20 minutes). Override with CAP_HEAVY_GATE_TIMEOUT_MS. The ceiling covers BOTH phases.

import { fileURLToPath } from "node:url";
import { HEAVY_GATE_FILES, WALL_CLOCK_HEAVY_FILES } from "./test-partition.mjs";
import { combinePhaseExitCodes } from "./lib/environmental-verdict.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const DEFAULT_HEAVY_GATE_TIMEOUT_MS = 1200_000;

export function filesFor(args: string[] = []): string[] {
  const cliFiles = args.filter((a) => !a.startsWith("-"));
  return cliFiles.length > 0 ? cliFiles : [...HEAVY_GATE_FILES];
}

const WALL_CLOCK = new Set(WALL_CLOCK_HEAVY_FILES);

/** Split the requested files into the two phases. Exported so a test can pin the split without running Deno. */
export function partitionByPhase(files: string[]): { parallel: string[]; wallClock: string[] } {
  return {
    // Declaration order is preserved inside each phase so the log reads the same for the same input.
    parallel: files.filter((f) => !WALL_CLOCK.has(f)),
    wallClock: files.filter((f) => WALL_CLOCK.has(f)),
  };
}

/** One `deno test` child with the tier's shared ceiling. Returns the child's exit code (124 on the bound). */
async function runPhase(
  label: string,
  files: string[],
  { parallel, timeoutMs }: { parallel: boolean; timeoutMs: number },
): Promise<number> {
  console.log(`\nheavy-gate: ${label} — ${files.length} file(s)${parallel ? " (--parallel)" : " (SERIAL, quiet-window acquirer)"}`);
  for (const f of files) console.log(`  - ${f}`);
  const args = ["test", "-A", "--config", "deno.runner.jsonc"];
  if (parallel) args.push("--parallel");
  args.push(...files);
  const cmd = new Deno.Command("deno", {
    args,
    cwd: ROOT,
    env: { ...Deno.env.toObject(), CAP_TEST_RUNNER: "1" },
    stdout: "inherit",
    stderr: "inherit",
  });
  const child = cmd.spawn();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
    timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch {}
    }, timeoutMs);
  }
  const status = await child.status;
  if (timer) clearTimeout(timer);
  if (timedOut) {
    console.error(`\nheavy-gate: TIMED OUT after ${timeoutMs / 1000}s (${label})`);
    return 124;
  }
  if (status.code === 0) console.log(`heavy-gate: ${label} GREEN`);
  else console.error(`heavy-gate: ${label} exited ${status.code}`);
  return status.code;
}

export async function runHeavyGate(args = Deno.args): Promise<number> {
  const requested = filesFor(args);
  const { parallel, wallClock } = partitionByPhase(requested);
  console.log(`heavy-gate: ${requested.length} heavy test(s) — ${parallel.length} parallel, ${wallClock.length} wall-clock`);
  const timeoutMs = Number(Deno.env.get("CAP_HEAVY_GATE_TIMEOUT_MS") ?? DEFAULT_HEAVY_GATE_TIMEOUT_MS);

  const codes: number[] = [];
  if (parallel.length) codes.push(await runPhase("PARALLEL batch", parallel, { parallel: true, timeoutMs }));
  // Wall-clock suites run one at a time, never beside the batch: their assertion is about the box.
  for (const file of wallClock) {
    codes.push(await runPhase(`WALL-CLOCK ${file}`, [file], { parallel: false, timeoutMs }));
  }

  const rc = codes.length ? combinePhaseExitCodes(...codes) : 0;
  if (rc === 0) {
    console.log(`\nheavy-gate: ALL ${requested.length} HEAVY WASM/FIXTURE TESTS GREEN`);
  } else if (rc === 75) {
    // Say it plainly: this is the box, not the tree, and the marker line above names the suite and the bound.
    console.error(
      `\nheavy-gate: ENVIRONMENTAL REFUSAL (exit 75) — a wall-clock suite could not acquire a quiet window. ` +
        `Not a product failure; do not relabel it as one.`,
    );
  } else {
    console.error(`\nheavy-gate: FAILED with exit code ${rc}`);
  }
  return rc;
}

export function main(args = Deno.args): Promise<number> {
  return runHeavyGate(args);
}

if (import.meta.main) {
  const code = await main();
  Deno.exit(code);
}
