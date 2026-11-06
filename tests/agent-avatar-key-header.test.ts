// tests/agent-avatar-key-header.test.ts — chrome-agent-platform-jjedl
//
// The Gemini image key used to travel in the URL query string
// (`:generateContent?key=<apiKey>`), which leaks into URL logs, proxy history
// and every response-URL echo (the lrhyl class). The Gemini REST API accepts
// the same key via the x-goog-api-key request header, so the URL now carries
// no secret. These pins hold that shape behaviourally (a stubbed fetch
// observes the real call) and structurally.
//
// Secret-safe discipline: the key below is an obvious synthetic placeholder,
// not credential material.
// @ts-nocheck
import { assert, assertEquals } from "jsr:@std/assert@1";
import { generateAgentAvatar } from "../extension/lib/named-agents.js";

const KEY = "AIza-TEST-KEY-PLACEHOLDER-NOT-A-SECRET";

Deno.test("jjedl: the avatar call sends the key in the x-goog-api-key HEADER and the URL carries no secret", async () => {
  const calls: Array<{ url: string; init: any }> = [];
  const originalFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "aGVsbG8=" } }] } }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  try {
    const out = await generateAgentAvatar({ name: "Ada", role: "engineer", apiKey: KEY });
    // the downscale helper may re-fetch the data: URL locally (canvas path);
    // the invariant is about the UPSTREAM call, and about the key never
    // appearing in ANY fetched URL.
    const upstream = calls.filter((c) => c.url.includes("generativelanguage"));
    assertEquals(upstream.length, 1, "exactly one upstream call");
    for (const c of calls) {
      assert(!c.url.includes(KEY) && !c.url.includes(encodeURIComponent(KEY)), `the key appears in NO fetched URL: ${c.url.slice(0, 80)}`);
      assert(!c.url.includes("?key="), "no fetched URL carries a key query parameter");
    }
    const { url, init } = upstream[0];
    assert(url.includes(":generateContent"), "the generateContent endpoint is called");
    assertEquals(new URL(url).search, "", "the upstream URL has no query string at all");
    assertEquals(init.headers["x-goog-api-key"], KEY, "the key travels in the x-goog-api-key header");
    assertEquals(init.headers["Content-Type"], "application/json", "the content-type header survives");
    assertEquals(init.method, "POST");
    assert(
      typeof out === "string" && out.startsWith("data:image/png;base64,"),
      "the avatar pipeline still returns its data URL end to end",
    );
  } finally {
    (globalThis as any).fetch = originalFetch;
  }
});

Deno.test("jjedl source pin: generateAgentAvatar builds no key-in-query URL and sends the header", async () => {
  const src = await Deno.readTextFile(new URL("../extension/lib/named-agents.js", import.meta.url));
  const start = src.indexOf("export async function generateAgentAvatar");
  assert(start >= 0, "the function exists");
  const end = src.indexOf("async function downscaleAvatar", start);
  const region = src.slice(start, end > start ? end : start + 3000);
  assert(!region.includes("?key="), "no key-in-query URL is built anywhere in the function");
  assert(!region.includes("encodeURIComponent(apiKey)"), "the key is no longer URL-encoded into anything");
  assert(region.includes('"x-goog-api-key": apiKey'), "the header carries the key");
});
