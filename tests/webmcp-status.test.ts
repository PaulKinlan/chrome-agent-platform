// tests/webmcp-status.test.ts — unit tests for the WebMCP discovery observability
// fix (Paul 2026-08-18): the content scripts now emit structured [WebMCP] logs
// (gated by an owner diagnostics toggle) and the SW exposes `webmcp.status` /
// `webmcp.diagnostics.*` routes. This test verifies (a) the page-facing route
// allowlist admits the content-script's read-only diagnostics read, and (b) the
// REAL isolated bridge (content/content-script.js) emits [WebMCP:bridge] logs +
// forwards tools.upsert when the diagnostics gate is on.
// @ts-nocheck — the content script runs in a mocked browser context.

import { assert, assertEquals } from "jsr:@std/assert@1";

const BRIDGE_SRC = Deno.readTextFileSync(
  new URL("../extension/content/content-script.js", import.meta.url).pathname,
);

Deno.test("webmcp diagnostics: PAGE_ALLOWED_ROUTES admits webmcp.diagnostics.get", async () => {
  // Import the REAL pure.js module and assert the content-script route allowlist
  // now admits the read-only diagnostics read (so a page's isolated bridge can
  // read the owner's toggle without being able to touch any admin route).
  const mod = await import("../extension/lib/pure.js");
  assert(
    mod.PAGE_ALLOWED_ROUTES.has("webmcp.diagnostics.get"),
    "webmcp.diagnostics.get must be in PAGE_ALLOWED_ROUTES",
  );
  // The WRITE route + the status surface are extension-only (never page-facing).
  assertEquals(mod.PAGE_ALLOWED_ROUTES.has("webmcp.diagnostics.set"), false);
  assertEquals(mod.PAGE_ALLOWED_ROUTES.has("webmcp.status"), false);
});

Deno.test("webmcp diagnostics: isolated bridge logs [WebMCP:bridge] + forwards tools.upsert", async () => {
  const logs = [];
  const posted = [];
  const sent = [];
  let windowMessageListener = null;
  let runtimeMessageListener = null;

  const windowObj = {
    postMessage(msg) { posted.push(msg); },
    addEventListener(type, fn) {
      if (type === "message") windowMessageListener = fn;
    },
  };
  const documentObj = { readyState: "complete" };
  const chromeObj = {
    runtime: {
      sendMessage(msg) {
        sent.push(msg);
        if (msg?.type === "webmcp.diagnostics.get") {
          return Promise.resolve({ enabled: true });
        }
        return Promise.resolve({ ok: true });
      },
      onMessage: { addListener(fn) { runtimeMessageListener = fn; } },
    },
  };
  const mockConsole = {
    log: (...a) => logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")),
    debug() {}, warn() {}, error() {},
  };

  const fn = new Function(
    "window", "document", "location", "crypto", "chrome", "setTimeout", "clearTimeout", "console",
    BRIDGE_SRC + "\n;",
  );
  fn(
    windowObj,
    documentObj,
    { origin: "https://example.com" },
    { randomUUID: () => "bridge-nonce" },
    chromeObj,
    (cb) => { cb(); return 0; }, // the re-poll timeouts run synchronously
    () => {},
    mockConsole,
  );

  // Let ensureMainWorld's async refreshDiagnostics resolve + post the init
  // handshake (which triggers the "start" log).
  await new Promise((r) => setTimeout(r, 30));

  assert(
    posted.some((m) => m?.type === "init" && m.diagnostics === true),
    "the init handshake must carry diagnostics:true (gated flag threaded to MAIN)",
  );
  assert(
    logs.some((l) => l.includes("[WebMCP:bridge]") && l.includes("start")),
    "the bridge emits a [WebMCP:bridge] start log: " + JSON.stringify(logs),
  );

  // Feed a "tools" report into the bridge's window listener — it must forward it
  // to the SW as tools.upsert AND log "tools-reported" with the origin + names.
  assert(windowMessageListener, "window message listener registered");
  windowMessageListener({
    source: windowObj,
    data: {
      __cairn_bridge: true,
      type: "tools",
      origin: "https://example.com",
      tools: [
        { name: "shop.total", source: "declared", description: "", inputSchema: {} },
        { name: "greet", source: "inferred", description: "", inputSchema: {} },
      ],
    },
  });
  await new Promise((r) => setTimeout(r, 10));

  const upsert = sent.find((m) => m?.type === "tools.upsert");
  assert(upsert, "the bridge must forward tools.upsert to the SW");
  assertEquals(upsert.origin, "https://example.com");
  assertEquals(upsert.tools.length, 2);
  assert(
    logs.some((l) => l.includes("tools-reported") && l.includes("shop.total") && l.includes("greet")),
    "the bridge logs tools-reported with the tool names: " + JSON.stringify(logs),
  );
});
