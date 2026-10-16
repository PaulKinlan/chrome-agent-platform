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
// This module is pure and shares only the selector's pure content policy, so both tier emitters
// (scripts/select-tests.mjs and scripts/run-tests.mjs) use one formatter without a dependency cycle.
import { isPassiveContentFile } from "./content-exemptions.mjs";

export const GATE_MANIFEST_PREFIX = "fast-gate: manifest: ";
export const GATE_UNMAPPED_PREFIX = "fast-gate: unmapped: ";
export const GATE_UNKNOWN_PREFIX = "fast-gate: unknown: ";

/** Sorted, de-duplicated suite list — the consumer compares paths verbatim. */
export function normalizeSuiteList(files = []) {
  return [...new Set(files.map((f) => String(f).trim()).filter(Boolean))].sort();
}

/** Explain actual suite placement without counting unrelated always-on tests as coverage.
 * Candidates come from the selector's reverse graph / exact mappings; executed_suites
 * comes only from the runner. The fleet's independent extractor may find additional
 * gaps, but this ledger never claims a selected or omitted suite actually ran.
 * @param {{changed?: string[], candidates?: Record<string, string[]>, executedSuites?: string[], omitted?: Array<{file: string, reason: string}>, unmappable?: Array<{file: string, mechanism: string}>}} args
 */
export function explainChangedFileMapping({ changed = [], candidates = {}, executedSuites = [], omitted = [], unmappable = [] } = {}) {
  const ran = new Set(executedSuites);
  const omittedByFile = new Map(omitted.map(({ file, reason }) => [file, reason]));
  const unmappableByFile = new Map(unmappable.map(({ file, mechanism }) => [file, mechanism]));
  return normalizeSuiteList(changed).map((file) => {
    if (file.startsWith(".beads/") || isPassiveContentFile(file)) {
      return { file, status: "not-applicable", executed_suites: [], reason: "content or Beads metadata; no executable suite required" };
    }
    // An explicitly fail-closed path cannot certify its own subset, even if a
    // suite happens to import it. Full execution is not selector authority.
    const failClosedReason = unmappableByFile.get(file);
    if (failClosedReason) {
      return { file, status: "unmapped", executed_suites: [], reason: failClosedReason };
    }
    const reachable = normalizeSuiteList(candidates[file] ?? []);
    const executed = reachable.filter((suite) => ran.has(suite));
    if (executed.length) {
      return { file, status: "mapped", executed_suites: executed, reason: "reachable inspecting suite executed" };
    }
    const omittedReason = reachable.map((suite) => omittedByFile.get(suite)).filter(Boolean);
    const reason = omittedReason.length ? `reachable suite not run: ${omittedReason.join("; ")}`
      : reachable.length ? `reachable suite(s) not executed: ${reachable.join(", ")}`
      : "no executable inspecting suite is reachable from this changed path";
    return { file, status: "unmapped", executed_suites: [], reason };
  });
}

/**
 * One manifest line. Throws rather than emitting a record that would read as a green run naming
 * nothing: `executed > 0` with no `executed_suites` is exactly the `suites:[]` lie the ledger exists
 * to prevent (chrome-agent-platform-0eq00 falsifier).
 *
 * Omission disclosure (review P1-A, 2026-10-14): every suite a tier did NOT run must appear in
 * `omitted` WITH a reason. An entry without a reason is refused, because "omitted, cause unknown" is
 * the silent skip the ledger exists to prevent. `omittedTruncated` exists only as a bound on a
 * pathological population and always reports how many entries were dropped.
 *
 * @param {{
 *   tier: "fast" | "full",
 *   executed: number,
 *   executedSuites?: string[],
 *   selected?: string[],
 *   certifiable?: boolean,
 *   omitted?: Array<{ file: string, reason: string }>,
 *   omittedTotal?: number,
 *   omittedTruncated?: number,
 *   unmapped?: string[],
 *   fileMapping?: Array<{ file: string, status: string, executed_suites: string[], reason: string }>,
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
  omittedTotal = 0,
  omittedTruncated = 0,
  unmapped = [],
  fileMapping = [],
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
  const named = omitted
    .filter((o) => o && o.file)
    .map((o) => ({ file: String(o.file), reason: String(o.reason ?? "").trim() }))
    .sort((a, b) => a.file.localeCompare(b.file, "en"));
  for (const entry of named) {
    if (!entry.reason) {
      throw new Error(
        `gate manifest: omitted suite ${entry.file} has no reason; an undisclosed omission is the ` +
          `silent skip this ledger exists to prevent`,
      );
    }
  }
  const total = Math.max(Number(omittedTotal) || 0, named.length + Math.max(0, Number(omittedTruncated) || 0));
  if (total > 0 && named.length === 0) {
    // A bound must never be allowed to erase the disclosure itself.
    throw new Error(
      `gate manifest: ${total} omitted suite(s) with no named entry and no reason would be a silent skip`,
    );
  }
  if (named.length) payload.omitted = named;
  if (total > 0) payload.omitted_total = total;
  if (Number.isInteger(omittedTruncated) && omittedTruncated > 0) {
    payload.omitted_truncated = omittedTruncated;
  }
  const unmappedList = normalizeSuiteList(unmapped);
  if (unmappedList.length) payload.unmapped = unmappedList;
  if (fileMapping.length) {
    for (const row of fileMapping) {
      if (!row.file || !["mapped", "unmapped", "not-applicable"].includes(row.status) || !row.reason?.trim() ||
          (row.status === "mapped" && !row.executed_suites?.length) ||
          (row.status !== "mapped" && row.executed_suites?.length)) {
        throw new Error(`gate manifest: invalid reasoned changed-file placement: ${JSON.stringify(row)}`);
      }
    }
    payload.file_mapping = fileMapping;
  }
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

/**
 * How a deferred suite's reason is worded, per tier (review P1-B, 2026-10-14). These are separate on
 * purpose: a build-behaviour file DOES run in the same
 * FULL command (its `npm run test:build` stage), while a heavy file is NOT part of the FULL gate
 * command at all. One shared sentence covering both was a false statement about the heavy files.
 */
export const BUILD_GATE_DEFERRAL_SUFFIX =
  "also runs in this FULL command's npm run test:build stage";
export const HEAVY_GATE_DEFERRAL_SUFFIX =
  "NOT part of the FULL gate command; runs only under the separate npm run test:heavy tier";

/**
 * `[{file, reason}]` for every suite deferred to another tier, built from that tier's own reason table
 * (scripts/test-partition.mjs) so the ledger never invents a cause.
 */
export function deferredTierEntries({
  buildGateFiles = [],
  buildGateReasons = {},
  heavyGateFiles = [],
  heavyGateReasons = {},
} = {}) {
  const entries = [
    ...buildGateFiles.map((file) => ({
      file,
      reason: `${buildGateReasons[file] ?? "deferred to the build-behaviour tier"} — ${BUILD_GATE_DEFERRAL_SUFFIX}`,
    })),
    ...heavyGateFiles.map((file) => ({
      file,
      reason: `${heavyGateReasons[file] ?? "deferred to the heavy tier"} — ${HEAVY_GATE_DEFERRAL_SUFFIX}`,
    })),
  ];
  return entries.sort((a, b) => a.file.localeCompare(b.file, "en"));
}

/**
 * The FULL tier's manifest fields, computed from what the runner actually did (chrome-agent-platform-
 * 0eq00). Pure so the arithmetic and the disclosure of DEFERRED files are unit-tested: the full suite
 * is the merger's gate, so an implementer can never exercise this path by running it.
 *
 * `rc !== 0` reports `executed: 0` with `certifiable: false` rather than naming suites whose result the
 * run cannot certify — the consumer reads `certifiable: false` as PARTIAL coverage, never KNOWN.
 *
 * `deferred` carries ONE reason per file from the tier that owns it (review P1-B): a build-behaviour
 * file runs later in the SAME FULL command (`test:build`), while a heavy file is NOT part of that
 * command at all (`test:heavy` is a separate tier) — one shared wording for both would be a false
 * statement about the heavy files.
 *
 * @param {{
 *   serialFiles?: string[], parallelFiles?: string[], skippedFiles?: string[],
 *   deferred?: Array<{ file: string, reason: string }>, rc: number, cliFiles?: string[],
 *   build?: object | null, fileMappingContext?: object | null,
 * }} args
 * @returns {object | null} null when this was not the default `npm test` form (no gate record)
 */
export function fullTierManifestFields({
  serialFiles = [],
  parallelFiles = [],
  skippedFiles = [],
  deferred = [],
  rc,
  cliFiles = [],
  build = null,
  fileMappingContext = null,
} = {}) {
  if (cliFiles.length > 0) return null;
  const executedSuites = [...serialFiles, ...parallelFiles];
  const omitted = [
    ...deferred.map((entry) => ({ file: entry.file, reason: entry.reason })),
    ...skippedFiles.map((file) => ({ file, reason: "skipped in this run: the serial phase failed" })),
  ];
  return {
    tier: "full",
    executed: rc === 0 ? executedSuites.length : 0,
    executedSuites: rc === 0 ? executedSuites : [],
    selected: executedSuites,
    certifiable: rc === 0,
    build,
    omitted,
    omittedTotal: omitted.length,
    ...(fileMappingContext ? { fileMapping: explainChangedFileMapping({
      ...fileMappingContext, executedSuites: rc === 0 ? executedSuites : [], omitted,
    }) } : {}),
  };
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
 * @param {{ manifest?: object | null, unmapped?: string[], fileMapping?: Array<{file: string, status: string, reason: string}>, unknown?: string | null, log?: (...a: any[]) => void }} args
 */
export function emitGateLedger({ manifest = null, unmapped = [], fileMapping = [], unknown = null, log = console.error } = {}) {
  const lines = [];
  if (manifest) lines.push(formatGateManifest(manifest));
  const missing = fileMapping.filter((row) => row.status === "unmapped");
  const unmappedLine = formatGateUnmapped([...unmapped, ...missing.map((row) => row.file)]);
  if (unmappedLine) lines.push(unmappedLine);
  for (const row of missing) lines.push(`fast-gate: unmapped-reason: ${JSON.stringify({ file: row.file, reason: row.reason })}`);
  if (unknown) lines.push(formatGateUnknown(unknown));
  for (const line of lines) log(line);
  return lines;
}
