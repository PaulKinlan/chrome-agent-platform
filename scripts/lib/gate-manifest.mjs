// scripts/lib/gate-manifest.mjs — the gate's COVERAGE LEDGER writer (chrome-agent-platform-0eq00).
//
// WHY THIS EXISTS: the fleet gate consumer (~/fleet/remote/check-coverage.py) reads a gate log and
// reports which test suites ran and which changed files no executed suite placed. Without a marker it
// falls back to log heuristics, and a green FAST run could be recorded with `coverage ABSENT` or with
// `suites:[]` next to a non-empty unmapped list — an unreadable-green record that a strict consumer
// must refuse. A producer that names exactly what it executed is the prerequisite for that consumer
// (coord, 2026-10-14: producer-first sequencing).
//
// THE WIRE CONTRACT (must not drift from check-coverage.py):
//   fast-gate: manifest: {"tier":..,"executed":N,"executed_suites":[..],"selected":[..],"certifiable":true,..}
//   fast-gate: unmapped: <space-separated paths>
//   fast-gate: unknown: <reason the run cannot certify coverage>
// The extractor takes the LAST manifest line in a log, so a tier must emit exactly one, after its run.
// `executed` must be a COUNT of suites that positively ran: absent or <= 0 places nothing, and
// `certifiable: false` forces coverage PARTIAL (never KNOWN) at the consumer.
//
// This module is pure and dependency-free so both tier emitters (scripts/select-tests.mjs for the
// changed-file tier, scripts/run-tests.mjs for the full-suite tier) share one formatter.

export const GATE_MANIFEST_PREFIX = "fast-gate: manifest: ";
export const GATE_UNMAPPED_PREFIX = "fast-gate: unmapped: ";
export const GATE_UNKNOWN_PREFIX = "fast-gate: unknown: ";

/** Sorted, de-duplicated suite list — the consumer compares paths verbatim. */
export function normalizeSuiteList(files = []) {
  return [...new Set(files.map((f) => String(f).trim()).filter(Boolean))].sort();
}

/**
 * One manifest line. Throws rather than emitting a record that would read as a green run naming
 * nothing: `executed > 0` with no `executed_suites` is exactly the `suites:[]` lie the ledger exists
 * to prevent (chrome-agent-platform-0eq00 falsifier).
 *
 * @param {{
 *   tier: "fast" | "full",
 *   executed: number,
 *   executedSuites?: string[],
 *   selected?: string[],
 *   certifiable?: boolean,
 *   omitted?: Array<{ file: string, reason: string }>,
 *   unmapped?: string[],
 *   build?: { disposition: string, reason: string, secs: number, markerCommit?: string | null } | null,
 * }} fields
 * @returns {string}
 */
export function formatGateManifest({
  tier,
  executed,
  executedSuites = [],
  selected = [],
  certifiable = true,
  omitted = [],
  unmapped = [],
  build = null,
} = {}) {
  if (tier !== "fast" && tier !== "full") {
    throw new Error(`gate manifest: tier must be "fast" or "full", got ${JSON.stringify(tier)}`);
  }
  if (!Number.isInteger(executed) || executed < 0) {
    throw new Error(`gate manifest: executed must be a non-negative integer, got ${JSON.stringify(executed)}`);
  }
  const suites = normalizeSuiteList(executedSuites);
  if (executed > 0 && suites.length === 0) {
    throw new Error(
      "gate manifest: executed > 0 with no executed_suites is unreadable green (suites would be empty); " +
        "name the suites that ran or report executed: 0",
    );
  }
  if (suites.length > executed) {
    throw new Error(`gate manifest: ${suites.length} executed_suites exceeds executed ${executed}`);
  }
  const payload = {
    tier,
    executed,
    executed_suites: suites,
    selected: normalizeSuiteList(selected),
    certifiable: certifiable === true,
  };
  if (build) {
    payload.build = {
      disposition: build.disposition,
      reason: build.reason,
      secs: Math.round(Number(build.secs) || 0),
      marker_commit: build.markerCommit ?? null,
    };
  }
  const omittedList = omitted.filter((o) => o && o.file);
  if (omittedList.length) {
    payload.omitted = omittedList
      .map((o) => ({ file: String(o.file), reason: String(o.reason ?? "") }))
      .sort((a, b) => a.file.localeCompare(b.file, "en"));
  }
  const unmappedList = normalizeSuiteList(unmapped);
  if (unmappedList.length) payload.unmapped = unmappedList;
  return GATE_MANIFEST_PREFIX + JSON.stringify(payload);
}

/**
 * Read the build disposition a parent tier passed down (CAP_GATE_BUILD_JSON). Invalid or absent
 * input is `null`, never a guess: a malformed ledger entry must not be reported as a build decision.
 * @param {string | undefined | null} raw
 * @returns {{ disposition: string, reason: string, secs: number, markerCommit?: string | null } | null}
 */
export function parseGateBuild(raw) {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value.disposition !== "string") return null;
    return {
      disposition: value.disposition,
      reason: typeof value.reason === "string" ? value.reason : "",
      secs: Number(value.secs) || 0,
      markerCommit: value.markerCommit ?? null,
    };
  } catch {
    return null;
  }
}

/** `fast-gate: unmapped: a b c` — null when there is nothing to report. */
export function formatGateUnmapped(files = []) {
  const list = normalizeSuiteList(files);
  return list.length ? GATE_UNMAPPED_PREFIX + list.join(" ") : null;
}

/** `fast-gate: unknown: <reason>` — the run must not be read as KNOWN coverage. */
export function formatGateUnknown(reason) {
  const text = String(reason ?? "").trim();
  if (!text) throw new Error("gate manifest: an unknown marker needs a reason");
  return GATE_UNKNOWN_PREFIX + text;
}

/**
 * Write the ledger to a log. Everything goes to stderr so `--list` stdout stays a parseable file
 * list. Returns the lines written (for tests).
 * @param {{ manifest?: object | null, unmapped?: string[], unknown?: string | null, log?: (...a: any[]) => void }} args
 */
export function emitGateLedger({ manifest = null, unmapped = [], unknown = null, log = console.error } = {}) {
  const lines = [];
  if (manifest) lines.push(formatGateManifest(manifest));
  const unmappedLine = formatGateUnmapped(unmapped);
  if (unmappedLine) lines.push(unmappedLine);
  if (unknown) lines.push(formatGateUnknown(unknown));
  for (const line of lines) log(line);
  return lines;
}
