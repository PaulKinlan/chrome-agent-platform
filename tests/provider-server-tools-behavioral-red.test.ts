// Behavioral falsification subset: imports ONLY seams that already existed on
// base 550a9c8b, so the base reaches assertions instead of failing at import.
// @ts-nocheck — browser + AI SDK test doubles are intentionally dynamic.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { tool } from "ai";
import { z } from "zod";
import { createAgent } from "../extension/lib/agent.js";
import { createDemoModel } from "../extension/lib/models/demo-model.js";
import {
  executableBuiltinToolRecords,
  LazyToolProtocol,
} from "../extension/lib/lazy-tool-protocol.js";
import { resolveModelFromConfig } from "../extension/lib/provider.js";
import { clearUsage } from "../extension/lib/usage.js";
import { resetUsageMigration } from "../extension/lib/usage-store.js";
import { installFakeIdb, resetFakeIdb } from "./fake-idb.js";
import { installFakeLocks, resetFakeLocks } from "./fake-locks.js";

const storage = new Map();
function installBrowserFakes() {
  globalThis.chrome = {
    permissions: { contains: async () => true },
    storage: { local: {
      get: async (keys) => {
        const out = {};
        for (const key of (Array.isArray(keys) ? keys : [keys])) {
          if (storage.has(key)) out[key] = structuredClone(storage.get(key));
        }
        return out;
      },
      set: async (values) => {
        for (const [key, value] of Object.entries(values)) storage.set(key, structuredClone(value));
      },
      remove: async (keys) => {
        for (const key of (Array.isArray(keys) ? keys : [keys])) storage.delete(key);
      },
    } },
  };
}

Deno.test("behavioral RED: real LazyToolProtocol.execute latches, then provider boundary honors revocation", async () => {
  storage.clear();
  resetFakeIdb(); installFakeIdb(); resetFakeLocks(); installFakeLocks(); resetUsageMigration(); installBrowserFakes();
  let active = false;
  let authorizationChecks = 0;
  const providerTool = { type: "provider", id: "google.google_search", name: "google_search", args: {} };
  const records = executableBuiltinToolRecords({
    activate_search: tool({
      description: "Activate provider search",
      inputSchema: z.object({}),
      execute: () => { active = true; return { activated: true }; },
    }),
  }, {
    version: "1.0.0",
    sourceGeneration: "behavioral-red:1",
    scope: { hub: true, agentId: "hub", origin: "", documentId: "" },
    capabilities: ["test.invoke"],
  });
  const protocol = new LazyToolProtocol({ readSources: async () => records });
  const context = { runId: "run-revoked", taskId: "task-1", runGeneration: "1", agentId: "hub", origin: "", documentId: "" };
  const searched = await protocol.search({ query: "activate search" }, context);
  assertEquals(searched.ok, true);
  const executed = await protocol.execute({ selectionRef: searched.results[0].selectionRef, arguments: {} }, context);
  assertEquals(executed.ok, true);
  assertEquals(active, true, "the REAL execute path reached the latch closure");

  const inner = createDemoModel();
  const providerCalls = [];
  const capturing = {
    ...inner,
    doStream(options) { providerCalls.push(options); return inner.doStream(options); },
  };
  const agent = createAgent({
    model: { model: capturing, modelId: "demo-local", providerName: "demo" },
    serverTooling: {
      latchRegistry: { latchedToolsFor: (runId) => active && runId === "run-revoked" ? [providerTool] : [] },
      isAuthorized: async () => { authorizationChecks++; return false; },
    },
  });
  await agent.run("hello", null, null, null, null, { runId: "run-revoked", taskId: "task-1" });
  assert(authorizationChecks > 0, "revocation was re-read at the actual provider boundary");
  assertEquals(providerCalls.some((call) => call.tools?.some((t) => t.type === "provider")), false);
});

Deno.test("behavioral RED: Clear usage removes the provider-server ledger", async () => {
  storage.clear();
  resetFakeIdb(); installFakeIdb(); resetFakeLocks(); installFakeLocks(); resetUsageMigration(); installBrowserFakes();
  storage.set("cap:usage:server-tools:v1", { v: 1, days: { "2026-08-29": [{ provider: "gemini", tool: "google_search", queries: 1 }] } });
  await clearUsage();
  assertEquals(storage.get("cap:usage:server-tools:v1")?.days, {});
});

Deno.test("behavioral RED: native Gemini display names resolve to a canonical model id", async () => {
  installBrowserFakes();
  const resolved = await resolveModelFromConfig({
    provider: "gemini",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKey: "test-key",
    model: "Gemini 3.7 Flash",
  });
  assertEquals(resolved.modelId, "gemini-3.7-flash");
});
