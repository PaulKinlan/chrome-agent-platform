#!/usr/bin/env -S deno run -A
// scripts/heavy-gate.ts — dedicated tier for WASM and heavy binary fixture tests (chrome-agent-platform-o29c0).
// Moves WASM execution and large binary fixture tests (56.6 MB in packages/bundled/evidence, wasm-tools, and docs/admissions)
// out of the default npm test parallel phase into a dedicated tier to prevent RAM spikes and CPU starvation.
//
// Enumerated coverage:
//   19 test files in HEAVY_GATE_FILES covering Pyodide in-process execution, image codecs (AVIF, JXL, ZXing, CompressOps,
//   ImageOps, OxiPNG), WASI preview1 runtime, UNIX tools, CallExport, external sort, and Emscripten schema-2 module audits.
// Ceiling: 1200s (20 minutes). Override with CAP_HEAVY_GATE_TIMEOUT_MS.

import { fileURLToPath } from "node:url";
import { HEAVY_GATE_FILES } from "./test-partition.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const DEFAULT_HEAVY_GATE_TIMEOUT_MS = 1200_000;

export function filesFor(args: string[] = []): string[] {
  const cliFiles = args.filter((a) => !a.startsWith("-"));
  return cliFiles.length > 0 ? cliFiles : [...HEAVY_GATE_FILES];
}

export async function runHeavyGate(args = Deno.args): Promise<number> {
  const files = filesFor(args);
  console.log(`heavy-gate: running ${files.length} heavy WASM/fixture test(s):`);
  for (const f of files) {
    console.log(`  - ${f}`);
  }
  const timeoutMs = Number(Deno.env.get("CAP_HEAVY_GATE_TIMEOUT_MS") ?? DEFAULT_HEAVY_GATE_TIMEOUT_MS);
  const cmd = new Deno.Command("deno", {
    args: ["test", "-A", "--config", "deno.runner.jsonc", "--parallel", ...files],
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
    console.error(`\nheavy-gate: TIMED OUT after ${timeoutMs / 1000}s`);
    return 124;
  }
  if (status.code === 0) {
    console.log(`\nheavy-gate: ALL ${files.length} HEAVY WASM/FIXTURE TESTS GREEN`);
  } else {
    console.error(`\nheavy-gate: FAILED with exit code ${status.code}`);
  }
  return status.code;
}

export function main(args = Deno.args): Promise<number> {
  return runHeavyGate(args);
}

if (import.meta.main) {
  const code = await main();
  Deno.exit(code);
}
