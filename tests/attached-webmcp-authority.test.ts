import { assertEquals } from "jsr:@std/assert@1";
import { createEphemeralSiteToolConsentStore } from "../extension/lib/ephemeral-site-tool-consent.js";
import { createAttachedDeclaredInvoker } from "../extension/lib/attached-webmcp-authority.js";

const origin = "https://declared.test";
const tool = { origin, name: "search_products", source: "declared", description: "Search", inputSchema: { type: "object", properties: { query: { type: "string" } } } };
function setup(decision: "allow" | "deny" = "allow", overrides: Record<string, unknown> = {}) {
  const consentStore = createEphemeralSiteToolConsentStore();
  const token = consentStore.begin({ runId: "run1", origin, tabId: 7, documentId: "doc1" });
  const binding = { origin, tabId: 7, documentId: "doc1" };
  const calls: string[] = [];
  const deps = {
    consentStore,
    findBinding: () => ({ binding, token }),
    runActive: () => true,
    readDeclared: async () => { calls.push("read"); return [tool]; },
    validateArgs: async (_schema: unknown, args: unknown) => ({ ok: true, data: args }),
    requestApproval: async () => { calls.push("ask"); return { ok: decision === "allow", approvalDenied: decision === "deny" }; },
    audit: async (_token: object, row: { event: string }) => { calls.push(row.event); },
    invoke: async (_binding: unknown, _tool: unknown, _args: unknown, options: { requiredAudit: () => Promise<void> }) => {
      await options.requiredAudit();
      calls.push("invoke");
      return { ok: true, result: "done" };
    },
    ...overrides,
  };
  return { consentStore, token, binding, calls, invoke: createAttachedDeclaredInvoker(deps) };
}
const input = { origin, name: tool.name, args: { query: "pie" } };
const actor = { principal: "model", executionId: "run1" };

Deno.test("ckebt D1/D3: only live model run bound to exact document may ask or dispatch", async () => {
  const s = setup();
  for (const bad of [{ principal: "extension", executionId: "run1" }, { principal: "model", executionId: "other" }]) {
    assertEquals((await s.invoke(input, bad)).ok, false);
  }
  assertEquals(s.calls, []);
  s.consentStore.end(s.token);
  assertEquals((await s.invoke(input, actor)).ok, false);
  assertEquals(s.calls, []);
});

Deno.test("ckebt D1/D3: owner Deny is sticky within the run, blocks retry without another card/effect", async () => {
  const s = setup("deny");
  assertEquals((await s.invoke(input, actor)).ok, false);
  assertEquals(s.consentStore.snapshot(s.token, tool).state, "denied");
  assertEquals((await s.invoke(input, actor)).ok, false);
  assertEquals(s.calls.filter((x) => x === "ask").length, 1);
  assertEquals(s.calls.includes("invoke"), false);
  const drifted = { ...tool, inputSchema: { type: "object", properties: { different: { type: "number" } } } };
  assertEquals(s.consentStore.snapshot(s.token, drifted).state, "denied", "Deny survives page descriptor drift");
});

Deno.test("ckebt D1/D3: owner Allow only after audited decision; required start WAL precedes effect", async () => {
  const s = setup();
  assertEquals(await s.invoke(input, actor), { ok: true, result: "done" });
  assertEquals(s.consentStore.snapshot(s.token, tool).state, "allowed");
  const start = s.calls.indexOf("invocation-started");
  const effect = s.calls.indexOf("invoke");
  assertEquals(start >= 0 && effect > start, true);
  assertEquals(s.calls.includes("invocation-finished"), true);
  assertEquals(s.calls.includes("consent-requested"), true);
  assertEquals(s.calls.includes("consent-decided"), true);
});

Deno.test("ckebt Q2(a): a page global or inferred source cannot become an attached callable", async () => {
  const s = setup("allow", { readDeclared: async () => [{ ...tool, source: "inferred" }] });
  assertEquals((await s.invoke(input, actor)).ok, false);
  assertEquals(s.calls, []);
});

Deno.test("ckebt D1/D3: failed required WAL, cancellation, or descriptor drift cannot invoke", async () => {
  const wal = setup("allow", { audit: async (_token: object, row: { event: string }) => {
    if (row.event === "invocation-started") throw Error("OPFS unavailable");
  } });
  assertEquals((await wal.invoke(input, actor)).ok, false);
  assertEquals(wal.calls.includes("invoke"), false);
  let live = true;
  const cancelled = setup("allow", { runActive: () => live, requestApproval: async () => { live = false; return { ok: true }; } });
  assertEquals((await cancelled.invoke(input, actor)).ok, false);
  assertEquals(cancelled.calls.includes("invoke"), false);
  let reads = 0;
  const changed = setup("allow", { readDeclared: async () => {
    reads++;
    return [{ ...tool, inputSchema: reads > 1 ? { type: "object", properties: { changed: { type: "boolean" } } } : tool.inputSchema }];
  } });
  assertEquals((await changed.invoke(input, actor)).ok, false);
  assertEquals(changed.calls.includes("invoke"), false);
});
