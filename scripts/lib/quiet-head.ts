#!/usr/bin/env -S deno run -A
// scripts/lib/quiet-head.ts — run load-sensitive measurement files ONLY in a quiet window, and run them
// FIRST (gate-speed, 2026-10-09).
//
// WHY A HEAD PHASE: tests/ntp-boot-staging.test.ts asserts a TIMING CONTRACT of the product — 0 long
// tasks (>50 ms) while a freshly built extension boots ntp.html. Measured on the 2-vCPU fleet hub: green
// on a quiet box (2/2), and red 3/3 with three CPU burners running, because the suite's own saturation
// produces the long tasks the test reads as the product's. Its policy deliberately does NOT count the
// suite's own load as contention (a run whose only contention is the suite is a VALID run), so placement
// is the only thing that can make the measurement mean the product.
//
// WHERE IT RUNS: FIRST in the run, before the type check, the serial lanes and the parallel phase —
// the only moment in a full gate when the box is otherwise idle. (`npm run gate` runs it before it
// starts its overlapped sibling build, and tells the suite so with CAP_QUIET_HEAD_DONE=1.)
//
// THE VERDICT: this waits (bounded, default 5 min) for a quiet window using the shared sampler — the
// same rule the quiet-window harnesses use (load per core, and heavy builders detected by CPU
// accumulation, never by name). If the box never quiets, the measurement would be a lie in either
// direction, so it REFUSES with exit 75 and an `ENVIRONMENT:` line + the CAP_ENVIRONMENTAL_REFUSAL
// marker: neither a pass nor a product red, the repo's third verdict (chrome-agent-platform-mkax).
//
// The files themselves run through the SAME runner as every other phase
// (scripts/lib/serial-lane.mjs → runSerialFiles: own process, per-file window, attribution).
import { awaitQuietWindow, ENVIRONMENTAL_REFUSAL_MARKER, formatSpec, environmentLine, resolveSpec } from "./quiet-window.ts";

/** The environment variable a caller sets once it has run this phase itself (so it never runs twice). */
export const QUIET_HEAD_DONE_ENV = "CAP_QUIET_HEAD_DONE";

/** The wait spec, as a pure function of its knobs (pinned by tests/quiet-head.test.ts). */
export function headSpec(env: Record<string, string | undefined> = Deno.env.toObject()) {
  // MEASURED on the 2-vCPU hub: the file is green with the box at load/core 0.48 (its own bookkeeping
  // reads a "valid" run either way, so the placement + this wait are what make the number mean the
  // product), and red 3/3 with three CPU burners making load/core ~2.5. 0.5 sits below every measured
  // failure and above the hub's ambient floor (~0.3-0.5), so the wait finds a window without relaxing
  // the bar; a box that never gets there is REFUSED (75), never measured anyway.
  const maxWaitMs = Number(env.CAP_QUIET_HEAD_MAX_WAIT_MS ?? 300_000);
  return {
    maxWaitMs: Number.isFinite(maxWaitMs) && maxWaitMs >= 0 ? maxWaitMs : 300_000,
    maxLoadPerCore: 0.5,
  };
}

export async function main(args = Deno.args, env: Record<string, string | undefined> = Deno.env.toObject()): Promise<number> {
  const files = args.filter((a) => !a.startsWith("-"));
  if (files.length === 0) return 0;
  if (env[QUIET_HEAD_DONE_ENV] === "1") return 0;
  const spec = headSpec(env);
  console.log(`quiet-head: waiting for a quiet window (load/core <= ${spec.maxLoadPerCore}, no active heavy builder, up to ${spec.maxWaitMs / 1000}s) before measuring: ${files.join(", ")}`);
  const verdict = await awaitQuietWindow(spec);
  if (!verdict.ok) {
    const line = environmentLine(verdict.last, resolveSpec(spec));
    console.error(`ENVIRONMENT: no quiet window for the load-sensitive measurement after ${Math.round(verdict.waitedMs / 1000)}s — ${verdict.reason}. ${line}`);
    console.error(`${ENVIRONMENTAL_REFUSAL_MARKER} ${JSON.stringify({ phase: "quiet-head", files, waitedMs: verdict.waitedMs, reason: verdict.reason })}`);
    return 75;
  }
  console.log(`quiet-head: quiet window after ${Math.round(verdict.waitedMs / 1000)}s (${formatSpec(verdict.spec)}); measuring now`);
  const lane = new Deno.Command("node", {
    args: ["scripts/lib/serial-lane.mjs", ...files],
    cwd: new URL("../..", import.meta.url).pathname,
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await lane.output();
  return code;
}

if (import.meta.main) Deno.exit(await main());
