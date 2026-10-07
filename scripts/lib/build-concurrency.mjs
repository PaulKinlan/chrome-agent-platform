// scripts/lib/build-concurrency.mjs — the two small policies the parallel build pipeline depends on
// (bead chrome-agent-platform-jjsz), extracted so each is unit-testable: build.mjs is a script, so
// importing it RUNS a build. Plain ESM with no imports, shared by node (build.mjs,
// package-archive.mjs) and deno (the tests).

/**
 * Run every task to completion — success OR failure — and only then report.
 *
 * `Promise.all` rejects as soon as ONE task rejects while its siblings keep running. The build fans
 * bundling, scrubbing and staging out into a private staging directory, and its failure path then
 * removes that directory. With `Promise.all`, a sibling still writing under it can (1) make the
 * staging cleanup itself fail (ENOTEMPTY while a file is being created), whose FATAL replaces the
 * real cause, or (2) recreate files in a directory the rollback believes is gone and leave a partial
 * tree behind. Settling first lets every sibling quiesce before any rollback runs; the sequential
 * loops this replaced could never have had a sibling in flight.
 *
 * The FIRST rejection in DECLARATION order is rethrown, so the reported cause does not depend on
 * which task happened to lose a race. Every later rejection goes to `reportSecondary` (stderr by
 * default) instead of being dropped, so a second independent failure is not invisible.
 *
 * Use it for any fan-out that WRITES somewhere a failure path removes. Read-only fan-outs may keep
 * `Promise.all`: an early reject leaves nothing on disk to race with.
 *
 * @template T
 * @param {Iterable<Promise<T> | T>} tasks tasks already started (or plain values)
 * @param {(reason: unknown, index: number) => void} [reportSecondary]
 * @returns {Promise<T[]>} the fulfilled values, in declaration order
 */
export async function settleAll(tasks, reportSecondary = defaultReportSecondary) {
  const settled = await Promise.allSettled(tasks);
  let first = null;
  settled.forEach((outcome, index) => {
    if (outcome.status !== "rejected") return;
    if (first === null) first = { reason: outcome.reason };
    else reportSecondary(outcome.reason, index);
  });
  if (first !== null) throw first.reason;
  return settled.map((outcome) => outcome.value);
}

function defaultReportSecondary(reason, index) {
  const detail = reason instanceof Error ? reason.message : String(reason);
  console.error(`build: parallel task #${index} also failed — ${detail}`);
}

/** The version-GC grace used when CAP_BUILD_GC_GRACE_MS is unset or unusable. */
export const DEFAULT_GC_GRACE_MS = 50;
/** An explicit grace is capped here: a typo must never stall every build for minutes. */
export const MAX_GC_GRACE_MS = 60_000;

/**
 * The delay (ms) between publishing the new version and garbage-collecting the old ones, from
 * `CAP_BUILD_GC_GRACE_MS`. The grace lets a reader that resolved the PREVIOUS `dist` link
 * mid-open finish (the pointer swap itself is atomic); it used to be a fixed 2000 ms on every
 * build, about half of a warm `build:production`. The default is now 50 ms.
 *
 *   unset / empty / whitespace            -> 50   (default)
 *   negative, NaN, non-numeric, +-Infinity -> 50   (a bad value is never read as "no grace")
 *   0                                     -> 0    (explicit: no grace at all)
 *   2000                                  -> 2000 (the previous behaviour)
 *   anything above 60000                  -> 60000
 *
 * @param {Record<string, string | undefined> | undefined} env
 * @returns {number}
 */
export function resolveGcGraceMs(env) {
  const raw = (env?.CAP_BUILD_GC_GRACE_MS ?? "").trim();
  const parsed = raw === "" ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.min(parsed, MAX_GC_GRACE_MS)
    : DEFAULT_GC_GRACE_MS;
}
