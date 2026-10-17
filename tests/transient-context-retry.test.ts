// chrome-agent-platform-zq76k: the transient execution-context retry is ONE
// shared helper, and it retries ONE thing.
//
// The defect this pins: "CDP error N: Cannot find default execution context" is
// a TRANSPORT failure that arrives ~2 s into launch, before the frame has a
// default execution context. It was hand-rolled in chrome-journeys' evalIn and
// in click-target's probePoint, and the journey/KAT scripts beside them had no
// retry at all - so a launch race in kat-site-delegation-attachments red a union
// gate (merger, tree b112e3cc run 1) and cost a full gate re-run. The unit cases
// below are the falsification for the helper; the source pins at the end are
// what keep the three call sites on it, because a behaviour test cannot reach
// into a standalone KAT script.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  PageThrowError,
  TRANSIENT_CONTEXT_ATTEMPTS,
  TRANSIENT_CONTEXT_RETRY_MS,
  withTransientContextRetry,
} from "../scripts/lib/cdp-eval.ts";

const TRANSIENT = "CDP error 7: Cannot find default execution context";

/** A recorded retry schedule: the delays the helper asked for, in order. */
function recorder() {
  const delays: number[] = [];
  return {
    delays,
    sleep: (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    },
  };
}

/** Run and return what it threw, so each case can assert on the identity of the
 * error that came out rather than on a rendered message. */
async function thrownBy(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (e) {
    return e;
  }
  throw new Error("expected the call to reject, but it resolved");
}

Deno.test("zq76k: the transient context error is absorbed and the value is returned", async () => {
  const { delays, sleep } = recorder();
  let calls = 0;
  const value = await withTransientContextRetry(() => {
    calls++;
    if (calls < 3) return Promise.reject(new Error(TRANSIENT));
    return Promise.resolve("loaded");
  }, { sleep });
  assertEquals(value, "loaded");
  assertEquals(calls, 3, "two transient failures then the value");
  assertEquals(delays, [TRANSIENT_CONTEXT_RETRY_MS, TRANSIENT_CONTEXT_RETRY_MS]);
  assertEquals(TRANSIENT_CONTEXT_ATTEMPTS, 5, "the bound both hand-rolled copies used");
});

Deno.test("zq76k: a PAGE throw carrying the same phrase is never retried", async () => {
  // The load-bearing distinction (0lb4 P1): a page expression can literally
  // throw this phrase, and retrying it would swallow a real page failure.
  const { delays, sleep } = recorder();
  let calls = 0;
  const pageThrow = new PageThrowError("Error: Cannot find default execution context");
  const thrown = await thrownBy(() => withTransientContextRetry(() => {
    calls++;
    return Promise.reject(pageThrow);
  }, { sleep }));
  assert(thrown === pageThrow, "the page throw must surface unchanged");
  assertEquals(calls, 1, "a page throw must surface on the FIRST attempt");
  assertEquals(delays, [], "and must never sleep");
});

Deno.test("zq76k: a transport failure that is not the transient phrase is not retried", async () => {
  const { delays, sleep } = recorder();
  let calls = 0;
  const thrown = await thrownBy(() => withTransientContextRetry(() => {
    calls++;
    return Promise.reject(new Error("CDP error 9: Target closed"));
  }, { sleep }));
  assert(String((thrown as Error).message).includes("Target closed"), "the transport failure must surface unchanged");
  assertEquals(calls, 1);
  assertEquals(delays, []);
});

Deno.test("zq76k: the retry is bounded and rethrows the LAST error unchanged", async () => {
  const { delays, sleep } = recorder();
  const seen: Error[] = [];
  const thrown = await thrownBy(() => withTransientContextRetry(() => {
    const e = new Error(`${TRANSIENT} (attempt ${seen.length + 1})`);
    seen.push(e);
    return Promise.reject(e);
  }, { attempts: 3, sleep }));
  assert(thrown === seen[2], "the LAST error must be rethrown unchanged");
  assertEquals(seen.length, 3, "exactly the requested number of attempts");
  assertEquals(delays.length, 2, "no sleep after the final attempt");
});

// ── call-site pins: the copies are gone and the KAT is on the shared helper ──

const ROOT = new URL("../", import.meta.url);
const read = (rel: string) => Deno.readTextFileSync(new URL(rel, ROOT));

/** Comments out, code left: the pin below is about CODE, and the shared helper's
 * own docs legitimately quote the phrase (as do call sites explaining it). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

Deno.test("zq76k: no call site keeps a private copy of the transient retry", () => {
  const phrase = "Cannot find default execution context";
  for (const rel of ["scripts/chrome-journeys.ts", "scripts/lib/click-target.ts"]) {
    const source = stripComments(read(rel));
    assert(
      !source.includes(phrase),
      `${rel} must not carry a second copy of the transient-context retry (it belongs in scripts/lib/cdp-eval.ts)`,
    );
    assert(
      read(rel).includes("withTransientContextRetry"),
      `${rel} must reach the transient-context retry through the shared helper`,
    );
  }
});

Deno.test("zq76k: the site-delegation KAT evaluates through the shared retry", () => {
  const source = read("scripts/kat-site-delegation-attachments.ts");
  assert(
    /import\s*\{[^}]*withTransientContextRetry[^}]*\}\s*from\s*"\.\/lib\/cdp-eval\.ts"/.test(source),
    "the KAT must import the shared helper",
  );
  assert(
    /const evalIn = async \(expr: string\) =>\s*\n\s*await withTransientContextRetry\(/.test(source),
    "the KAT's evalIn must evaluate THROUGH the shared retry (this is the call path that raced)",
  );
});
