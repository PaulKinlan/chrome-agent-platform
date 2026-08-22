// @ts-nocheck — bounded JS-minifier lane: disabled metadata + fresh-Worker bounds.
// No Chrome. These tests pin the HARD boundary — three disabled bundled-package
// descriptors (admitted:false, canonicalNameClaim:false, canExecute:false,
// canGrant:false), the fresh-Worker-per-call contract with no main-thread
// fallback, and the 1 MiB input/output + 3 s wall-timeout limits — using an
// injected fake Worker so no real browser Worker is required.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { JS_MINIFIER_TOOLS, runMinifier } from "../extension/lib/js-minifier-tools.js";
import { INPUT_LIMIT_BYTES, OUTPUT_LIMIT_BYTES, WALL_TIMEOUT_MS, runFreshWorker } from "../extension/lib/js-minifier-lifecycle.js";

function fakeWorkerCtor({ onmessageResult = null, onPost = null, terminateDelay = 0 } = {}) {
  const calls = [];
  class FakeWorker {
    constructor(url, opts) {
      calls.push({ url: String(url), opts });
      this.onmessage = null;
      this.onerror = null;
    }
    postMessage(request) {
      if (onPost) onPost(request, this);
      if (onmessageResult !== null) {
        queueMicrotask(() => {
          if (this.onmessage) this.onmessage({ data: onmessageResult });
        });
      }
    }
    terminate() {
      return new Promise((r) => setTimeout(r, terminateDelay));
    }
  }
  return { FakeWorker, calls };
}

Deno.test("js-minifier: three disabled bundled-package descriptors, no authority", () => {
  assertEquals(JS_MINIFIER_TOOLS.length, 3);
  const ids = JS_MINIFIER_TOOLS.map((t) => t.toolId);
  assertEquals(ids.sort(), ["csso_bounded", "html_minifier_terser_bounded", "terser_bounded"]);
  for (const tool of JS_MINIFIER_TOOLS) {
    assertEquals(tool.sourceKind, "bundled-package");
    assertEquals(tool.canonicalNameClaim, false);
    assertEquals(tool.admitted, false);
    assertEquals(tool.canExecute, false);
    assertEquals(tool.canGrant, false);
    assertEquals(tool.availability, "disabled");
    assertEquals(tool.licenceStatus, "pending-owner-confirmation");
    assert(["compute", "text.transform"].every((c) => tool.capabilities.includes(c)), "capabilities must be compute+text.transform");
    assertEquals(tool.replayClass, "read-only");
  }
});

Deno.test("js-minifier: unknown kind rejects without constructing a Worker", async () => {
  const { FakeWorker, calls } = fakeWorkerCtor();
  await assertRejects(() => runMinifier("nope_bounded", "const x = 1;", {}, { WorkerCtor: FakeWorker }), TypeError);
  assertEquals(calls.length, 0, "no Worker is constructed for an unknown kind");
});

Deno.test("js-minifier: missing WorkerCtor fails closed (no main-thread fallback)", async () => {
  await assertRejects(() => runMinifier("terser_bounded", "const x = 1;", {}, { WorkerCtor: null }), /Worker unavailable/);
});

Deno.test("js-minifier: input above 1 MiB rejects before Worker construction", async () => {
  const { FakeWorker, calls } = fakeWorkerCtor();
  const over = "x".repeat(INPUT_LIMIT_BYTES + 1);
  await assertRejects(() => runMinifier("terser_bounded", over, {}, { WorkerCtor: FakeWorker }), /1 MiB/);
  assertEquals(calls.length, 0, "over-limit input must not spawn a Worker");
});

Deno.test("js-minifier: fresh Worker per call receives the exact request envelope", async () => {
  const { FakeWorker, calls } = fakeWorkerCtor({ onmessageResult: { ok: true, result: { output: "minified" } } });
  const value = await runMinifier("csso_bounded", "a { color: red; }", {}, { WorkerCtor: FakeWorker });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, new URL("../extension/lib/csso-bounded.worker.js", import.meta.url).href);
  assertEquals(value.ok, true);
});

Deno.test("js-minifier: output above 1 MiB rejects and terminates the Worker", async () => {
  const big = "y".repeat(OUTPUT_LIMIT_BYTES + 1);
  const { FakeWorker, calls } = fakeWorkerCtor({ onmessageResult: { ok: true, result: { output: big } } });
  await assertRejects(() => runMinifier("terser_bounded", "const x = 1;", {}, { WorkerCtor: FakeWorker }), /1 MiB/);
  assertEquals(calls.length, 1);
});

Deno.test("js-minifier: wall timeout terminates the busy Worker", async () => {
  // A Worker that never responds: the lifecycle must reject after the timeout.
  let posted = null;
  const { FakeWorker } = fakeWorkerCtor({
    onPost: (request) => { posted = request; },
    onmessageResult: null,
  });
  await assertRejects(
    () => runFreshWorker(new URL("../extension/lib/terser-bounded.worker.js", import.meta.url), {
      type: "js-minifier-job", sessionId: "t", executionId: "1", jobId: "1", kind: "terser_bounded", code: "const x = 1;", options: {},
    }, { WorkerCtor: FakeWorker, timeoutMs: 20 }),
    /timeout/,
  );
  assert(posted !== null, "the request must have been posted before the timeout");
  assertEquals(WALL_TIMEOUT_MS, 3_000);
});
