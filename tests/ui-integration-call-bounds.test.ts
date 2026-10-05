// tests/ui-integration-call-bounds.test.ts — chrome-agent-platform-s0fs.
//
// ui-integration's own comment said it plainly: "every CDP call below awaits a
// response with no per-call timeout, so a hung renderer would otherwise leave
// this script running forever". That is why the harness could only report a hang
// as "exceeded its 6 min wall-clock budget — a CDP call never resolved", with no
// way to name the call. These pins hold the two halves of the fix in place:
//
//   1. the harness's CDP client bounds EVERY call, so a hung renderer fails that
//      call, with its method name, in seconds; and
//   2. the evidence screenshots never use a raw unbounded capture — they go
//      through safeCaptureScreenshot, which skips the PNG instead of taking the
//      run down (the class f5lb bounded for the RTL shot only).
//
// A source pin, deliberately: the harness executes at import time (it launches
// Chrome), so importing it in a test is not possible — and the property is about
// what the file's calls LOOK like. Falsified by reverting either half: dropping
// the withTimeout wrapper reds #1; re-introducing one raw capture reds #2.
import { assert, assertMatch } from "jsr:@std/assert@1";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const SOURCE = await Deno.readTextFile(`${ROOT}/scripts/ui-integration.ts`);

Deno.test("s0fs: ui-integration bounds every CDP call, so a hang names the call", () => {
  // The client wraps its promise in withTimeout and rethrows with the method name.
  assertMatch(
    SOURCE,
    /withTimeout\(call,\s*this\.timeoutMs\)/,
    "the CDP client must bound each call (withTimeout(call, this.timeoutMs))",
  );
  assertMatch(
    SOURCE,
    /CDP \$\{method\} did not resolve within \$\{this\.timeoutMs\}ms/,
    "a bounded-out call must name itself, or the next hang is anonymous again",
  );
  // A late reply must not resolve an already-failed call: the pending entry is
  // dropped on timeout.
  assertMatch(
    SOURCE,
    /this\.pending\.delete\(id\)/,
    "the timed-out call must drop its pending entry",
  );
  // The bound is a real number, not something that can be set to infinity later.
  const bound = /timeoutMs = (\d+)/.exec(SOURCE);
  assert(bound, "the client's per-call bound must be a literal");
  assert(Number(bound[1]) > 0 && Number(bound[1]) <= 60000, `the bound must be sane, got ${bound[1]}ms`);
});

Deno.test("s0fs: ui-integration never captures evidence with an unbounded screenshot", () => {
  const raw = [...SOURCE.matchAll(/cdp\.send\(\s*"Page\.captureScreenshot"/g)].length;
  assert(
    raw === 0,
    `every Page.captureScreenshot in ui-integration must go through safeCaptureScreenshot ` +
      `(found ${raw} raw call${raw === 1 ? "" : "s"}): forcing a frame mid-transition is the ` +
      `documented way this call deadlocks, and a deadlocked PNG must not deadlock the run`,
  );
  const guarded = [...SOURCE.matchAll(/safeCaptureScreenshot\(/g)].length;
  assert(guarded >= 4, `expected the four evidence shots to be guarded, found ${guarded}`);
});
