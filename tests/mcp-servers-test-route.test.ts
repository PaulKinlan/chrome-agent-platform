// tests/mcp-servers-test-route.test.ts — the "Test connection" route behind the
// Settings MCP-servers section (CAP-FB-20260831-MCP-GLOBAL-UI-01).
//
// mcp.servers.test connects to ONE remote server via the injected mcp-client
// mount (per-server-resilient), lists its tools, and returns an honest
// {ok, toolCount, toolNames} / {ok:false, error}. The auth token is handled
// EXACTLY like the provider key: a BLANK token on a stored id reuses the stored
// credential — the page never has to resend a secret to test it — and the token
// NEVER crosses back out in the response. stdio/command and non-http(s) servers
// are rejected before any connection is attempted.
// @ts-nocheck — the chrome/kv mock is intentionally dynamic (no types in Deno).

import { assert, assertEquals } from "jsr:@std/assert@1";
import { createMcpRoutes } from "../extension/background/routes/mcp.js";
import { setGlobalMcpServers } from "../extension/lib/mcp-config.js";

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

const SETTINGS = { principal: "owner-options" };

/** A fake mount that records the configs it was handed and returns a scripted
 * result — the real mcp-client is not exercised here (that is the transport
 * spike's KAT). */
function fakeMount(result, captured) {
  return async (configs) => {
    captured.configs = configs;
    let closed = false;
    return { ...result, close: async () => { closed = true; captured.closed = true; }, __closed: () => closed };
  };
}

Deno.test("mcp.servers.test — route exists and is Settings-only", async () => {
  const routes = createMcpRoutes({ mountRemoteMcpServers: fakeMount({ tools: {}, servers: [] }, {}) });
  assert(typeof routes["mcp.servers.test"] === "function", "mcp.servers.test must be a registered route");
  let threw = false;
  try {
    await routes["mcp.servers.test"]({ server: { name: "x", transport: "http", url: "https://ex.com/mcp" } }, { principal: "page" });
  } catch {
    threw = true;
  }
  assert(threw, "a non-Settings sender must be rejected");
});

Deno.test("mcp.servers.test — success returns tool count + names, closes the connection", async () => {
  const captured = {};
  const routes = createMcpRoutes({
    mountRemoteMcpServers: fakeMount({
      tools: {
        "mcp__calc__echo": { name: "mcp__calc__echo" },
        "mcp__calc__add": { name: "mcp__calc__add" },
      },
      servers: [{ name: "calc", ok: true, toolCount: 2 }],
    }, captured),
  });
  const res = await routes["mcp.servers.test"](
    { server: { id: "calc", name: "Calc", transport: "http", url: "https://ex.com/mcp" } },
    SETTINGS,
  );
  assertEquals(res.ok, true);
  assertEquals(res.toolCount, 2);
  assertEquals(res.toolNames, ["add", "echo"]); // sorted, namespace stripped
  assertEquals(captured.closed, true, "the test connection must be torn down");
});

Deno.test("mcp.servers.test — a per-server failure is reported honestly, never thrown", async () => {
  const routes = createMcpRoutes({
    mountRemoteMcpServers: fakeMount({
      tools: {},
      servers: [{ name: "calc", ok: false, error: "Failed to fetch" }],
    }, {}),
  });
  const res = await routes["mcp.servers.test"](
    { server: { name: "calc", transport: "http", url: "https://nope.example/mcp" } },
    SETTINGS,
  );
  assertEquals(res.ok, false);
  assertEquals(res.error, "Failed to fetch");
});

Deno.test("mcp.servers.test — an invalid server is rejected before any connection", async () => {
  let mountCalled = false;
  const routes = createMcpRoutes({
    mountRemoteMcpServers: async () => { mountCalled = true; return { tools: {}, servers: [], close: async () => {} }; },
  });
  // stdio transport is not a remote transport — must be refused up front.
  const res = await routes["mcp.servers.test"](
    { server: { name: "local", transport: "stdio", url: "https://ex.com/mcp" } },
    SETTINGS,
  );
  assertEquals(res.ok, false);
  assert(!mountCalled, "an invalid server must not reach the mount");
});

Deno.test("mcp.servers.test — a blank token reuses the STORED credential (provider-key parity)", async () => {
  store.clear();
  // Seed a stored server WITH a token (as a Settings save would).
  await setGlobalMcpServers([
    { id: "calc", name: "Calc", transport: "http", url: "https://ex.com/mcp", auth: { headerName: "Authorization", token: "secret-token" } },
  ]);
  const captured = {};
  const routes = createMcpRoutes({
    mountRemoteMcpServers: fakeMount({ tools: {}, servers: [{ name: "calc", ok: true, toolCount: 0 }] }, captured),
  });
  // The page tests with a BLANK token (it never saw the stored one).
  const res = await routes["mcp.servers.test"](
    { server: { id: "calc", name: "Calc", transport: "http", url: "https://ex.com/mcp", auth: { headerName: "Authorization", token: "" } } },
    SETTINGS,
  );
  assertEquals(res.ok, true);
  const headers = captured.configs?.[0]?.transport?.headers ?? {};
  assertEquals(headers.Authorization, "secret-token", "the blank-token test must reuse the stored credential");
});
