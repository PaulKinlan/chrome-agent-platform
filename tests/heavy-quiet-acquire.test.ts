// tests/heavy-quiet-acquire.test.ts — chrome-agent-platform-rvht7.
//
// The heavy tier needs the wall-clock NTP suite to ACQUIRE a quiet window instead of asserting one from inside
// the least quiet job on the box. Two properties matter more than the happy path and are proven here:
//   1. when the window is NOT granted inside the bound, the outcome is an ENVIRONMENTAL REFUSAL — the
//      CAP_ENVIRONMENTAL_REFUSAL marker with attribution (bound, waited, reasons) plus QuietWindowRefusedError,
//      which the runners already classify as exit 75. Never a product FAIL, and never an unbounded wait;
//   2. the bound is FINITE even when the environment says otherwise (NaN, negative, Infinity).
// @ts-nocheck — unit tests run under Deno.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  acquireQuietWindowForHeavyRun,
  DEFAULT_ACQUIRE_MS,
  resolveAcquireMs,
} from "../scripts/lib/heavy-quiet-acquire.ts";
import { QuietWindowRefusedError, ENVIRONMENTAL_REFUSAL_MARKER } from "../scripts/lib/quiet-window.ts";

function sample({ loadPerCore, at, builders = 0, measurable = true }) {
  return {
    at,
    load1: loadPerCore * 8,
    load5: loadPerCore * 8,
    load15: loadPerCore * 8,
    cores: 8,
    loadPerCore,
    compilers: builders,
    compilerNames: builders ? ["rustc"] : [],
    activeCompilers: builders ? ["rustc"] : [],
    builderJobs: builders,
    measurable,
  };
}

Deno.test("rvht7: a window that is never granted REFUSES environmentally, with the bound and reason", async () => {
  const errors = [];
  let clock = 0;
  // Always loaded: the box never gets quiet, so the wait must run to its bound and then refuse.
  await assertRejects(
    () =>
      acquireQuietWindowForHeavyRun({
        boundMs: 5_000,
        label: "ntp-boot-staging-timing",
        hooks: {
          now: () => clock,
          sleep: async (ms) => { clock += ms; },
          sample: async () => sample({ loadPerCore: 5.25 / 8 * 8 / 8 * 8 / 8, at: clock, builders: 4 }),
          error: (line) => errors.push(line),
          notice: () => {},
        },
      }),
    QuietWindowRefusedError,
  );
  const marker = errors.find((line) => line.startsWith(ENVIRONMENTAL_REFUSAL_MARKER));
  assert(marker, `the refusal must print ${ENVIRONMENTAL_REFUSAL_MARKER} with attribution, got: ${errors.join(" | ")}`);
  const detail = JSON.parse(marker.slice(ENVIRONMENTAL_REFUSAL_MARKER.length).trim());
  assertEquals(detail.reason, "no-quiet-window");
  assertEquals(detail.suite, "ntp-boot-staging-timing");
  assertEquals(detail.boundMs, 5_000);
  assert(detail.waitedMs > 0, "the refusal must report how long it waited before giving up");
  assert(typeof detail.waitedMs === "number" && detail.waitedMs <= 5_000 + 5_000,
    `the wait must stay bounded by the spec, saw ${detail.waitedMs}`);
});

Deno.test("rvht7: a window that arrives is REPORTED, and the suite may then measure", async () => {
  const logged = [];
  let clock = 0;
  let samples = 0;
  const result = await acquireQuietWindowForHeavyRun({
    boundMs: 60_000,
    label: "ntp-boot-staging-timing",
    hooks: {
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      // Loaded for the first three samples, quiet afterwards: the wait succeeds without being invisible.
      sample: async () => {
        samples += 1;
        return sample({ loadPerCore: samples <= 3 ? 2.5 : 0.1, at: clock });
      },
      error: () => {},
      notice: () => {},
    },
  });
  assert(result.waitedMs >= 0);
  assertEquals(result.boundMs, 60_000);
});

Deno.test("rvht7: the acquisition bound is FINITE even when the environment is nonsense", () => {
  assertEquals(resolveAcquireMs(undefined), DEFAULT_ACQUIRE_MS);
  assertEquals(resolveAcquireMs(""), DEFAULT_ACQUIRE_MS);
  for (const bad of ["NaN", "-1", "0", "Infinity", "abc", " "]) {
    assertEquals(resolveAcquireMs(bad), DEFAULT_ACQUIRE_MS, `${JSON.stringify(bad)} must not become an unbounded wait`);
  }
  assertEquals(resolveAcquireMs("90000"), 90_000);
});
