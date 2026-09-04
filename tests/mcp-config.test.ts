// tests/mcp-config.test.ts — the MCP server config model + storage + resolver.
//
// CAP-FB-20260831-MCP-CONFIG-STORE-01. The PURE config layer for remote MCP
// servers: validate/normalize a server, keep a global list and a per-agent
// list, resolve the effective set (global ∪ agent minus disabled, dedup by id),
// and NEVER surface a stored credential to a page/model (a redacted read only).
// stdio/command server types and non-http(s) URLs are rejected — the extension
// supports remote MCP (Streamable HTTP / SSE) only (docs/MCP-SUPPORT-DESIGN.md).
// @ts-nocheck — the chrome/kv mock is intentionally dynamic (no types in Deno).

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  effectiveMcpServers,
  getGlobalMcpServers,
  getGlobalMcpServersRedacted,
  normalizeMcpServer,
  normalizeMcpServerList,
  redactMcpServer,
  resolveEffectiveMcpServers,
  setGlobalMcpServers,
} from "../extension/lib/mcp-config.js";
import {
  getNamedAgentMcpServers,
  setNamedAgentMcpServers,
} from "../extension/lib/named-agents.js";
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
        for (const k of (key == null ? [...store.keys()] : Array.isArray(key) ? key : [key])) {
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

const GOOD = {
  id: "calc",
  name: "Calculator",
  transport: "http",
  url: "https://mcp.example.com/rpc",
  auth: { headerName: "Authorization", token: "Bearer sk-test-not-real" },
  enabled: true,
};

Deno.test("normalizeMcpServer accepts a good remote server", () => {
  const s = normalizeMcpServer(GOOD);
  assert(s, "a valid server must normalize");
  assertEquals(s.id, "calc");
  assertEquals(s.name, "Calculator");
  assertEquals(s.transport, "http");
  assertEquals(s.url, "https://mcp.example.com/rpc");
  assertEquals(s.enabled, true);
  assertEquals(s.auth.headerName, "Authorization");
  assertEquals(s.auth.token, "Bearer sk-test-not-real");
});

Deno.test("normalizeMcpServer accepts sse transport", () => {
  const s = normalizeMcpServer({ ...GOOD, transport: "sse", auth: undefined });
  assert(s);
  assertEquals(s.transport, "sse");
  assertEquals(s.auth, undefined);
});

Deno.test("normalizeMcpServer rejects stdio / command transports", () => {
  assertEquals(normalizeMcpServer({ ...GOOD, transport: "stdio" }), null);
  assertEquals(normalizeMcpServer({ ...GOOD, transport: "command" }), null);
  assertEquals(normalizeMcpServer({ id: "x", name: "x", command: "node server.js" }), null);
  assertEquals(normalizeMcpServer({ ...GOOD, transport: "" }), null);
});

Deno.test("normalizeMcpServer rejects a non-http(s) url", () => {
  assertEquals(normalizeMcpServer({ ...GOOD, url: "ws://mcp.example.com" }), null);
  assertEquals(normalizeMcpServer({ ...GOOD, url: "file:///etc/passwd" }), null);
  assertEquals(normalizeMcpServer({ ...GOOD, url: "not a url" }), null);
  assertEquals(normalizeMcpServer({ ...GOOD, url: "" }), null);
});

Deno.test("normalizeMcpServer rejects a bad id (namespace segment)", () => {
  // `__` is forbidden inside a segment (the mcp__<server>__<tool> separator).
  assertEquals(normalizeMcpServer({ ...GOOD, id: "bad__id" }), null);
  assertEquals(normalizeMcpServer({ ...GOOD, id: "has space" }), null);
  // Empty id derives a slug from the name.
  assertEquals(normalizeMcpServer({ ...GOOD, id: "" }).id, "calculator");
});

Deno.test("redactMcpServer strips the token, keeps a presence bit", () => {
  const r = redactMcpServer(normalizeMcpServer(GOOD));
  assertEquals(r.auth.headerName, "Authorization");
  assertEquals(r.auth.hasToken, true);
  assert(!("token" in r.auth), "the token must never cross out redacted");
  const j = JSON.stringify(r);
  assert(!j.includes("sk-test-not-real"), "no credential in the redacted view");
});

Deno.test("resolveEffectiveMcpServers = global ∪ agent minus disabled, dedup by id", () => {
  const global = [
    { id: "calc", name: "Calc", transport: "http", url: "https://a.example/rpc", enabled: true },
    { id: "wiki", name: "Wiki", transport: "sse", url: "https://b.example/sse", enabled: true },
    { id: "off", name: "Off", transport: "http", url: "https://c.example/rpc", enabled: false },
  ];
  const agent = [
    // adds its own
    { id: "notes", name: "Notes", transport: "http", url: "https://d.example/rpc", enabled: true },
    // disables an inherited global (same id, enabled:false)
    { id: "wiki", name: "Wiki", transport: "sse", url: "https://b.example/sse", enabled: false },
    // duplicate id in the agent list — dedup keeps one
    { id: "notes", name: "Notes 2", transport: "http", url: "https://d2.example/rpc", enabled: true },
  ];
  const eff = resolveEffectiveMcpServers(global, agent);
  const ids = eff.map((s) => s.id).sort();
  // calc (global, enabled), notes (agent). wiki disabled by agent, off disabled global.
  assertEquals(ids, ["calc", "notes"]);
  // dedup by id
  assertEquals(eff.filter((s) => s.id === "notes").length, 1);
});

Deno.test("storage round-trip: global set/get, redacted read hides the token", async () => {
  store.clear();
  const saved = await setGlobalMcpServers([GOOD]);
  // set returns the REDACTED view
  assert(!("token" in (saved[0].auth ?? {})));
  // the SW-only full read carries the token back
  const full = await getGlobalMcpServers();
  assertEquals(full[0].auth.token, "Bearer sk-test-not-real");
  // the UI read is redacted
  const red = await getGlobalMcpServersRedacted();
  assertEquals(red[0].auth.hasToken, true);
  assert(!JSON.stringify(red).includes("sk-test-not-real"));
});

Deno.test("effectiveMcpServers(agentId) merges the stored global + per-agent lists", async () => {
  store.clear();
  await setGlobalMcpServers([
    { id: "calc", name: "Calc", transport: "http", url: "https://a.example/rpc", enabled: true },
  ]);
  // Seed the agent record directly (createNamedAgent provisions an OPFS sandbox
  // that has no navigator.storage under Deno — the mutation path we exercise
  // does not touch OPFS).
  await kvSet({ "cap:namedAgents": { ada: { id: "ada", name: "Ada", instanceId: "ada-1", revision: 1 } } });
  await setNamedAgentMcpServers("ada", [
    { id: "notes", name: "Notes", transport: "http", url: "https://d.example/rpc", enabled: true },
  ]);
  const perAgentFull = await getNamedAgentMcpServers("ada");
  assertEquals(perAgentFull[0].id, "notes");

  const globalOnly = await effectiveMcpServers();
  assertEquals(globalOnly.map((s) => s.id).sort(), ["calc"]);

  const eff = await effectiveMcpServers("ada");
  assertEquals(eff.map((s) => s.id).sort(), ["calc", "notes"]);
});

Deno.test("normalizeMcpServerList dedups by id and drops invalid entries", () => {
  const list = normalizeMcpServerList([
    { id: "calc", name: "Calc", transport: "http", url: "https://a.example/rpc", enabled: true },
    { id: "calc", name: "Calc v2", transport: "sse", url: "https://a2.example/sse", enabled: true },
    { id: "bad", name: "Bad", transport: "stdio", url: "https://a.example/rpc" },
  ]);
  assertEquals(list.length, 1);
  // last write wins on dedup
  assertEquals(list[0].name, "Calc v2");
  assertEquals(list[0].transport, "sse");
});

// ── dptw (R10): MCP config field/count caps removed ────────────────────────
Deno.test("mcp-config (dptw): a 16 KiB bearer token, long id/name/url, and 40 servers all survive", () => {
  const token = `tok_${"a".repeat(16 * 1024)}`; // past the old 8192-char cap
  const longId = `server-${"x".repeat(100)}`; // past the old 64-char id cap (valid charset)
  const longName = `My MCP Server ${"n".repeat(200)}`; // past the old 120-char name cap
  const longUrl = `https://mcp.example.com/${"p".repeat(3000)}`; // past the old 2048-char url cap
  const one = normalizeMcpServer({
    id: longId, name: longName, transport: "http", url: longUrl,
    auth: { headerName: "authorization", token },
  });
  assert(one, "a server with past-cap fields is accepted");
  assertEquals(one.auth.token, token, "the token is stored whole (no 8192 slice)");
  assertEquals(one.id, longId, "the long id is kept");
  assertEquals(one.name, longName, "the long name is kept, not sliced");
  assertEquals(one.url, longUrl, "the long url is kept");
  // 40 distinct servers — past the old 32 count cap.
  const list = normalizeMcpServerList(
    Array.from({ length: 40 }, (_, i) => ({ id: `srv-${i}`, name: `S${i}`, transport: "http", url: `https://mcp-${i}.example.com/` })),
  );
  assertEquals(list.length, 40, "all 40 servers are kept — no 32-server cap");
});
