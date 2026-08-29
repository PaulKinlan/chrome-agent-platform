// @ts-nocheck — the kv/IDB fakes stub browser globals (chrome.storage) that
// Deno's type-checker doesn't know about; the runtime behavior is what's under
// test. tests/usage-tool-counts.test.ts — the bounded per-tool call counters
// that feed the Usage panel's tool-usage chart.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  clearUsage,
  getServerToolUsage,
  getToolUsage,
  recordServerToolUsage,
  recordToolCall,
  SERVER_TOOL_USAGE_KEY,
  TOOL_USAGE_KEY,
} from "../extension/lib/usage.js";
import { resetUsageMigration } from "../extension/lib/usage-store.js";
import { installFakeIdb, resetFakeIdb } from "./fake-idb.js";
import { installFakeLocks, resetFakeLocks } from "./fake-locks.js";

const store = new Map();
function mock() {
  globalThis.chrome = { permissions: { contains: async () => true }, storage: { local: {
    get: async (key) => { const out = {}; for (const k of (Array.isArray(key) ? key : [key])) if (store.has(k)) out[k] = JSON.parse(JSON.stringify(store.get(k))); return out; },
    set: async (obj) => { for (const [k, v] of Object.entries(obj)) store.set(k, JSON.parse(JSON.stringify(v))); },
    remove: async (keys) => { for (const k of (Array.isArray(keys) ? keys : [keys])) store.delete(k); },
  } } };
}
function reset() {
  resetFakeIdb(); installFakeIdb(); resetFakeLocks(); installFakeLocks(); resetUsageMigration(); mock(); store.clear();
}

Deno.test("recordToolCall counts concurrent invocations without losing any", async () => {
  reset();
  await Promise.all([
    recordToolCall("tabs.create"),
    recordToolCall("tabs.create"),
    recordToolCall("browser_control"),
  ]);
  const tools = await getToolUsage();
  assertEquals(tools.find((t) => t.tool === "tabs.create").calls, 2);
  assertEquals(tools.find((t) => t.tool === "browser_control").calls, 1);
});

Deno.test("getToolUsage sorts by calls and ignores malformed buckets", async () => {
  reset();
  await recordToolCall("a"), await recordToolCall("a"), await recordToolCall("a");
  await recordToolCall("b");
  const tools = await getToolUsage();
  assertEquals(tools[0].tool, "a");
  assertEquals(tools[0].calls, 3);
});

Deno.test("recordToolCall is bounded at 64 distinct tools per day", async () => {
  reset();
  for (let i = 0; i < 70; i++) await recordToolCall(`tool-${i}`);
  const tools = await getToolUsage();
  assertEquals(tools.length, 64);
});

Deno.test("recordToolCall rejects empty names", async () => {
  reset();
  await recordToolCall("");
  await recordToolCall(null);
  assertEquals((await getToolUsage()).length, 0);
});

Deno.test("expired day buckets are excluded from the rollup", async () => {
  reset();
  const old = Date.now() - 9 * 24 * 60 * 60 * 1000;
  await recordToolCall("ancient", old);
  await recordToolCall("fresh");
  const tools = await getToolUsage();
  assertEquals(tools.length, 1);
  assertEquals(tools[0].tool, "fresh");
});

Deno.test("clearUsage clears ordinary + provider-server tool counters with the ledger", async () => {
  reset();
  await recordToolCall("tabs.create");
  await recordServerToolUsage({ provider: "gemini", tool: "google_search", queries: 2 });
  await clearUsage();
  const raw = await globalThis.chrome.storage.local.get([TOOL_USAGE_KEY, SERVER_TOOL_USAGE_KEY]);
  assertEquals(Object.keys(raw[TOOL_USAGE_KEY]?.days ?? {}).length, 0);
  assertEquals(Object.keys(raw[SERVER_TOOL_USAGE_KEY]?.days ?? {}).length, 0);
  assertEquals((await getToolUsage()).length, 0);
  assertEquals((await getServerToolUsage()).length, 0);
});
