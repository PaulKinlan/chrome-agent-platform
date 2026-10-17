// tests/qo3u8-fail-closed-tradeoffs.test.ts — the two macOS fail-closed trade-offs jjsz
// left undocumented-by-decision (chrome-agent-platform-qo3u8), decided here:
//
//  (a) A TRANSIENT `ps` failure at custody's final residue check used to exit 70 on its own.
//      DECISION: retry the identity read a bounded 3 times, 100 ms apart, and keep exit 70 when
//      every attempt is unreadable. A hiccup is not evidence of residue; a persistent failure is.
//  (b) A live build-lock owner recorded BEFORE the PS_ENV pin holds the inherited locale's start
//      text, which the canonical reader cannot compare, so it read as "a different process" and the
//      lock was stealable ONCE at the upgrade. DECISION: a start that is not in a canonical,
//      comparable form is UNKNOWN, not DIFFERENT — "cannot prove reuse" is already the rule the
//      file applies to `start: null`, and stealing a live build's lock is the damage the header
//      documents. Linux `/proc` ticks and canonical `ps` text still compare exactly as before.
//
// Every case here is a seam test with canned reads: macOS itself is not executed, and the trade-off
// is a DECISION about verdicts, which is what these seams decide.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  ProcessGoneError,
  RESIDUE_READ_ATTEMPTS,
  RESIDUE_READ_RETRY_MS,
  liveObservedResidue,
} from "../scripts/security-suite-custody.mjs";
import {
  PS_START_BASIS,
  buildOwnerIdentity,
  comparableStart,
  holderIsDead,
  machineBootId,
} from "../scripts/lib/build-lock.mjs";

const OBSERVED = new Map([[4321, { pid: 4321, starttime: "900", uid: 501, pgid: 4321, sid: 4321 }]]);
const CURRENT = { pid: 4321, starttime: "900", uid: 501, state: "S", pgid: 4321, sid: 4321 };
const noSleep = () => Promise.resolve();

Deno.test("qo3u8(a): a transient residue-read failure is retried, and the VERDICT comes from the read", async () => {
  // Two unreadable attempts, then the truth. Without the retry the first failure decides: an
  // UNVERIFIED row -> exit 70. With it, the successful read decides, in both directions.
  const transient = () => [
    Object.assign(new Error("ps EAGAIN"), { code: "EAGAIN" }),
    Object.assign(new Error("ps EAGAIN"), { code: "EAGAIN" }),
  ];

  // (i) the retried read shows a DIFFERENT process on that pid: the descendant is gone, so clean.
  const reused = transient();
  let calls = 0;
  const goneResidue = await liveObservedResidue(OBSERVED, {
    readIdentity: () => {
      calls += 1;
      const failure = reused.shift();
      return failure ? Promise.reject(failure) : Promise.resolve({ ...CURRENT, starttime: "901" });
    },
    sleep: noSleep,
  });
  assertEquals(calls, 3, "a transient failure must be re-read, not decided on the first attempt");
  assertEquals(goneResidue.length, 0, "the successful read proves the descendant is gone — clean");

  // (ii) the retried read shows the SAME live process: verified residue, and NOT unverified. The
  // distinction matters because `unverified` is what makes the receipt read as "cannot confirm".
  const live = transient();
  const liveResidue = await liveObservedResidue(OBSERVED, {
    readIdentity: () => {
      const failure = live.shift();
      return failure ? Promise.reject(failure) : Promise.resolve(CURRENT);
    },
    sleep: noSleep,
  });
  assertEquals(liveResidue.length, 1, "a live descendant is residue");
  assertEquals(liveResidue[0]?.unverified, undefined, "a read that succeeded is a VERIFIED observation");
});

Deno.test("qo3u8(a): a PERSISTENT unreadable failure still fails closed, and the reason is kept", async () => {
  let calls = 0;
  const residue = await liveObservedResidue(OBSERVED, {
    readIdentity: () => {
      calls += 1;
      return Promise.reject(Object.assign(new Error("ps: cannot read process table"), { code: "EPERM" }));
    },
    sleep: noSleep,
  });
  assertEquals(calls, RESIDUE_READ_ATTEMPTS, "every bounded attempt is spent before declaring unverified");
  assertEquals(residue.length, 1, "an unreadable observation is never proof that the pid exited");
  assertEquals(residue[0]?.unverified, true);
  assert(
    String(residue[0]?.unverifiedReason).includes("cannot read process table"),
    `the bounded reason must survive the retries; got ${residue[0]?.unverifiedReason}`,
  );
});

Deno.test("qo3u8(a): a GONE verdict is an answer, so it is not retried", async () => {
  let calls = 0;
  const residue = await liveObservedResidue(OBSERVED, {
    readIdentity: () => {
      calls += 1;
      return Promise.reject(new ProcessGoneError(4321));
    },
    sleep: noSleep,
  });
  assertEquals(calls, 1, "re-asking a proven absence would only repeat it");
  assertEquals(residue.length, 0, "gone is clean");
});

Deno.test("qo3u8(b): a pre-upgrade locale start is UNKNOWN, so a live holder is not stealable", async () => {
  // Recorded by a build that predates the PS_ENV pin (en_GB / fr_FR shapes measured on macOS 15.8);
  // the live reader now returns the canonical C-locale text for the SAME process.
  for (const recorded of ["Wed  7 Oct 12:10:01 2026", "Mer  7 oct 12:10:01 2026", "Mi  7 Okt 12:10:01 2026"]) {
    const dead = await holderIsDead(
      { pid: 4321, start: recorded, boot: machineBootId() },
      { kill: () => {}, procStat: () => ({ ok: true, state: "S", start: "Wed Oct 7 12:10:01 2026" }) },
    );
    assertEquals(dead, false, `a start we cannot compare must stay ALIVE, not stealable: ${recorded}`);
  }
});

Deno.test("qo3u8(b)/khkqz: a C-locale LOCAL-ZONE pre-pin start is not stealable, however canonical it looks", async () => {
  // The reviewer's repro (chrome-agent-platform-khkqz): the pre-upgrade writer did not pin the time
  // zone, so the SAME live macOS pid recorded `Wed Oct 7 13:10:01 2026` under a C locale in
  // Europe/London and reads now as `Wed Oct 7 12:10:01 2026` under PS_ENV (TZ=UTC). Both strings have
  // the canonical shape, so SHAPE was never evidence: the PRE-UPGRADE lock carries no basis marker,
  // which is what makes it UNKNOWN. A shape-only rule fails this case, which is why it is here.
  const stolen = await holderIsDead(
    { pid: 4321, start: "Wed Oct 7 13:10:01 2026", boot: machineBootId() },
    { kill: () => {}, procStat: () => ({ ok: true, state: "S", start: "Wed Oct 7 12:10:01 2026" }) },
  );
  assertEquals(stolen, false, "a pre-pin start has no provenance marker — UNKNOWN, not pid reuse");
});

Deno.test("qo3u8(b)/khkqz: LOCKS WRITTEN BY THIS WRITER still prove pid reuse", async () => {
  // Marked, i.e. written after the provenance field exists — the comparison resumes.
  const ticksReused = await holderIsDead(
    { pid: 4321, start: "900", boot: machineBootId() },
    { kill: () => {}, procStat: () => ({ ok: true, state: "S", start: "901" }) },
  );
  assertEquals(ticksReused, true, "a changed /proc starttime is pid reuse — stealing is correct");

  const psReused = await holderIsDead(
    { pid: 4321, start: "Wed Oct 7 12:10:01 2026", startBasis: PS_START_BASIS, boot: machineBootId() },
    { kill: () => {}, procStat: () => ({ ok: true, state: "S", start: "Wed Oct 7 12:10:02 2026" }) },
  );
  assertEquals(psReused, true, "a changed ps start on a marked lock is pid reuse");

  const sameProcess = await holderIsDead(
    { pid: 4321, start: "Wed Oct 7 12:10:01 2026", startBasis: PS_START_BASIS, boot: machineBootId() },
    { kill: () => {}, procStat: () => ({ ok: true, state: "S", start: "Wed Oct 7 12:10:01 2026" }) },
  );
  assertEquals(sameProcess, false, "the same start is the same process — not stealable");
});

Deno.test("qo3u8(b)/khkqz: this writer RECORDS the provenance its start came from", () => {
  // Without this, every lock this writer creates would be UNKNOWN to the next reader and a genuinely
  // dead holder would never be reclaimed. On Linux the /proc branch is the one that runs.
  const identity = buildOwnerIdentity();
  assertEquals(identity.startBasis, "proc-stat-22");
  assertEquals(typeof identity.start, "string");
});

Deno.test("qo3u8(b)/khkqz: comparableStart requires a REPRODUCIBLE basis, not just the right shape", () => {
  assertEquals(comparableStart("1759800000"), "1759800000"); // kernel ticks: environment-free
  assertEquals(comparableStart("1759800000", "proc-stat-22"), "1759800000");
  assertEquals(
    comparableStart("Wed Oct 7 12:10:01 2026", PS_START_BASIS),
    "Wed Oct 7 12:10:01 2026",
    "a marked ps start is comparable",
  );
  // THE khkqz CASE: canonical SHAPE with no marker is NOT comparable — a pre-pin C-locale local-zone
  // string looks exactly like this.
  assertEquals(comparableStart("Wed Oct 7 12:10:01 2026"), null);
  assertEquals(comparableStart("Wed  7 Oct 12:10:01 2026"), null); // en_GB pre-pin
  assertEquals(comparableStart("Mer  7 oct 12:10:01 2026"), null); // fr_FR pre-pin
  assertEquals(comparableStart("", PS_START_BASIS), null);
  assertEquals(comparableStart(null), null);
  assertEquals(comparableStart(undefined), null);
});

Deno.test("qo3u8(a): the retry budget is bounded and short enough to keep exit 70 prompt", () => {
  // Pinned as VALUES, not inferred: the bead's decision was "for example 3 tries, 100 ms apart", and
  // an accidental 30-try or 5 s retry would turn a hung table into a stalled gate instead of a verdict.
  assertEquals(RESIDUE_READ_ATTEMPTS, 3);
  assertEquals(RESIDUE_READ_RETRY_MS, 100);
  assert(
    (RESIDUE_READ_ATTEMPTS - 1) * RESIDUE_READ_RETRY_MS <= 500,
    "the whole retry budget must stay well under a second",
  );
});
