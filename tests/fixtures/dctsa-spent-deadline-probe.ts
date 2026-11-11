// tests/fixtures/dctsa-spent-deadline-probe.ts — DATA for tests/embedded-frame-eval.test.ts (dctsa).
//
// Drives trackEmbeddedFrameContexts' real readiness loop until its deadline is SPENT, so the
// remaining budget handed to `nextChange(deadline - Date.now())` is NEGATIVE on an actual code path
// — not a value passed to a helper in a unit assertion. The loop's fake CDP outlives the deadline
// (a send that takes longer than timeoutMs) and never reports the target frame, which is exactly the
// shape a starved box produces: the `while (Date.now() < deadline)` test was true, and by the time
// the failing branch calls nextChange the budget is gone.
//
// Observables: stdout DEADLINE_SPENT / the error message · stderr whatever Deno's timer layer says
// about the delay it was handed. The test asserts on stderr, because a negative setTimeout delay
// emits a PROCESS-LEVEL `TimeoutNegativeWarning` (measured: "Timeout duration was set to 1") that no
// in-process assertion can capture and that a reader of a red gate chases instead of the real cause.
import { trackEmbeddedFrameContexts } from "../../scripts/lib/embedded-frame-eval.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const cdp = {
  // Slower than the deadline below, and the frame is never present: the loop spends its budget on
  // the round-trip and then asks nextChange for a negative remainder.
  send: async (_method: string) => {
    await sleep(80);
    return { result: { frameTree: { childFrames: [] } } };
  },
  on: () => () => {},
};

const tracker = trackEmbeddedFrameContexts(cdp as never, "dctsa-probe", {});
try {
  await tracker.evaluate({
    extensionId: "abcdefghijklmnop",
    path: "/options/options.html",
    expression: "1",
    timeoutMs: 40,
  });
  // The probe only means something if the deadline was actually spent; say so loudly.
  console.log("UNEXPECTED_OK");
  Deno.exit(2);
} catch (error) {
  const message = String((error as Error)?.message ?? error);
  console.log(`DEADLINE_SPENT ${message.slice(0, 120)}`);
} finally {
  tracker.close();
}
