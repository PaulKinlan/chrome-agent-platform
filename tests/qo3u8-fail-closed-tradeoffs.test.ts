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
import { comparableStart, holderIsDead, machineBootId } from "../scripts/lib/build-lock.mjs";

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

Deno.test("qo3u8(b): comparable starts still prove pid reuse — Linux ticks and canonical ps text", async () => {
  const ticksReused = await holderIsDead(
    { pid: 4321, start: "900", boot: machineBootId() },
    { kill: () => {}, procStat: () => ({ ok: true, state: "S", start: "901" }) },
  );
  assertEquals(ticksReused, true, "a changed /proc starttime is pid reuse — stealing is correct");

  const psReused = await holderIsDead(
    { pid: 4321, start: "Wed Oct 7 12:10:01 2026", boot: machineBootId() },
    { kill: () => {}, procStat: () => ({ ok: true, state: "S", start: "Wed Oct 7 12:10:02 2026" }) },
  );
  assertEquals(psReused, true, "a changed canonical ps start is pid reuse — stealing is correct");

  const sameProcess = await holderIsDead(
    { pid: 4321, start: "Wed Oct 7 12:10:01 2026", boot: machineBootId() },
    { kill: () => {}, procStat: () => ({ ok: true, state: "S", start: "Wed Oct 7 12:10:01 2026" }) },
  );
  assertEquals(sameProcess, false, "the same canonical start is the same process — not stealable");
});

Deno.test("qo3u8(b): comparableStart admits exactly the two canonical writers", () => {
  assertEquals(comparableStart("1759800000"), "1759800000"); // Linux /proc field 22
  assertEquals(comparableStart("Wed Oct 7 12:10:01 2026"), "Wed Oct 7 12:10:01 2026"); // PS_ENV lstart
  assertEquals(comparableStart("Wed  7 Oct 12:10:01 2026"), null); // en_GB pre-pin
  assertEquals(comparableStart("Mer  7 oct 12:10:01 2026"), null); // fr_FR pre-pin
  assertEquals(comparableStart(""), null);
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
