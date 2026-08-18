// tests/named-agents-provider.test.ts — the per-agent provider OVERRIDE.
//
// A named agent can have its OWN provider/model (a COMPLETE provider-specific
// config) that overrides the global. The override's apiKey must NEVER leak into
// a list/get (only the SW's model-resolution path reads it back). This drives
// the registry (kv) + the pure provider resolution without the OPFS sandbox.
// @ts-nocheck — the chrome/kv mock is intentionally dynamic (no types in Deno).

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  getNamedAgent,
  getNamedAgentProvider,
  listNamedAgents,
  normalizeAgentProvider,
  redactAgentProvider,
  setNamedAgentProvider,
} from "../extension/lib/named-agents.js";
import { getModelForAgent, resolveModelFromConfig } from "../extension/lib/provider.js";
import { kvSet } from "../extension/lib/kv.js";


const store = new Map();
function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}
globalThis.chrome = {
  permissions: { contains: async () => true },
  storage: {
    local: {
      get: async (key) => {
        const out = {};
        for (const k of (Array.isArray(key) ? key : [key])) {
          if (store.has(k)) out[k] = clone(store.get(k));
        }
        return out;
      },
      set: async (obj) => {
        for (const [k, v] of Object.entries(obj)) {
          if (v === undefined) store.delete(k);
          else store.set(k, clone(v));
        }
      },
      remove: async (keys) => {
        for (const k of (Array.isArray(keys) ? keys : [keys])) store.delete(k);
      },
    },
  },
};

const COMPLETE = {
  provider: "deepseek",
  baseURL: "https://api.deepseek.com/v1",
  apiKey: "sk-test-not-a-real-key",
  model: "deepseek-chat",
};

Deno.test("per-agent provider: normalizeAgentProvider validates + normalizes", () => {
  const ok = normalizeAgentProvider(COMPLETE);
  assertEquals(ok.provider, "deepseek");
  assertEquals(ok.apiKey, "sk-test-not-a-real-key");
  // Unknown provider id → null (never mix an unknown endpoint with a credential).
  assertEquals(normalizeAgentProvider({ ...COMPLETE, provider: "not-a-provider" }), null);
  assertEquals(normalizeAgentProvider(null), null);
  assertEquals(normalizeAgentProvider(undefined), null);
});

Deno.test("per-agent provider: redactAgentProvider strips the apiKey", () => {
  const r = redactAgentProvider(COMPLETE);
  assertEquals(r.provider, "deepseek");
  assertEquals(r.model, "deepseek-chat");
  assert(!("apiKey" in r), "the redacted provider must never carry the apiKey");
});

Deno.test("per-agent provider: set + clear round-trips, and list/get are redacted", async () => {
  store.clear();
  // Seed the registry directly (no OPFS needed for the provider path).
  await kvSet({ "cap:namedAgents": { paul: { id: "paul", name: "Paul", role: "reader", createdAt: 1, updatedAt: 1 } } });

  const set = await setNamedAgentProvider("paul", COMPLETE);
  assert(set.ok, "setNamedAgentProvider must succeed");

  // The SW-only resolution path reads the FULL config (with the key).
  const full = await getNamedAgentProvider("paul");
  assertEquals(full.provider, "deepseek");
  assertEquals(full.apiKey, "sk-test-not-a-real-key");

  // The list/get surfaces are REDACTED (no key).
  const listed = await listNamedAgents();
  assertEquals(listed.length, 1);
  assert(!("apiKey" in (listed[0].provider ?? {})), "listNamedAgents must redact the key");
  const got = await getNamedAgent("paul");
  assert(!("apiKey" in (got.provider ?? {})), "getNamedAgent must redact the key");

  // null clears the override (inherit the global).
  await setNamedAgentProvider("paul", null);
  assertEquals(await getNamedAgentProvider("paul"), null);
});

Deno.test("per-agent provider: getModelForAgent resolves the override, else the global", async () => {
  // An override with a missing model id falls back to the demo (no network at
  // resolution time) — the providerName still names the override.
  const resolved = await resolveModelFromConfig({
    provider: "deepseek",
    baseURL: "https://api.deepseek.com/v1",
    apiKey: "sk-x",
    model: "",
  });
  assertEquals(resolved.modelId, "demo-local"); // missing model → demo fallback
  assert(resolved.providerName.includes("deepseek"), "the fallback names the override provider");

  // A null override → the global (demo) path (getModelForAgent falls back).
  const viaAgent = await getModelForAgent(null);
  assertEquals(viaAgent.modelId, "demo-local");
});
