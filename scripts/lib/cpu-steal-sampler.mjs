// scripts/lib/cpu-steal-sampler.mjs — the reusable gate-contention instrument
// (chrome-agent-platform-jvc0y).
//
// WHY THIS EXISTS: on 2026-10-23 a full gate looked normal and was wrong. A sampler that read the
// whole /proc table every 2s measured CPU STEAL at 50-87% during a run that still completed 744/744
// parallel files: completeness was certifiable while every DURATION in that run was noise. That
// distinction — accounting is evidence, durations are not — is what the hub's ACCOUNTING-only
// exception was applied to, and this module is the instrument that produced it.
//
// WHAT IT MEASURES (per sample, one line, never multi-line):
//   ts          epoch milliseconds
//   load1       first field of /proc/loadavg
//   steal_pct   100 * (stealNow - stealPrev) / (totalNow - totalPrev) from the aggregate `cpu` line
//   psi_some    /proc/pressure/cpu "some avg10" (PSI alone would have MISSED the 2026-10-23 steal:
//               its `some` figures stayed low while steal was high, so both are recorded)
//   procs       counts by class over the WHOLE process table: deno, node, python3, chrome, esbuild,
//               build_mjs, gate_fast — v1 counted only deno and chrome and therefore could not
//               attribute a load1 of 20.79 on a 2-vCPU box, which turned out to be host steal
//   total_procs every process on the box
//   top         the highest-%CPU command, for attribution
//
// THE BUG THAT BROKE v1, recorded so it is not repeated: `pgrep -c <name>` PRINTS 0 AND EXITS 1 when
// there are no matches, so a line built as "$(pgrep -c a) $(pgrep -c b)" emitted "0\n0" and split
// every row across three lines, silently corrupting the file. This module never shells out for
// process counts: it reads /proc directly, and every row is assembled from parsed values
// (`formatSampleRow` asserts a single line). v1 also sampled every 15s, which missed the peaks.
//
// VALIDITY IS PART OF THE MEASUREMENT. A sample is VALID only when both counters advanced and the
// percentages are finite; a gap inside a timed phase (longer than 2.5 intervals) means coverage is
// incomplete. Missing/unreadable/incomplete samples produce UNKNOWN — never a steal exception — which
// is the rule the consumer (chrome-agent-platform-tu8w9) must apply. Nothing here decides a landing;
// `classifyTiming` reports what the machine did so the caller can decide whether durations are
// evidence at all.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { isRamBacked } from "./durable-root.mjs";

export const DEFAULT_INTERVAL_MS = 2000;
/** The steal percentage at or above which a duration is not evidence (ADR rxayt / tu8w9). */
export const STEAL_THRESHOLD_PCT = 20;
/** A gap inside a timed phase longer than this many intervals makes coverage incomplete. */
export const MAX_GAP_INTERVALS = 2.5;

/** The /proc fields summed into the total. guest/guest_nice are EXCLUDED: they are already counted
 *  inside user/nice, and double-counting inflates the denominator, which understates steal. */
const TOTAL_FIELDS = ["user", "nice", "system", "idle", "iowait", "irq", "softirq", "steal"];

/**
 * Parse the aggregate `cpu` line of /proc/stat.
 * @param {string} text
 * @returns {{ ok: boolean, reason?: string, total?: number, steal?: number, fields?: Record<string, number> }}
 */
export function parseCpuStat(text) {
  const line = String(text ?? "")
    .split("\n")
    .find((row) => row.startsWith("cpu "));
  if (!line) return { ok: false, reason: "no aggregate cpu line" };
  const parts = line.trim().split(/\s+/).slice(1).map((value) => Number(value));
  if (parts.length < 8 || parts.some((value) => !Number.isFinite(value))) {
    return { ok: false, reason: "aggregate cpu line is short or non-numeric" };
  }
  const fields = {};
  ["user", "nice", "system", "idle", "iowait", "irq", "softirq", "steal", "guest", "guest_nice"].forEach((name, index) => {
    if (index < parts.length) fields[name] = parts[index];
  });
  const total = TOTAL_FIELDS.reduce((sum, name) => sum + (fields[name] ?? 0), 0);
  return { ok: true, total, steal: fields.steal ?? 0, fields };
}

/** `load1` from /proc/loadavg, or null when it cannot be read. */
export function parseLoad1(text) {
  // Number("") is 0 and 0 IS finite, so an unreadable /proc/loadavg would have been recorded as a
  // real load of exactly zero — the most reassuring possible lie. Empty input is null.
  const token = String(text ?? "").trim().split(/\s+/)[0];
  if (!token) return null;
  const value = Number(token);
  return Number.isFinite(value) ? value : null;
}

/** `/proc/pressure/cpu` — the `some avg10` and `full avg10` figures, when present. */
export function parsePressureCpu(text) {
  const out = { someAvg10: null, someTotal: null, fullAvg10: null };
  for (const line of String(text ?? "").split("\n")) {
    const [kind, ...rest] = line.trim().split(/\s+/);
    if (kind !== "some" && kind !== "full") continue;
    for (const field of rest) {
      const [key, raw] = field.split("=");
      const value = Number(raw);
      if (!Number.isFinite(value)) continue;
      if (kind === "some" && key === "avg10") out.someAvg10 = value;
      if (kind === "some" && key === "total") out.someTotal = value;
      if (kind === "full" && key === "avg10") out.fullAvg10 = value;
    }
  }
  return out;
}

const CLASS_MATCHERS = Object.freeze({
  deno: /(^|\/|\s)deno(\.exe)?$|(^|\s)deno\s+/,
  node: /(^|\/|\s)node(\.exe)?$|(^|\s)node\s+/,
  python3: /(^|\/|\s)python3?(\.\d+)?$/,
  chrome: /(^|\/)(chrome|chromium|headless_shell|chrome_crashpad_handler)(\s|$)/,
  esbuild: /(^|\/)esbuild$/,
  build_mjs: /(^|\s)build\.mjs(\s|$)/,
  gate_fast: /gate:fast|fleet-check|select-tests\.mjs/,
});

/**
 * Count processes by class over the WHOLE table (chrome-agent-platform-jvc0y: v1 counted only deno
 * and chrome, so a load1 of 20.79 on 2 vCPUs had no attribution — it was host steal, not our
 * children).
 *
 * Pure over already-parsed entries so a test never needs a live process table. Matching inspects
 * `args` first (the full command line) and falls back to `comm`.
 *
 * @param {{ pid?: number|string, comm?: string, args?: string, pcpu?: number }[]} entries
 */
export function classifyProcessEntries(entries) {
  const counts = { deno: 0, node: 0, python3: 0, chrome: 0, esbuild: 0, build_mjs: 0, gate_fast: 0 };
  let top = null;
  for (const entry of Array.isArray(entries) ? entries : []) {
    const haystack = `${entry?.args ?? ""} ${entry?.comm ?? ""}`.trim();
    if (!haystack) continue;
    for (const [name, re] of Object.entries(CLASS_MATCHERS)) {
      // A process matches at most one class: the most specific name wins by list order.
      if (re.test(entry?.args ?? "") || re.test(String(entry?.comm ?? ""))) {
        counts[name] += 1;
        break;
      }
    }
    const pcpu = Number(entry?.pcpu ?? 0);
    if (Number.isFinite(pcpu) && (!top || pcpu > top.pcpu)) {
      top = { pcpu, command: String(entry?.args ?? entry?.comm ?? "").slice(0, 80) };
    }
  }
  return {
    counts,
    totalProcs: Array.isArray(entries) ? entries.length : 0,
    top: top ? top.command : "",
    topPcpu: top ? top.pcpu : 0,
  };
}

/**
 * Read the live process table from a /proc root. Every entry is (comm, cmdline, and pcpu when the
 * kernel provides it); nothing shells out, so the v1 `pgrep -c` corruption cannot recur.
 * @param {string} [procRoot]
 */
export function readProcessTable(procRoot = "/proc") {
  const entries = [];
  let names = [];
  try {
    names = readdirSync(procRoot);
  } catch {
    return entries;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const dir = join(procRoot, name);
    try {
      const stat = readFileSync(join(dir, "stat"), "utf8");
      // /proc/<pid>/stat: "pid (comm) state ppid ... utime(14) stime(15) ..."
      const close = stat.lastIndexOf(")");
      const comm = close > 0 ? stat.slice(stat.indexOf("(") + 1, close) : "";
      const rest = stat.slice(close + 2).trim().split(/\s+/);
      const utime = Number(rest[11] ?? 0);
      const stime = Number(rest[12] ?? 0);
      let args = "";
      try {
        args = readFileSync(join(dir, "cmdline"), "utf8").replaceAll("\0", " ").trim();
      } catch {
        args = "";
      }
      // pcpu is deliberately NOT derived here: converting jiffies needs a sampling interval and the
      // total CPU count, and a wrong denominator would be worse than no top-CPU attribution. Used
      // only for choosing the busiest command, so cumulative jiffies are a fine proxy.
      entries.push({ pid: Number(name), comm, args: args || comm, pcpu: utime + stime });
    } catch {
      // A process can exit between readdir and read; that is not an error.
    }
  }
  return entries;
}

/**
 * One sample as an object. `valid` is false when the counters could not produce a percentage.
 * @param {{ ts: number, prev?: any, now?: any, load1?: number|null, pressure?: any, processes: any }} args
 * @returns {Record<string, any>}
 */
export function createSample({ ts, prev, now, load1, pressure, processes }) {
  const base = {
    ts,
    load1: load1 ?? null,
    psi_some: pressure?.someAvg10 ?? null,
    psi_full: pressure?.fullAvg10 ?? null,
    ...processes,
  };
  if (!now?.ok) return { ...base, steal_pct: null, valid: false, invalid_reason: now?.reason ?? "unreadable /proc/stat" };
  if (!prev?.ok) return { ...base, steal_pct: null, valid: false, invalid_reason: prev?.reason ?? "no previous counters" };
  const totalDelta = now.total - prev.total;
  const stealDelta = now.steal - prev.steal;
  // A counter that goes backwards is a reset or a wrap, not a measurement — name it before the
  // "did not advance" case, or a rebooting box reads as an idle one.
  if (stealDelta < 0 || (totalDelta > 0 && stealDelta > totalDelta)) {
    return { ...base, steal_pct: null, valid: false, invalid_reason: "steal counter moved outside the interval" };
  }
  if (!(totalDelta > 0)) return { ...base, steal_pct: null, valid: false, invalid_reason: "cpu counters did not advance" };
  return { ...base, steal_pct: (100 * stealDelta) / totalDelta, valid: true, invalid_reason: null };
}

/** ONE line per sample, always. The v1 multi-line corruption is prevented here, not by convention. */
export function formatSampleRow(sample) {
  const row = [
    sample.ts,
    sample.valid ? sample.steal_pct.toFixed(2) : "NA",
    sample.load1 === null ? "NA" : sample.load1.toFixed(2),
    sample.psi_some === null ? "NA" : sample.psi_some.toFixed(2),
    sample.counts.deno,
    sample.counts.node,
    sample.counts.python3,
    sample.counts.chrome,
    sample.counts.esbuild,
    sample.counts.build_mjs,
    sample.counts.gate_fast,
    sample.totalProcs,
    sample.valid ? 1 : 0,
    String(sample.top ?? "").replaceAll("\t", " ").replaceAll("\n", " "),
  ].join("\t");
  if (row.includes("\n")) throw new Error("cpu-steal-sampler: a sample row must be a single line");
  return row;
}

export const SAMPLE_HEADER = [
  "ts",
  "steal_pct",
  "load1",
  "psi_some",
  "deno",
  "node",
  "python3",
  "chrome",
  "esbuild",
  "build_mjs",
  "gate_fast",
  "total_procs",
  "valid",
  "top",
].join("\t");

/**
 * Create a sampler bound to a /proc root. `readFile`/`now`/`sleep` are injectable so tests drive it
 * with fake /proc content and never touch the machine.
 */
/**
 * @param {{ procRoot?: string, intervalMs?: number, readFile?: (path: string) => string,
 *   now?: () => number, sink?: (line: string, sample: Record<string, any>) => void }} [options]
 */
export function createSampler({
  procRoot = "/proc",
  intervalMs = DEFAULT_INTERVAL_MS,
  readFile = (path) => readFileSync(path, "utf8"),
  now = () => Date.now(),
  sink = () => {},
} = {}) {
  let prev = null;
  let samples = 0;
  const readCounters = () => parseCpuStat(safeRead(readFile, join(procRoot, "stat")));
  return {
    /**
     * Read the counters WITHOUT logging a row, so the first logged sample is a real delta instead of
     * a known-invalid one. A phase whose only sample is the priming read would otherwise classify as
     * UNKNOWN for a reason that is our bookkeeping, not the machine's behaviour.
     */
    prime() {
      prev = readCounters();
      return prev;
    },
    /** Take one sample, write it to the sink, return it. */
    sample({ mark = "" } = {}) {
      const ts = now();
      const current = readCounters();
      const load1 = parseLoad1(safeRead(readFile, join(procRoot, "loadavg")));
      const pressure = parsePressureCpu(safeRead(readFile, join(procRoot, "pressure", "cpu")));
      const processes = classifyProcessEntries(readProcessTable(procRoot));
      const sample = createSample({ ts, prev, now: current, load1, pressure, processes });
      prev = current;
      samples += 1;
      sink(mark ? `${formatSampleRow(sample)}\tmarker=${mark}` : formatSampleRow(sample), sample);
      return sample;
    },
    get samples() {
      return samples;
    },
  };
}

function safeRead(readFile, path) {
  try {
    return readFile(path);
  } catch {
    return "";
  }
}

/**
 * Classify a run's timing from its samples and phase boundaries (chrome-agent-platform-jvc0y's
 * contract, applied by tu8w9):
 *
 *   TIMING_UNMEASURED — any VALID sample overlapping a timed phase is at or above the threshold.
 *                       The raw suite result is retained, but a duration from this run is not
 *                       evidence of performance.
 *   UNKNOWN           — the samples cannot support a claim: none inside a timed phase, a gap longer
 *                       than MAX_GAP_INTERVALS, or every overlapping sample invalid. Missing data
 *                       NEVER authorises an exception.
 *   TIMING_MEASURED   — every overlapping sample is valid and below the threshold, and the caller
 *                       says the timed suites passed.
 *
 * @param {{ ts: number, steal_pct: number|null, valid: boolean, invalid_reason?: string }[]} samples
 * @param {{ name: string, startedAt: number, finishedAt: number }[]} phases
 * @param {{ thresholdPct?: number, intervalMs?: number, timedSuitesPassed?: boolean }} [options]
 */
export function classifyTiming(samples, phases = [], { thresholdPct = STEAL_THRESHOLD_PCT, intervalMs = DEFAULT_INTERVAL_MS, timedSuitesPassed = true } = /** @type {any} */ ({})) {
  const rows = Array.isArray(samples) ? samples : [];
  const overlapping = [];
  const gaps = [];
  for (const phase of phases) {
    const inside = rows.filter((row) => row.ts >= phase.startedAt && row.ts <= phase.finishedAt);
    if (inside.length === 0) {
      gaps.push({ phase: phase.name, reason: "no samples inside the phase" });
      continue;
    }
    for (let i = 1; i < inside.length; i += 1) {
      const delta = inside[i].ts - inside[i - 1].ts;
      if (delta > intervalMs * MAX_GAP_INTERVALS) gaps.push({ phase: phase.name, reason: `gap of ${delta}ms`, at: inside[i].ts });
    }
    overlapping.push(...inside.map((row) => ({ ...row, phase: phase.name })));
  }
  const valid = overlapping.filter((row) => row.valid);
  const invalid = overlapping.filter((row) => !row.valid);
  const stealValues = valid.map((row) => row.steal_pct).filter((value) => Number.isFinite(value));
  const maxStealPct = stealValues.length ? Math.max(...stealValues) : null;
  const stolen = stealValues.filter((value) => value >= thresholdPct);

  const summary = {
    samples: rows.length,
    overlappingSamples: overlapping.length,
    validSamples: valid.length,
    invalidSamples: invalid.length,
    maxStealPct,
    thresholdPct,
    peakPhase: null,
    gaps,
    stolenSampleCount: stolen.length,
    verdict: "UNKNOWN",
    reason: "",
  };
  if (maxStealPct !== null) {
    const peak = valid.find((row) => row.steal_pct === maxStealPct);
    summary.peakPhase = peak ? peak.phase : null;
  }
  if (phases.length === 0) {
    return { ...summary, reason: "no timed phase was declared, so no duration can be classified" };
  }
  if (gaps.some((gap) => gap.reason === "no samples inside the phase")) {
    return { ...summary, reason: "a timed phase has no samples at all; missing data cannot authorise an exception" };
  }
  if (valid.length === 0) {
    const why = invalid.length ? `every overlapping sample was invalid (${invalid[0].invalid_reason})` : "no valid samples";
    return { ...summary, reason: why };
  }
  if (stolen.length > 0) {
    return {
      ...summary,
      verdict: "TIMING_UNMEASURED",
      reason: `${stolen.length}/${valid.length} valid sample(s) inside a timed phase measured >= ${thresholdPct}% steal (peak ${maxStealPct.toFixed(1)}% in ${summary.peakPhase}); durations from this run are not evidence`,
    };
  }
  if (gaps.length > 0) {
    return { ...summary, reason: `sampling gaps inside a timed phase (${gaps[0].reason}); coverage is incomplete` };
  }
  if (!timedSuitesPassed) {
    return { ...summary, reason: "steal stayed below the threshold but a timed suite did not pass, so timing is not measured green" };
  }
  return {
    ...summary,
    verdict: "TIMING_MEASURED",
    reason: `${valid.length} valid sample(s) inside timed phases stayed below ${thresholdPct}% steal (peak ${maxStealPct.toFixed(1)}%)`,
  };
}

/** Append-only writer: open once, write header once, one row per sample, fsync each row. */
export function openSampleLog(path, { ramBacked = isRamBacked } = /** @type {any} */ ({})) {
  // The durable-root rule bans evidence on RAM-backed tmpfs (bead chp) — and it already knows which
  // mounts those are (mount table, not a path prefix), so this asks it instead of guessing at "/tmp":
  // a sampler log that a reboot eats is exactly how a contention argument gets lost.
  if (ramBacked(dirname(path)) || ramBacked(path)) {
    throw new Error(`cpu-steal-sampler: refusing a RAM-backed sample log path (${path}) — use the durable root`);
  }
  mkdirSync(dirname(path), { recursive: true });
  const fresh = !existsSync(path);
  const fd = openSync(path, "a");
  if (fresh) writeSync(fd, `${SAMPLE_HEADER}\n`);
  return {
    write(line) {
      writeSync(fd, `${line}\n`);
    },
    close() {
      closeSync(fd);
    },
    path,
  };
}
