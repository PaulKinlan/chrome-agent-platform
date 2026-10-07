// scripts/lib/build-once-record.mjs — the ONE writer of the build-once record (bead
// chrome-agent-platform-jjsz, round-2 review N1).
//
// The record says "this build exited 0". tests/fixtures/build-once.mjs trusts it so a later serial
// test file (build-smoke, store-doc-denial) reuses this build's captured output instead of paying for
// another build. A record written for a build that did NOT exit 0 lets build-smoke pass a failed
// build — the P1 this module exists to prevent. Two decisions follow:
//
//   * The strict gate (shouldRecordBuild) lives INSIDE the writer, not at its call site, where one
//     edited argument or one swapped operator weakens it without any test noticing. build.mjs passes
//     the live values and cannot skip the gate.
//   * The writer is a plain function so its behaviour is pinned by EXECUTION (a table over record x
//     buildSucceeded x exitCode against real files: tests/build-once-record.test.ts), and the call
//     site in build.mjs is pinned structurally (tests/build-parallel-discipline.test.ts, rule B).
//
// Nothing is touched on disk — not even the directory — unless every check passes. An fs failure is
// NON-FATAL cache population (a record we cannot write only costs a later rebuild), never a throw.
//
// Plain ESM shared by node (build.mjs) and deno (the tests).
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { shouldRecordBuild } from "../changelog-delta.mjs";
import { durableRoot } from "./durable-root.mjs";

/** The record directory under the durable root; tests/fixtures/build-once.mjs reads from the same name. */
export const BUILD_ONCE_RECORD_DIR_NAME = "serial-build-once";

/**
 * A record key becomes a file name (`<key>.json`), so it must be one path segment: it starts with a
 * letter or digit and then allows letters, digits, `.`, `_` and `-`. In practice it is
 * `<commit>-<source digest>`. `../x`, `a/b`, ``, `.` and `..` are all refused.
 */
const RECORD_KEY = /^[0-9A-Za-z][0-9A-Za-z._-]*$/;

/**
 * Write `<recordDir>/<record.key>.json` as `{ code: 0, stdout, at }` — the shape the fixture reads —
 * but ONLY for a record of a build that exited 0.
 *
 *   record null / undefined                         -> { written: false, reason: "no-record" }
 *   build did not succeed or exitCode is not 0      -> { written: false, reason: "build-did-not-exit-0" }
 *     (strictly: buildSucceeded === true and exitCode is the number 0; see shouldRecordBuild)
 *   key not a safe file name, or stdout not a string -> { written: false, reason: "invalid-record" }
 *   any fs (or clock) failure while writing          -> { written: false, reason: "write-failed" }
 *   otherwise                                       -> { written: true,  reason: "written" }
 *
 * @param {object} args
 * @param {{ key: string, stdout: string } | null | undefined} args.record
 * @param {boolean} args.buildSucceeded
 * @param {number} args.exitCode
 * @param {string | null} [args.recordDir] defaults to `<durable root>/serial-build-once`
 * @param {() => Date} [args.now]
 * @returns {Promise<{ written: boolean, reason: string }>}
 */
export async function writeBuildOnceRecord({
  record,
  buildSucceeded,
  exitCode,
  recordDir = null,
  now = () => new Date(),
} = {}) {
  const hasRecord = record !== null && record !== undefined;
  if (!(hasRecord && shouldRecordBuild({ buildSucceeded, exitCode }))) {
    return { written: false, reason: hasRecord ? "build-did-not-exit-0" : "no-record" };
  }
  if (typeof record.key !== "string" || !RECORD_KEY.test(record.key) || typeof record.stdout !== "string") {
    return { written: false, reason: "invalid-record" };
  }
  try {
    // Everything that can throw without touching the disk comes first, so a failure here leaves
    // no directory behind either.
    const body = JSON.stringify({ code: 0, stdout: record.stdout, at: now().toISOString() });
    const dir = recordDir ?? join(durableRoot(), BUILD_ONCE_RECORD_DIR_NAME);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${record.key}.json`), body);
    return { written: true, reason: "written" };
  } catch {
    return { written: false, reason: "write-failed" };
  }
}
