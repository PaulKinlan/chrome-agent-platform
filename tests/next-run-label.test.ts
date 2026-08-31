// @ts-nocheck
// tests/next-run-label.test.ts — the "Next run" projector for a routine
// (CAP-FB-20260831-SCHEDULED-NEXT-RUN-WIDGET-01).
//
// The routine's next-fire time comes from the REAL chrome.alarms alarm
// (scheduledTime, exposed by lib/scheduler.js); this pins the pure function
// that turns that epoch-ms into the "Next run <relative + absolute>" label the
// hub renders — relative countdown, absolute clock time, correct
// singular/plural, and the "due now" boundary once a fire time has passed.
//
// Falsification: revert lib/next-run-label.js's arithmetic (e.g. drop the
// singular/plural branch, or the "due now" boundary) and these go RED.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  nextRunLabel,
  relativeCountdown,
  lastRunLabel,
} from "../extension/lib/next-run-label.js";

const NOW = Date.UTC(2026, 8, 1, 15, 45, 0); // 2026-09-01T15:45:00Z
const opts = { now: NOW, locale: "en-US", timeZone: "UTC" };

Deno.test("relative countdown: singular vs plural at every unit boundary", () => {
  assertEquals(relativeCountdown(1_000), "in 1 second");
  assertEquals(relativeCountdown(2_000), "in 2 seconds");
  assertEquals(relativeCountdown(60_000), "in 1 minute");
  assertEquals(relativeCountdown(120_000), "in 2 minutes");
  assertEquals(relativeCountdown(60 * 60_000), "in 1 hour");
  assertEquals(relativeCountdown(3 * 60 * 60_000), "in 3 hours");
  assertEquals(relativeCountdown(24 * 60 * 60_000), "in 1 day");
  assertEquals(relativeCountdown(2 * 24 * 60 * 60_000), "in 2 days");
});

Deno.test("nextRunLabel: a future alarm reads 'Next run <relative> · <absolute>'", () => {
  const at = NOW + 3 * 60_000; // 3 minutes out
  const r = nextRunLabel(at, opts);
  assert(r, "a future fire produces a label");
  assertEquals(r.due, false);
  assertEquals(r.relative, "in 3 minutes");
  // Absolute is the wall-clock fire time (deterministic under the fixed zone).
  assert(r.absolute.includes("3:48"), `absolute shows the clock time, got ${r.absolute}`);
  assert(r.absolute.includes("Sep"), `absolute shows the date, got ${r.absolute}`);
  assertEquals(r.label, `Next run in 3 minutes · ${r.absolute}`);
});

Deno.test("nextRunLabel: singular minute is not pluralized", () => {
  const r = nextRunLabel(NOW + 60_000, opts);
  assertEquals(r.relative, "in 1 minute");
  assert(!r.label.includes("minutes"), "one minute is singular");
});

Deno.test("nextRunLabel: a passed fire time is 'due now', never a negative countdown", () => {
  const r = nextRunLabel(NOW - 5_000, opts);
  assert(r, "an overdue fire still produces a label");
  assertEquals(r.due, true);
  assertEquals(r.relative, "due now");
  assert(!r.label.includes("-"), "no negative countdown leaks into the label");
  assert(r.label.startsWith("Next run due now"), r.label);
});

Deno.test("nextRunLabel: no armed fire (null / non-number) yields no widget", () => {
  assertEquals(nextRunLabel(null, opts), null);
  assertEquals(nextRunLabel(undefined, opts), null);
  assertEquals(nextRunLabel(NaN, opts), null);
  assertEquals(nextRunLabel("soon", opts), null);
});

Deno.test("nextRunLabel: a fire in a later year shows the year in the absolute", () => {
  const at = Date.UTC(2027, 0, 2, 9, 0, 0);
  const r = nextRunLabel(at, { now: NOW, locale: "en-US", timeZone: "UTC" });
  assert(r.absolute.includes("2027"), `a cross-year fire shows the year, got ${r.absolute}`);
});

Deno.test("lastRunLabel: after firing, the routine shows its last run", () => {
  assertEquals(lastRunLabel(NOW - 30_000, { now: NOW }).ago, "just now");
  assertEquals(lastRunLabel(NOW - 60_000, { now: NOW }).ago, "1 minute ago");
  assertEquals(lastRunLabel(NOW - 5 * 60_000, { now: NOW }).ago, "5 minutes ago");
  assertEquals(lastRunLabel(NOW - 2 * 60 * 60_000, { now: NOW }).ago, "2 hours ago");
  assertEquals(lastRunLabel(NOW - 3 * 24 * 60 * 60_000, { now: NOW }).label, "Last run 3 days ago");
  assertEquals(lastRunLabel(null, { now: NOW }), null);
});
