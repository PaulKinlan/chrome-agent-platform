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
import { areAllFailuresEnvironmental, combinePhaseExitCodes, ENVIRONMENTAL_REFUSAL_EXIT } from "./lib/environmental-verdict.mjs";
import { heavyGateCommand, phaseStatusFor } from "./lib/heavy-receipt.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const DEFAULT_HEAVY_GATE_TIMEOUT_MS = 1200_000;

/** The tree this run is attributed to (juubk). Resolved at the START; null if git cannot answer,
 *  which the receipt writer treats as an unwritable receipt (never a pass). */
async function currentTreeForReceipt(): Promise<string | null> {
  try {
    const mod = await import("./lib/heavy-receipt.mjs");
    return mod.currentTreeHash();
  } catch {
    return null;
  }
}

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

const ANSI_RE = /\x1b\[[0-9;]*[mGKH]/gu;

/**
 * Translate a finished wall-clock phase into the tier's verdict (chrome-agent-platform-rvht7).
 *
 * `deno test` reports a suite that refused environmentally as an ordinary test FAILURE (exit 1), because the
 * test threw. Across the batch that is exactly what the serial/parallel runners translate via the marker, but
 * the heavy tier runs these files in its own child processes — so the tier must translate too, or the whole
 * point of the refusal (a box problem must never read as a tree problem) is lost at the last step.
 *
 * Returns 75 when the phase's own output says every failure was environmental; otherwise the code unchanged.
 */
export function classifyPhaseExit(code: number, capturedOutput = ""): number {
  if (code === 0 || code === ENVIRONMENTAL_REFUSAL_EXIT) return code;
  const clean = capturedOutput.replace(ANSI_RE, "");
  if (areAllFailuresEnvironmental(clean)) return ENVIRONMENTAL_REFUSAL_EXIT;
  return code;
}

/** One `deno test` child with the tier's shared ceiling. Returns the child's exit code (124 on the bound). */
async function runPhase(
  label: string,
  files: string[],
  { parallel, timeoutMs, capture }: { parallel: boolean; timeoutMs: number; capture: boolean },
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
    // The wall-clock phase is CAPTURED (then echoed) so its refusal marker can be classified without losing
    // the operator's view; the batch keeps inheriting stdio because it is large and never refused.
    stdout: capture ? "piped" : "inherit",
    stderr: capture ? "piped" : "inherit",
  });
  const child = cmd.spawn();
  let captured = "";
  const pump = async (stream: ReadableStream<Uint8Array> | null, sink: (chunk: string) => void) => {
    if (!stream) return;
    for await (const chunk of stream) {
      const text = new TextDecoder().decode(chunk);
      captured += text;
      sink(text);
    }
  };
  const pumps = capture
    ? Promise.all([
      pump(child.stdout, (text) => Deno.stdout.writeSync(new TextEncoder().encode(text))),
      pump(child.stderr, (text) => Deno.stderr.writeSync(new TextEncoder().encode(text))),
    ])
    : Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
    timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch {}
    }, timeoutMs);
  }
  const status = await child.status;
  await pumps;
  if (timer) clearTimeout(timer);
  if (timedOut) {
    console.error(`\nheavy-gate: TIMED OUT after ${timeoutMs / 1000}s (${label})`);
    return 124;
  }
  const verdict = capture ? classifyPhaseExit(status.code, captured) : status.code;
  if (verdict === 0) console.log(`heavy-gate: ${label} GREEN`);
  else if (verdict === ENVIRONMENTAL_REFUSAL_EXIT) console.error(`heavy-gate: ${label} REFUSED environmentally (exit 75)`);
  else console.error(`heavy-gate: ${label} exited ${verdict}`);
  return verdict;
}

export async function runHeavyGate(args = Deno.args): Promise<number> {
  const runStart = Date.now();
  const requested = filesFor(args);
  const { parallel, wallClock } = partitionByPhase(requested);
  // juubk: the tree is captured at the START as well as the end. A worktree that mutated mid-run
  // cannot attribute these suites to the tree it happens to hold when they finish, so the drift is
  // recorded and never certifies.
  const treeStart = await currentTreeForReceipt();
  console.log(`heavy-gate: ${requested.length} heavy test(s) — ${parallel.length} parallel, ${wallClock.length} wall-clock`);
  const timeoutMs = Number(Deno.env.get("CAP_HEAVY_GATE_TIMEOUT_MS") ?? DEFAULT_HEAVY_GATE_TIMEOUT_MS);

  // Each phase is recorded with the files it ran, so the receipt can name every enumerated suite's
  // terminal status instead of a bare count (juubk: a 1-suite probe must never certify 19).
  const phases: { files: string[]; phase: string; code: number }[] = [];
  if (parallel.length) {
    phases.push({
      files: parallel,
      phase: "parallel",
      code: await runPhase("PARALLEL batch", parallel, { parallel: true, timeoutMs, capture: false }),
    });
  }
  // Wall-clock suites run one at a time, never beside the batch: their assertion is about the box.
  for (const file of wallClock) {
    phases.push({
      files: [file],
      phase: "wall-clock",
      code: await runPhase(`WALL-CLOCK ${file}`, [file], { parallel: false, timeoutMs, capture: true }),
    });
  }

  const codes = phases.map((p) => p.code);
  let rc = codes.length ? combinePhaseExitCodes(...codes) : 0;
  const suites = phases.flatMap((p) =>
    p.files.map((file) => ({ file, phase: p.phase, status: phaseStatusFor(p.code) }))
  );

  // chrome-agent-platform-upqhp: every tier run writes a receipt for the exact tree it ran on
  // (keyed by TREE hash). The gate-command stage (`node scripts/gate-receipt.mjs`) fails closed without a
  // fresh passing receipt for the tree it certifies, so this write is what keeps the heavy tier
  // genuinely covered once a suite is tiered here. Refusals and failures are recorded too — an
  // honest ledger — but only result "pass" ever certifies (checkHeavyReceipt enforces it).
  // upqhp (coord): the receipt records the EXACT command and result, not just a class — argv so
  // an auditor can re-run what produced the certification, rc so a timed-out or signal-killed
  // run cannot masquerade as a clean class.
  try {
    const mod = await import("./lib/heavy-receipt.mjs");
    if (!treeStart) throw new Error("could not resolve this tree at the START of the run");
    // The RAW argv: `filesFor()` ignores flags, so a flag-only run executes the full enumerated set
    // while a file-filtered `args` would look empty — and looking empty is what certifies (957s2).
    const cliArgs = [...args];
    const written = mod.writeHeavyReceipt({
      tree: treeStart,
      treeEnd: mod.currentTreeHash(),
      commit: mod.currentCommitSha(),
      result: rc === 0 ? "pass" : rc === ENVIRONMENTAL_REFUSAL_EXIT ? "refusal" : "fail",
      command: heavyGateCommand(args),
      args: cliArgs,
      exitCode: rc,
      logPath: Deno.env.get("HEAVY_GATE_LOG_PATH") ?? null,
      suites,
      dirty: mod.dirtyTrackedPaths(),
      startedAt: runStart,
      finishedAt: Date.now(),
    });
    const recorded = written.receipt.result;
    console.log(
      `heavy-gate: receipt ${recorded === "pass" ? "written" : `recorded as ${recorded} (not a pass)`}: ${written.path}` +
        `${written.preserved ? " — an earlier passing receipt for this tree was preserved" : ""}`,
    );
    if (written.preserved) {
      console.error(`heavy-gate: this run did NOT replace the certifying receipt already on disk for tree ${treeStart.slice(0, 12)} (juubk).`);
    }
  } catch (error) {
    // juubk: a receipt-write failure must not be a successful producer exit. A green tier with no
    // receipt looks certified to the operator and refuses at the gate, with the reason lost.
    console.error(`heavy-gate: FAILED TO WRITE HEAVY RECEIPT (${error instanceof Error ? error.message : String(error)}) — the gate will refuse to certify this tree until a receipt exists (upqhp), so this run is reported as a failure rather than a pass.`);
    if (rc === 0) rc = 1;
  }

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
