// tests/fetch-body-bound.test.ts — chrome-agent-platform-hvd4s
//
// Both fetch brokers used to do `await res.text()` and apply the 1 MB slice
// AFTERWARDS — a hostile multi-GB response was buffered in full inside the
// privileged service worker before any bound existed, while the shipped
// comments promised "size-bounded". These pins hold the replacement: the READ
// itself is streamed with a byte ceiling and the stream is CANCELLED at the
// ceiling, on both broker paths, with the docs/description corrected in the
// same landing.
// @ts-nocheck
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { readResponseTextBounded } from "../extension/lib/fetch-body-bound.js";

function streamResponse(chunks: Uint8Array[], opts: { onCancel?: () => void } = {}) {
  let i = 0;
  let cancelled = false;
  const reader = {
    async read() {
      if (i >= chunks.length) return { done: true, value: undefined };
      return { done: false, value: chunks[i++] };
    },
    async cancel() {
      cancelled = true;
      opts.onCancel?.();
    },
    releaseLock() {},
  };
  return {
    res: { body: { getReader: () => reader } },
    state: {
      get cancelled() { return cancelled; },
      get chunksRead() { return i; },
      get totalChunks() { return chunks.length; },
    },
  };
}

Deno.test("hvd4s: a huge body is NEVER fully read — the final chunk is sliced to the EXACT cap and the stream cancelled", async () => {
  const chunk = new Uint8Array(64 * 1024).fill(0x61); // 64 KB of 'a'
  const chunks = Array.from({ length: 200 }, () => chunk); // 12.8 MB total
  const { res, state } = streamResponse(chunks);
  const out = await readResponseTextBounded(res);
  assertEquals(out.text.length, 1_000_000, "exact-cap retention: the ceiling is absolute, not per-chunk-granular");
  assertEquals(out.truncated, true);
  assert(state.cancelled, "the reader was CANCELLED at the cap — no further chunks are even delivered");
  // 1,000,000 bytes / 65,536 per chunk = 15 full chunks + 1 sliced — versus
  // the 200 (12.8 MB) the old `await res.text()` would have swallowed whole.
  assertEquals(state.chunksRead, 16, "exactly the chunks needed to reach the cap were read");
});

Deno.test("hvd4s: a small body reads completely and decodes correctly across chunk boundaries, including a split multi-byte character", async () => {
  const full = new TextEncoder().encode("hello — naïve ✓ 世界 line two");
  const idx = full.indexOf(0xe4); // first byte of 世 (E4 B8 96)
  assert(idx > 0, "the fixture contains the multi-byte character");
  const chunks = [full.subarray(0, idx + 1), full.subarray(idx + 1)]; // split INSIDE 世
  const { res, state } = streamResponse(chunks);
  const out = await readResponseTextBounded(res, 1000);
  assertEquals(out.text, new TextDecoder().decode(full), "incremental decoding reassembles the split character");
  assertEquals(out.truncated, false);
  assertEquals(state.cancelled, false, "an exhausted stream needs no cancel");
});

Deno.test("hvd4s: a body-less response (HEAD shape / stream-less mock) yields the empty result, never throws", async () => {
  const out = await readResponseTextBounded({ body: null }, 1_000_000);
  assertEquals(out.text, "");
  assertEquals(out.truncated, false);
});

Deno.test("hvd4s: a mid-stream read failure PROPAGATES like res.text() did — no silent partial body", async () => {
  let n = 0;
  const poisoned = {
    body: {
      getReader: () => ({
        read: async () => {
          n++;
          if (n === 1) return { done: false, value: new TextEncoder().encode("partial ") };
          throw new Error("network went away");
        },
        cancel: async () => {},
        releaseLock() {},
      }),
    },
  };
  // The SW broker's route turns this into its honest ok:false error; the
  // script-host fallback catches it to empty text (pinned at the source below).
  await assertRejects(() => readResponseTextBounded(poisoned, 1000), Error, "network went away");
});

Deno.test("hvd4s source pins: BOTH brokers read through the helper; no unbounded res.text() remains in them", async () => {
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  assert(sw.includes('import { readResponseTextBounded } from "../lib/fetch-body-bound.js";'), "the SW imports the bounded-read helper");
  assertEquals(
    sw.split("const { text } = await readResponseTextBounded(res, MAX);").length - 1, 1,
    "cap:fetch reads through the helper exactly once",
  );
  // the cap:fetch handler region must contain no unbounded full-body read and
  // no buffer-then-slice remnant
  const handlerStart = sw.indexOf('async "cap:fetch"(');
  assert(handlerStart >= 0, "the cap:fetch route exists");
  const nextRoute = sw.indexOf('\n  async "', handlerStart + 10);
  const capRegion = sw.slice(handlerStart, nextRoute > handlerStart ? nextRoute : sw.length);
  assert(!capRegion.includes("await res.text()"), "cap:fetch contains no unbounded full-body read");
  assert(!capRegion.includes("text.slice(0, MAX)"), "the buffer-then-slice shape is gone from cap:fetch");

  const host = await Deno.readTextFile(new URL("../extension/lib/script-host.js", import.meta.url));
  assert(host.includes('import { readResponseTextBounded } from "./fetch-body-bound.js";'), "script-host imports the helper");
  const rfStart = host.indexOf("export async function runFetch");
  assert(rfStart >= 0, "runFetch exists");
  const rfRegion = host.slice(rfStart, rfStart + 5000);
  assert(rfRegion.includes("const bounded = await readResponseTextBounded(res).catch(() => ({ text: \"\" }));"), "the runFetch fallback reads through the helper and degrades a read failure to empty text");
  assert(!rfRegion.includes("await res.text()"), "the fallback contains no unbounded full-body read");
  assert(rfRegion.includes("text: bounded.text"), "the fallback returns the bounded text");
  // and the promise in the JSDoc is now precise rather than stale
  assert(host.includes("the bound is on the READ itself"), "the runFetch JSDoc states WHERE the bound applies (hvd4s doc correction)");
});
