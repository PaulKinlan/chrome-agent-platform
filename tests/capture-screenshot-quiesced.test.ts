// tests/capture-screenshot-quiesced.test.ts — Verification of safeCaptureScreenshot
// resilient behavior against quiesced headless frames (chrome-agent-platform-f5lb).
//
// In headless Chromium with --disable-gpu, Page.captureScreenshot(fromSurface: true)
// issued on a quiesced page waits forever for a compositor frame that is never
// scheduled. safeCaptureScreenshot provides bounded timeouts, compositor waking,
// and fromSurface: false fallback.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { safeCaptureScreenshot } from "../scripts/lib/chrome-launch.ts";

const SAMPLE_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

Deno.test("safeCaptureScreenshot: decodes base64 screenshot data on normal success", async () => {
  const calls: any[] = [];
  const send = async (method: string, params: any) => {
    calls.push({ method, params });
    if (method === "Page.captureScreenshot") {
      return { result: { data: SAMPLE_PNG_B64 } };
    }
    throw new Error(`unexpected method ${method}`);
  };

  const bytes = await safeCaptureScreenshot(send, "session-1", { format: "png", fromSurface: true });
  assert(bytes instanceof Uint8Array, "must return a Uint8Array");
  assertEquals(bytes.length, 70, "expected sample PNG byte length");
  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, "Page.captureScreenshot");
  assertEquals(calls[0].params.fromSurface, true);
});

Deno.test("safeCaptureScreenshot: fromSurface: true timeout falls back to compositor wake and fromSurface: false", async () => {
  const calls: any[] = [];
  const send = async (method: string, params: any) => {
    calls.push({ method, params });
    if (method === "Page.captureScreenshot") {
      if (params.fromSurface === true) {
        // Simulate hang/timeout on quiesced frame
        await new Promise((r) => setTimeout(r, 2000));
        return { result: { data: SAMPLE_PNG_B64 } };
      }
      if (params.fromSurface === false) {
        // Fallback succeeds immediately
        return { result: { data: SAMPLE_PNG_B64 } };
      }
    }
    if (method === "Runtime.evaluate") {
      return { result: { value: true } };
    }
    throw new Error(`unexpected method ${method}`);
  };

  // Run with a short 100ms timeout for test speed. No wall-clock assertion:
  // the call sequence below already pins that the 100ms bound fired (had the
  // wrapper waited out the stub's 2000ms sleep, the first capture would have
  // RESOLVED and the wake + fallback calls would never happen). An elapsed
  // bound in the parallel phase adds flake risk and nothing else (8cu6).
  const bytes = await safeCaptureScreenshot(send, "session-1", {
    format: "png",
    fromSurface: true,
    timeoutMs: 100,
  });

  assert(bytes instanceof Uint8Array, "must return a Uint8Array on fallback");
  // Verify call sequence: initial fromSurface: true -> Runtime.evaluate rAF -> fallback fromSurface: false
  assertEquals(calls[0].method, "Page.captureScreenshot");
  assertEquals(calls[0].params.fromSurface, true);
  assertEquals(calls[1].method, "Runtime.evaluate");
  assert(calls[1].params.expression.includes("requestAnimationFrame"));
  assertEquals(calls[2].method, "Page.captureScreenshot");
  assertEquals(calls[2].params.fromSurface, false);
});

Deno.test("safeCaptureScreenshot: returns null safely when both attempts fail or reject", async () => {
  const send = async (method: string) => {
    if (method === "Page.captureScreenshot") {
      throw new Error("Protocol error: Target closed");
    }
    return {};
  };

  const bytes = await safeCaptureScreenshot(send, "session-1", {
    format: "png",
    timeoutMs: 100,
  });
  assertEquals(bytes, null, "terminal failure must return null without throwing");
});

Deno.test("safeCaptureScreenshot: terminal diagnostics distinguish rejected, empty, and successful captures without changing null", async () => {
  const png = { result: { data: SAMPLE_PNG_B64 } };
  const seen: unknown[] = [];
  const onFailure = (failures: unknown) => seen.push(failures);

  const rejected = await safeCaptureScreenshot(async (method) => {
    if (method === "Page.captureScreenshot") throw new Error("Protocol error: Target closed");
    return { result: { value: true } };
  }, "session-rejected", { timeoutMs: 100, onFailure });
  assertEquals(rejected, null);
  assertEquals(seen.pop(), [
    { stage: "initial", outcome: "error", error: "Protocol error: Target closed" },
    { stage: "fallback", outcome: "error", error: "Protocol error: Target closed" },
  ], "a rejected CDP capture is not an empty CDP response");

  const empty = await safeCaptureScreenshot(async (method) => {
    if (method === "Page.captureScreenshot") return { result: {} };
    return { result: { value: true } };
  }, "session-empty", { timeoutMs: 100, onFailure });
  assertEquals(empty, null);
  assertEquals(seen.pop(), [
    { stage: "initial", outcome: "empty" },
    { stage: "fallback", outcome: "empty" },
  ], "a response without PNG data must not claim a protocol error or a sleeping display");

  let captureCalls = 0;
  const timedOut = await safeCaptureScreenshot(async (method) => {
    if (method === "Page.captureScreenshot" && ++captureCalls === 1) return await new Promise(() => {});
    if (method === "Page.captureScreenshot") return { result: {} };
    return { result: { value: true } };
  }, "session-timeout", { timeoutMs: 10, onFailure });
  assertEquals(timedOut, null);
  assertEquals(seen.pop(), [
    { stage: "initial", outcome: "error", error: "deadline" },
    { stage: "fallback", outcome: "empty" },
  ], "a timed-out CDP request keeps its deadline cause rather than becoming an empty response");

  const successful = await safeCaptureScreenshot(async (method) => {
    if (method === "Page.captureScreenshot") return png;
    throw new Error("a successful first capture must not wake the compositor");
  }, "session-success", { timeoutMs: 100, onFailure });
  assert(successful instanceof Uint8Array);
  assertEquals(seen.length, 0, "a successful capture must not emit a failure diagnostic");
});
