// tests/rpc-cache.test.ts — Unit tests for Hub RPC coalescing layer (extension/shared/rpc-cache.js)
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  cachedRpc,
  cacheKey,
  clearRpcCache,
  invalidateRpcCache,
  handleBroadcastEvent,
  getRpcCacheStats,
} from "../extension/shared/rpc-cache.js";

Deno.test("rpc-cache: key generation is deterministic and payload-sensitive", () => {
  const k1 = cacheKey("settings.get", { a: 1, b: 2 });
  const k2 = cacheKey("settings.get", { b: 2, a: 1 });
  const k3 = cacheKey("settings.get", { a: 1, b: 3 });
  const k4 = cacheKey("agents.list", { a: 1, b: 2 });

  assertEquals(k1, k2, "keys with differently ordered properties must match");
  assert(k1 !== k3, "keys with different values must not match");
  assert(k1 !== k4, "keys with different route names must not match");
});

Deno.test("rpc-cache: single-flight deduplication coalesces concurrent calls into one send", async () => {
  clearRpcCache();
  let sendCount = 0;
  const mockSend = async (type: string, payload: any) => {
    sendCount++;
    await new Promise((r) => setTimeout(r, 20));
    return { ok: true, data: `${type}-${JSON.stringify(payload)}` };
  };

  const p1 = cachedRpc("settings.get", { key: "foo" }, { send: mockSend });
  const p2 = cachedRpc("settings.get", { key: "foo" }, { send: mockSend });
  const p3 = cachedRpc("settings.get", { key: "foo" }, { send: mockSend });

  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

  assertEquals(sendCount, 1, "concurrent requests must coalesce into exactly one send call");
  assertEquals(r1, { ok: true, data: 'settings.get-{"key":"foo"}' });
  assertEquals(r2, r1);
  assertEquals(r3, r1);
});

Deno.test("rpc-cache: cached result is returned within TTL and expires after TTL", async () => {
  clearRpcCache();
  let sendCount = 0;
  const mockSend = async (type: string) => {
    sendCount++;
    return { ok: true, count: sendCount };
  };

  // 1st call: sends
  const res1 = await cachedRpc("agents.list", {}, { send: mockSend, ttlMs: 50 });
  assertEquals(res1, { ok: true, count: 1 });
  assertEquals(sendCount, 1);

  // 2nd call (immediate): served from cache
  const res2 = await cachedRpc("agents.list", {}, { send: mockSend, ttlMs: 50 });
  assertEquals(res2, { ok: true, count: 1 });
  assertEquals(sendCount, 1);

  // Wait for TTL to expire
  await new Promise((r) => setTimeout(r, 60));

  // 3rd call: expired, must re-fetch
  const res3 = await cachedRpc("agents.list", {}, { send: mockSend, ttlMs: 50 });
  assertEquals(res3, { ok: true, count: 2 });
  assertEquals(sendCount, 2);
});

Deno.test("rpc-cache: rejected promise is not cached", async () => {
  clearRpcCache();
  let attempts = 0;
  const mockSend = async () => {
    attempts++;
    if (attempts === 1) {
      throw new Error("transient worker failure");
    }
    return { ok: true, attempts };
  };

  await assertRejects(
    () => cachedRpc("skills.list", {}, { send: mockSend }),
    Error,
    "transient worker failure"
  );

  assertEquals(getRpcCacheStats().inFlightCount, 0, "in-flight map must be cleaned up on failure");

  // Subsequent call should retry and not return the rejection
  const retryResult = await cachedRpc("skills.list", {}, { send: mockSend });
  assertEquals(retryResult, { ok: true, attempts: 2 });
});

Deno.test("rpc-cache: failed response (ok: false) is not cached", async () => {
  clearRpcCache();
  let attempts = 0;
  const mockSend = async () => {
    attempts++;
    if (attempts === 1) {
      return { ok: false, error: "not ready" };
    }
    return { ok: true, attempts };
  };

  const res1 = await cachedRpc("harnesses.list", {}, { send: mockSend });
  assertEquals(res1, { ok: false, error: "not ready" });

  const res2 = await cachedRpc("harnesses.list", {}, { send: mockSend });
  assertEquals(res2, { ok: true, attempts: 2 }, "ok: false response must not be cached");
});

Deno.test("rpc-cache: explicit invalidation by prefix purges only matching entries", async () => {
  clearRpcCache();
  let agentCalls = 0;
  let providerCalls = 0;

  const mockSend = async (type: string) => {
    if (type.startsWith("agent.")) {
      agentCalls++;
      return { ok: true, agentCalls };
    }
    providerCalls++;
    return { ok: true, providerCalls };
  };

  await cachedRpc("agent.directory", {}, { send: mockSend });
  await cachedRpc("provider.status", {}, { send: mockSend });
  assertEquals(agentCalls, 1);
  assertEquals(providerCalls, 1);

  // Invalidate agent routes
  invalidateRpcCache("agent.");

  // agent.directory re-fetches
  await cachedRpc("agent.directory", {}, { send: mockSend });
  assertEquals(agentCalls, 2);

  // provider.status remains cached
  await cachedRpc("provider.status", {}, { send: mockSend });
  assertEquals(providerCalls, 1);
});

Deno.test("rpc-cache: write RPC invalidates corresponding read caches", async () => {
  clearRpcCache();
  let readCalls = 0;
  const mockSend = async (type: string) => {
    if (type === "settings.get") {
      readCalls++;
      return { ok: true, value: readCalls };
    }
    return { ok: true };
  };

  await cachedRpc("settings.get", { key: "theme" }, { send: mockSend });
  assertEquals(readCalls, 1);

  // Calling a write RPC (settings.set) triggers cache invalidation
  await cachedRpc("settings.set", { key: "theme", value: "dark" }, { send: mockSend });

  // Next read is a fresh fetch
  await cachedRpc("settings.get", { key: "theme" }, { send: mockSend });
  assertEquals(readCalls, 2);
});

Deno.test("rpc-cache: broadcast events invalidate corresponding cached routes", async () => {
  clearRpcCache();
  let dirCalls = 0;
  const mockSend = async () => {
    dirCalls++;
    return { ok: true, dirCalls };
  };

  await cachedRpc("agent.directory", {}, { send: mockSend });
  assertEquals(dirCalls, 1);

  // Simulate agent-registry-changed broadcast
  handleBroadcastEvent("agent-registry-changed");

  await cachedRpc("agent.directory", {}, { send: mockSend });
  assertEquals(dirCalls, 2, "agent.directory must re-fetch after agent-registry-changed");
});

Deno.test("rpc-cache: mutating flows are never served from cache", async () => {
  clearRpcCache();
  let runs = 0;
  const mockSend = async (type: string) => {
    runs++;
    return { ok: true, runs };
  };

  const r1 = await cachedRpc("agent.run", { prompt: "test" }, { send: mockSend });
  const r2 = await cachedRpc("agent.run", { prompt: "test" }, { send: mockSend });

  assertEquals(runs, 2, "mutating flow agent.run must never be served from cache");
  assertEquals(r1, { ok: true, runs: 1 });
  assertEquals(r2, { ok: true, runs: 2 });
});
