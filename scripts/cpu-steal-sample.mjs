#!/usr/bin/env node
// scripts/cpu-steal-sample.mjs — run the contention sampler (chrome-agent-platform-jvc0y).
//
// Start it DETACHED, before the gate, and never let it hold a model turn: it writes a file, it does
// not poll the gate (operational note on the bead).
//
//   setsid nohup node scripts/cpu-steal-sample.mjs --out ~/cap-evidence/cpu-steal/<run>.tsv \
//     --seconds 2400 >/dev/null 2>&1 &
//
// It has a HARD SELF-BOUND (--seconds, default 1800) so a forgotten sampler cannot outlive the gate,
// flushes each row as it is taken (a kill leaves the rows it already measured), and on exit prints one
// JSON summary so the numbers can be quoted without parsing the TSV.
//
// Phase boundaries: a consumer that knows when a timed suite ran (scripts/heavy-gate.ts, via
// lib/cpu-steal-sampler.mjs) marks them programmatically. This CLI can also mark one by hand:
//   --mark <name>   append a marker row before sampling starts (and read MARK_SIGNAL? no: keep simple)
//   --phase "name:startISO:endISO"  classify timing against a phase supplied by the caller
//
// Exit codes: 0 = sampled for the requested window (whatever the machine did); 2 = the invocation was
// wrong or the log is unwritable. A sampler that cannot write is not a measurement, so it must not
// look like a clean run.

import { durableDir } from "./lib/durable-root.mjs";
import {
  DEFAULT_INTERVAL_MS,
  classifyTiming,
  createSampler,
  formatSampleRow,
  openSampleLog,
} from "./lib/cpu-steal-sampler.mjs";
import { join } from "node:path";

function parseArgs(argv) {
  const out = { intervalMs: DEFAULT_INTERVAL_MS, seconds: 1800, out: null, mark: "", phases: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") out.out = argv[++i];
    else if (arg === "--interval") out.intervalMs = Number(argv[++i]);
    else if (arg === "--seconds") out.seconds = Number(argv[++i]);
    else if (arg === "--mark") out.mark = argv[++i] ?? "";
    else if (arg === "--phase") {
      const [name, startedAt, finishedAt] = String(argv[++i] ?? "").split(":");
      const start = Date.parse(startedAt);
      const end = Date.parse(finishedAt);
      if (!name || !Number.isFinite(start) || !Number.isFinite(end)) {
        console.error(`cpu-steal-sample: --phase wants "name:startISO:endISO" (got ${JSON.stringify(argv[i])})`);
        process.exit(2);
      }
      out.phases.push({ name, startedAt: start, finishedAt: end });
    } else if (arg === "--help" || arg === "-h") {
      console.log("usage: node scripts/cpu-steal-sample.mjs --out <tsv> [--interval ms] [--seconds n] [--mark name] [--phase name:startISO:endISO]");
      process.exit(0);
    } else {
      console.error(`cpu-steal-sample: unknown argument ${JSON.stringify(arg)}`);
      process.exit(2);
    }
  }
  if (!Number.isFinite(out.intervalMs) || out.intervalMs < 250) {
    console.error("cpu-steal-sample: --interval must be a number >= 250ms (finer sampling is a load source itself)");
    process.exit(2);
  }
  if (!Number.isFinite(out.seconds) || out.seconds <= 0) {
    console.error("cpu-steal-sample: --seconds must be a positive number (the sampler needs a hard self-bound)");
    process.exit(2);
  }
  if (!out.out) {
    console.error("cpu-steal-sample: --out <path> is required; the durable root is ~/cap-evidence");
    process.exit(2);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const outPath = args.out.startsWith("/") ? args.out : join(durableDir("cpu-steal"), args.out);

let log;
try {
  log = openSampleLog(outPath);
} catch (error) {
  console.error(`cpu-steal-sample: cannot open the sample log: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

const rows = [];
const sampler = createSampler({
  intervalMs: args.intervalMs,
  sink: (line, sample) => {
    log.write(line);
    rows.push(sample);
  },
});

const startedAt = Date.now();
const deadline = startedAt + args.seconds * 1000;
let stopping = false;

function finish(reason) {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  const phases = args.phases.length ? args.phases : [{ name: "window", startedAt, finishedAt: Date.now() }];
  const timing = classifyTiming(rows, phases, { intervalMs: args.intervalMs });
  log.close();
  const summary = {
    sampler: "cpu-steal-sampler",
    log: log.path,
    stopReason: reason,
    startedAt,
    finishedAt: Date.now(),
    intervalMs: args.intervalMs,
    samples: rows.length,
    validSamples: rows.filter((row) => row.valid).length,
    timing,
  };
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

process.on("SIGTERM", () => finish("SIGTERM"));
process.on("SIGINT", () => finish("SIGINT"));

if (args.mark) {
  // A marker is a row of its own so the TSV stays parseable: one event per line, always.
  // A marker keeps the row shape (14 columns): the event name rides in the `top` column, so a parser
  // never has to special-case it and the "one sample per line" invariant holds.
  log.write(formatSampleRow({ ts: Date.now(), valid: false, steal_pct: null, load1: null, psi_some: null, counts: { deno: 0, node: 0, python3: 0, chrome: 0, esbuild: 0, build_mjs: 0, gate_fast: 0 }, totalProcs: 0, top: `marker=${args.mark}` }));
}

sampler.prime();
sampler.sample();
const timer = setInterval(() => {
  if (Date.now() >= deadline) {
    finish("self-bound");
    return;
  }
  try {
    sampler.sample();
  } catch (error) {
    console.error(`cpu-steal-sample: sample failed (${error instanceof Error ? error.message : String(error)}); continuing`);
  }
}, args.intervalMs);

// Keep the process alive without holding a terminal; the self-bound timer is what ends it.
process.on("beforeExit", () => {
  if (!stopping) finish("beforeExit");
});
