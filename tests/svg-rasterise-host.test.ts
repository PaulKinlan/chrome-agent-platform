// tests/svg-rasterise-host.test.ts — chrome-agent-platform-moim: the NATIVE
// SVG rasteriser's protocol is pinned by EXECUTING the real host (the canvas
// path itself is exercised live by the moim probe + the end-to-end KAT; this
// suite injects the rasteriser seam).
// @ts-nocheck — the host is deliberately dynamic.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  decodeSvgStdin,
  registerSvgRasteriseHost,
  SVG_RASTERISE_RUN_TYPE,
} from "../extension/lib/svg-rasterise-host.js";

function fakeRuntime() {
  const listeners = [];
  return {
    id: "test-ext-id",
    getURL: (p) => `chrome-extension://test-ext-id/${p}`,
    getManifest: () => ({ background: { service_worker: "dist/background/service-worker.js" } }),
    onMessage: { addListener: (fn) => listeners.push(fn) },
    _listeners: listeners,
  };
}

const SW_SENDER = {
  id: "test-ext-id",
  tab: null,
  url: "chrome-extension://test-ext-id/dist/background/service-worker.js",
};
const TAB_SENDER = { id: "test-ext-id", tab: { id: 3 } };
const SVG_B64 = "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4="; // <svg xmlns=…/>
const PNG_B64 = "iVBORw=="; // base64 of the \x89PNG fixture bytes — the shape is what the envelope pins, not the bytes

function fakeRasterise() {
  const calls = [];
  const fn = async (input) => {
    calls.push(input);
    return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  };
  fn.calls = calls;
  return fn;
}

Deno.test("svg-rasterise: registers one listener; no messaging -> honest null", () => {
  const runtime = fakeRuntime();
  const listener = registerSvgRasteriseHost({ runtime });
  assertEquals(runtime._listeners.length, 1);
  assertEquals(listener, runtime._listeners[0]);
  assertEquals(registerSvgRasteriseHost({ runtime: {} }), null);
});

Deno.test("svg-rasterise: non-matching type is ignored; foreign/tab senders are DENIED without holding the channel", () => {
  const runtime = fakeRuntime();
  registerSvgRasteriseHost({ runtime });
  const listener = runtime._listeners[0];
  assertEquals(listener({ type: "other.message" }, SW_SENDER, () => {}), undefined);
  const responses = [];
  const held = listener({ type: SVG_RASTERISE_RUN_TYPE }, TAB_SENDER, (res) => responses.push(res));
  assertEquals(held, undefined, "a denied sender must NOT hold the channel");
  assertEquals(responses.length, 1);
  assertStringIncludes(responses[0].error, "sender is not the service worker");
  const responses2 = [];
  listener({ type: SVG_RASTERISE_RUN_TYPE }, { id: "other-ext", tab: null }, (res) => responses2.push(res));
  assertEquals(responses2.length, 1);
});

Deno.test("svg-rasterise: the SW request HOLDS the channel and answers the bundled PNG envelope", async () => {
  const runtime = fakeRuntime();
  const rasterise = fakeRasterise();
  registerSvgRasteriseHost({ runtime, rasterise });
  const listener = runtime._listeners[0];
  const responses = [];
  const held = listener(
    { type: SVG_RASTERISE_RUN_TYPE, stdinBase64: SVG_B64, width: 512, height: 256, background: "#fff", wallMs: 8000 },
    SW_SENDER,
    (res) => responses.push(res),
  );
  assertEquals(held, true, "the async render HOLDS the channel (the null-response class)");
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(responses.length, 1);
  assertEquals(responses[0], {
    ok: true,
    phase: "completed",
    stdoutEncoding: "base64",
    stdout: null,
    stdoutBase64: PNG_B64,
    stdoutBytes: 4,
    stderr: "",
    errno: null,
    error: null,
  });
  assertEquals(rasterise.calls.length, 1);
  assertEquals(rasterise.calls[0].svgText, '<svg xmlns="http://www.w3.org/2000/svg"/>');
  assertEquals(rasterise.calls[0].width, 512);
  assertEquals(rasterise.calls[0].height, 256);
  assertEquals(rasterise.calls[0].background, "#fff");
});

Deno.test("svg-rasterise: a rasteriser failure answers honestly through the same channel", async () => {
  const runtime = fakeRuntime();
  registerSvgRasteriseHost({ runtime, rasterise: async () => { throw new Error("the document failed to load"); } });
  const listener = runtime._listeners[0];
  const responses = [];
  const held = listener({ type: SVG_RASTERISE_RUN_TYPE, stdinBase64: SVG_B64, width: 64, height: 64 }, SW_SENDER, (res) => responses.push(res));
  assertEquals(held, true);
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(responses.length, 1);
  assertEquals(responses[0].ok, false);
  assertStringIncludes(responses[0].error, "the document failed to load");
});

Deno.test("svg-rasterise: stdin decode + argument bounds", () => {
  assertEquals(decodeSvgStdin(SVG_B64), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  assertStringIncludes(
    (() => { try { decodeSvgStdin(""); return ""; } catch (e) { return e.message; } })(),
    "stdin (base64 SVG) is required",
  );
});
