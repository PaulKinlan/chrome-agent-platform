import { assertEquals } from "jsr:@std/assert@1";
import { auditedAttachedDeclaredCall, invokeAttachedDeclaredFromPage } from "../extension/lib/attached-webmcp-invocation.js";

const origin = "https://declared.test";
const binding = { origin, tabId: 7, documentId: "chrome-doc-one" };
const descriptor = { origin, name: "search_products", source: "declared", inputSchema: { type: "object", properties: { query: { type: "string" } } } };
const args = { query: "pie" };

Deno.test("ckebt D3: MAIN-world invoke selects only declared getTools identity, not a colliding page global", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  const globalFn = Object.getOwnPropertyDescriptor(globalThis, "search_products");
  let declaredCalls = 0;
  let globalCalls = 0;
  try {
    Object.defineProperty(globalThis, "document", { configurable: true, value: { modelContext: {
      getTools: async () => [{ ...descriptor, execute: async (input: unknown) => { declaredCalls++; return { from: "declared", input }; } }],
    } } });
    Object.defineProperty(globalThis, "search_products", { configurable: true, value: () => { globalCalls++; return { from: "inferred" }; } });
    assertEquals(await invokeAttachedDeclaredFromPage(descriptor.name, args, JSON.stringify(descriptor.inputSchema)),
      { ok: true, result: { from: "declared", input: args } });
    assertEquals(declaredCalls, 1);
    assertEquals(globalCalls, 0);
    assertEquals(await invokeAttachedDeclaredFromPage("not_in_registry", args, JSON.stringify(descriptor.inputSchema)),
      { ok: false, error: "declared_tool_unavailable" });
  } finally {
    if (original) Object.defineProperty(globalThis, "document", original); else Reflect.deleteProperty(globalThis, "document");
    if (globalFn) Object.defineProperty(globalThis, "search_products", globalFn); else Reflect.deleteProperty(globalThis, "search_products");
  }
});

Deno.test("ckebt D3: schema drift or oversized result fails closed with no fallback second call", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  let calls = 0;
  try {
    Object.defineProperty(globalThis, "document", { configurable: true, value: { modelContext: {
      getTools: async () => [{ ...descriptor, inputSchema: { type: "object", properties: { changed: { type: "number" } } },
        execute: async () => { calls++; return "x".repeat(20000); } }],
    } } });
    assertEquals(await invokeAttachedDeclaredFromPage(descriptor.name, args, JSON.stringify(descriptor.inputSchema)),
      { ok: false, error: "declared_tool_changed" });
    assertEquals(calls, 0);
    const changed = JSON.stringify({ type: "object", properties: { changed: { type: "number" } } });
    assertEquals(await invokeAttachedDeclaredFromPage(descriptor.name, args, changed),
      { ok: false, error: "declared_tool_result_unavailable" });
    assertEquals(calls, 1, "no retry of a potentially consequential page effect");
  } finally {
    if (original) Object.defineProperty(globalThis, "document", original); else Reflect.deleteProperty(globalThis, "document");
  }
});

function deps(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  return { calls,
    runActive: () => true,
    livePermission: async () => true,
    getTab: async () => ({ id: 7, url: "https://declared.test/items" }),
    attestTopFrame: async () => [{ frameId: 0, documentId: binding.documentId, result: true }],
    requiredAudit: async () => { calls.push("audit"); },
    executeExactDocument: async (_id: number, docId: string) => {
      calls.push(`execute:${docId}`);
      return [{ frameId: 0, documentId: docId, result: { ok: true, result: "done" } }];
    },
    ...overrides,
  };
}

Deno.test("ckebt D3: WAL append MUST precede exact-document page effect and post-call authority check", async () => {
  const io = deps();
  assertEquals(await auditedAttachedDeclaredCall(binding, descriptor, args, io), { ok: true, result: "done" });
  assertEquals(io.calls, ["audit", `execute:${binding.documentId}`]);
  const blocked = deps({ requiredAudit: async () => { throw Error("OPFS unavailable"); } });
  assertEquals(await auditedAttachedDeclaredCall(binding, descriptor, args, blocked), { ok: false, error: "site_tool_audit_unavailable" });
  assertEquals(blocked.calls, []);
});

Deno.test("ckebt D3: navigation, cancelled run, permission loss after WAL, and wrong Chrome result never succeed", async () => {
  for (const change of [
    { executeExactDocument: async () => [{ frameId: 0, documentId: "new-document", result: { ok: true } }] },
    { attestTopFrame: async () => [{ frameId: 0, documentId: "new-document", result: true }] },
    { livePermission: async () => false },
    { runActive: () => false },
  ]) {
    const io = deps(change);
    assertEquals((await auditedAttachedDeclaredCall(binding, descriptor, args, io)).ok, false);
    assertEquals(io.calls, change.executeExactDocument ? ["audit"] : [],
      "a wrong returned document can only be detected after the required start row");
  }
  let attestCount = 0;
  const navigatedDuringWal = deps({ attestTopFrame: async () => [{ frameId: 0, documentId: ++attestCount > 1 ? "new-document" : binding.documentId, result: true }] });
  assertEquals((await auditedAttachedDeclaredCall(binding, descriptor, args, navigatedDuringWal)).ok, false);
  assertEquals(navigatedDuringWal.calls, ["audit"]); // WAL may append; effect must not run
});
