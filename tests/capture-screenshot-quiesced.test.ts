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

  // Run with a short 100ms timeout for test speed
  const t0 = Date.now();
  const bytes = await safeCaptureScreenshot(send, "session-1", {
    format: "png",
    fromSurface: true,
    timeoutMs: 100,
  });
  const elapsed = Date.now() - t0;

  assert(bytes instanceof Uint8Array, "must return a Uint8Array on fallback");
  assert(elapsed < 1500, `fallback must complete quickly (took ${elapsed}ms)`);
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
