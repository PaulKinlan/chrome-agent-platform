import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  readAttachedDeclaredWebmcpTools, readDeclaredWebmcpFromPage,
  projectAttachedDeclaredToolsForModel,
} from "../extension/lib/attached-webmcp-declared.js";

const binding = { origin: "https://declared.test", tabId: 7, documentId: "chrome-doc-one" };
const raw = { name: "search_products", description: "Find products", inputSchema: JSON.stringify({ type: "object", properties: { query: { type: "string" } } }) };
const injected = [{ ...raw, source: "declared" }];
const deps = (overrides: Record<string, unknown> = {}) => ({
  getTab: async () => ({ id: 7, url: "https://declared.test/items" }),
  executeTopFrame: async (_id: number, mode: string) => [{ frameId: 0, documentId: "chrome-doc-one", result: mode === "read" ? injected : true }],
  livePermission: async () => true,
  runActive: () => true,
  ...overrides,
});

Deno.test("ckebt Q2: MAIN-world probe reads fresh getTools only, never page globals or mc.tools", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalExposure = Object.getOwnPropertyDescriptor(globalThis, "webmcpExpose");
  try {
    Object.defineProperty(globalThis, "document", { configurable: true, value: { modelContext: {
      getTools: async () => [raw], tools: [{ name: "stale_registry" }],
    } } });
    Object.defineProperty(globalThis, "webmcpExpose", { configurable: true, value: [{ name: "inferred_secret" }] });
    assertEquals(await readDeclaredWebmcpFromPage(), injected);
    Object.defineProperty(globalThis, "document", { configurable: true, value: { modelContext: { tools: [{ name: "stale_registry" }] } } });
    assertEquals(await readDeclaredWebmcpFromPage(), []);
  } finally {
    if (original) Object.defineProperty(globalThis, "document", original); else Reflect.deleteProperty(globalThis, "document");
    if (originalExposure) Object.defineProperty(globalThis, "webmcpExpose", originalExposure);
    else Reflect.deleteProperty(globalThis, "webmcpExpose");
  }
});

Deno.test("ckebt Q2: before/read/after attest exact Chrome tab, top frame, document and origin", async () => {
  const expected = [{ origin: binding.origin, name: raw.name, description: raw.description, inputSchema: JSON.parse(raw.inputSchema), source: "declared" as const }];
  const calls: string[] = [];
  assertEquals(await readAttachedDeclaredWebmcpTools(binding, deps({ executeTopFrame: async (_id: number, mode: string) => {
    calls.push(mode); return [{ frameId: 0, documentId: binding.documentId, result: mode === "read" ? injected : true }];
  } })), expected);
  assertEquals(calls, ["attest", "read", "attest"]);
  for (const override of [
    { executeTopFrame: async (_id: number, mode: string) => [{ frameId: 0, documentId: mode === "read" ? "navigated" : binding.documentId, result: mode === "read" ? injected : true }] },
    { executeTopFrame: async (_id: number, mode: string) => [{ frameId: 1, documentId: binding.documentId, result: mode === "read" ? injected : true }] },
    { executeTopFrame: async (_id: number, mode: string) => [{ frameId: 0, documentId: mode === "attest" ? "navigated" : binding.documentId, result: mode === "read" ? injected : true }] },
    { getTab: async () => ({ id: 7, url: "https://evil.test/items" }) },
    { livePermission: async () => false },
    { runActive: () => false },
    { executeTopFrame: async (_id: number, mode: string) => [{ frameId: 0, documentId: binding.documentId, result: mode === "read" ? [{ ...raw, source: "inferred" }] : true }] },
  ]) assertEquals(await readAttachedDeclaredWebmcpTools(binding, deps(override)), []);
});

Deno.test("ckebt Q2: navigation after getTools or run reset after await cannot publish stale descriptors", async () => {
  let phase = 0;
  assertEquals(await readAttachedDeclaredWebmcpTools(binding, deps({
    executeTopFrame: async (_id: number, mode: string) => {
      if (mode === "read") phase = 1;
      return [{ frameId: 0, documentId: phase && mode === "attest" ? "new-document" : binding.documentId, result: mode === "read" ? injected : true }];
    },
  })), []);
  let active = true;
  assertEquals(await readAttachedDeclaredWebmcpTools(binding, deps({
    executeTopFrame: async (_id: number, mode: string) => {
      if (mode === "read") active = false;
      return [{ frameId: 0, documentId: binding.documentId, result: mode === "read" ? injected : true }];
    }, runActive: () => active,
  })), []);
});

Deno.test("ckebt Q2: malformed/oversize and duplicate declarations fail closed; no inferred JS", async () => {
  for (const result of [
    [...injected, { ...injected[0] }],
    [{ ...injected[0], description: "x".repeat(2049) }],
    [{ ...injected[0], inputSchema: "{" }],
    [{ ...injected[0], inputSchema: { type: "string" } }],
    Array.from({ length: 65 }, (_, i) => ({ ...injected[0], name: `tool_${i}` })),
    [{ ...injected[0], name: "bad name" }],
  ]) assertEquals(await readAttachedDeclaredWebmcpTools(binding, deps({ executeTopFrame: async (_id: number, mode: string) =>
    [{ frameId: 0, documentId: binding.documentId, result: mode === "read" ? result : true }] })), []);
});

Deno.test("ckebt Q2: model projection fences every page-controlled field, never the passive count", async () => {
  const descriptors = await readAttachedDeclaredWebmcpTools(binding, deps());
  const projected = projectAttachedDeclaredToolsForModel(descriptors, "fixedruntoken012345");
  assertEquals(projected.length, 1);
  assert(projected[0].includes("fixedruntoken012345"));
  assert(projected[0].includes("search_products"));
  assert(!JSON.stringify(projected).includes("executeTool"));
});
