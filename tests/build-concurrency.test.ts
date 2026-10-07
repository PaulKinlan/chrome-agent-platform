// tests/build-concurrency.test.ts — bead chrome-agent-platform-jjsz.
//
// The two policies the parallel build pipeline leans on (scripts/lib/build-concurrency.mjs):
//   settleAll       — every sibling quiesces BEFORE a failure surfaces, so the rollback that removes
//                     the staging tree never runs under a sibling still writing into it; the FIRST
//                     rejection in DECLARATION order is the one reported; later ones are not dropped.
//   resolveGcGraceMs — the version-GC grace parser (CAP_BUILD_GC_GRACE_MS).
//
// Determinism: none of these tests depends on a timer winning a race. The quiescence assertions
// compare "the sibling finished" against "the rejection surfaced": allSettled makes that true by
// construction, while a bare Promise.all surfaces the rejection in a microtask, long before a 25 ms
// timer can fire — so the mutant is RED every time, and the correct code is green every time.
import { assert, assertEquals, assertStrictEquals } from "jsr:@std/assert@1";
import {
  DEFAULT_GC_GRACE_MS,
  MAX_GC_GRACE_MS,
  resolveGcGraceMs,
  settleAll,
} from "../scripts/lib/build-concurrency.mjs";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Run `fn`, return what it threw (and whether it threw at all: a reason may be `undefined`). */
async function thrownBy(fn: () => Promise<unknown>): Promise<{ threw: boolean; reason: unknown }> {
  try {
    await fn();
    return { threw: false, reason: undefined };
  } catch (reason) {
    return { threw: true, reason };
  }
}

Deno.test("settleAll: a sibling is DONE before the failure surfaces (the rollback never runs under a live writer)", async () => {
  let siblingFinished = false;
  const slowSibling = (async () => {
    await sleep(25);
    siblingFinished = true;
    return "wrote";
  })();
  const failsAtOnce = Promise.reject(new Error("bundle exploded"));

  const { threw, reason } = await thrownBy(() => settleAll([failsAtOnce, slowSibling]));

  assert(threw, "a rejected task must reject the whole fan-out");
  assertEquals((reason as Error).message, "bundle exploded");
  assertStrictEquals(
    siblingFinished,
    true,
    "the failure surfaced while a sibling was still running: a rollback now would race its writes",
  );
});

Deno.test("settleAll: the reported cause is the FIRST rejection in DECLARATION order, not the first to happen", async () => {
  const declaredFirstButLate = (async () => {
    await sleep(25);
    throw new Error("declared first (fails late)");
  })();
  const declaredSecondButImmediate = Promise.reject(new Error("declared second (fails at once)"));
  const { reason } = await thrownBy(() =>
    settleAll([declaredFirstButLate, declaredSecondButImmediate], () => {})
  );
  assertEquals(
    (reason as Error).message,
    "declared first (fails late)",
    "the cause must not depend on which task lost a race",
  );
});

Deno.test("settleAll: every later rejection is reported with its index, never silently dropped", async () => {
  const reported: Array<[string, number]> = [];
  const { reason } = await thrownBy(() =>
    settleAll(
      [
        Promise.reject(new Error("zero")),
        Promise.resolve("fine"),
        Promise.reject(new Error("two")),
        Promise.reject(new Error("three")),
      ],
      (why, index) => reported.push([(why as Error).message, index]),
    )
  );
  assertEquals((reason as Error).message, "zero", "the first in declaration order is thrown");
  assertEquals(reported, [["two", 2], ["three", 3]], "exactly the later failures are reported, by index");
});

Deno.test("settleAll: the default reporter writes the later failure to stderr naming its index and message", async () => {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    await thrownBy(() =>
      settleAll([Promise.reject(new Error("first")), Promise.reject(new Error("second one"))])
    );
  } finally {
    console.error = original;
  }
  assertEquals(lines.length, 1, "one secondary failure -> one stderr line");
  assert(lines[0].includes("#1"), `the line must name the task index: ${lines[0]}`);
  assert(lines[0].includes("second one"), `the line must carry the failure text: ${lines[0]}`);
});

Deno.test("settleAll: success returns the values in DECLARATION order even when completion order differs", async () => {
  const slowFirst = (async () => {
    await sleep(20);
    return "a";
  })();
  const quickSecond = Promise.resolve("b");
  assertEquals(await settleAll([slowFirst, quickSecond, "c"]), ["a", "b", "c"]);
  assertEquals(await settleAll([]), []);
});

Deno.test("settleAll: a falsy rejection reason (undefined, 0, empty string) still rejects the fan-out and is rethrown as-is", async () => {
  for (const falsy of [undefined, 0, ""]) {
    const { threw, reason } = await thrownBy(() => settleAll([Promise.reject(falsy), Promise.resolve(1)]));
    assert(threw, `a task rejecting with ${JSON.stringify(falsy) ?? "undefined"} must still fail the fan-out`);
    assertStrictEquals(reason, falsy);
  }
});

Deno.test("resolveGcGraceMs: the default is 50 ms (the old fixed 2000 ms was half of a warm build)", () => {
  assertEquals(DEFAULT_GC_GRACE_MS, 50);
  assertEquals(resolveGcGraceMs({}), 50);
  assertEquals(resolveGcGraceMs(undefined), 50);
  assertEquals(resolveGcGraceMs({ CAP_BUILD_GC_GRACE_MS: undefined }), 50);
});

Deno.test("resolveGcGraceMs: an unusable value falls back to the default and is never read as 'no grace'", () => {
  for (const bad of ["", "   ", "-1", "-0.5", "abc", "NaN", "Infinity", "-Infinity", "12px", "1,5"]) {
    assertEquals(
      resolveGcGraceMs({ CAP_BUILD_GC_GRACE_MS: bad }),
      DEFAULT_GC_GRACE_MS,
      `"${bad}" must fall back to the default, not to 0 or a clamp`,
    );
  }
});

Deno.test("resolveGcGraceMs: an explicit value is honoured — 0 means no grace, 2000 restores the previous behaviour", () => {
  assertEquals(resolveGcGraceMs({ CAP_BUILD_GC_GRACE_MS: "0" }), 0, "explicit 0 disables the grace");
  assertEquals(resolveGcGraceMs({ CAP_BUILD_GC_GRACE_MS: "2000" }), 2000);
  assertEquals(resolveGcGraceMs({ CAP_BUILD_GC_GRACE_MS: " 250 " }), 250, "surrounding whitespace is ignored");
  assertEquals(resolveGcGraceMs({ CAP_BUILD_GC_GRACE_MS: "1e3" }), 1000);
});

Deno.test("resolveGcGraceMs: an explicit grace is capped so a typo cannot stall every build", () => {
  assertEquals(MAX_GC_GRACE_MS, 60_000);
  assertEquals(resolveGcGraceMs({ CAP_BUILD_GC_GRACE_MS: "60000" }), 60_000);
  assertEquals(resolveGcGraceMs({ CAP_BUILD_GC_GRACE_MS: "60001" }), 60_000);
  assertEquals(resolveGcGraceMs({ CAP_BUILD_GC_GRACE_MS: "1e9" }), 60_000);
});
