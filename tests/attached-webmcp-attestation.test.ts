import { assert, assertEquals } from "jsr:@std/assert@1";
import { attestCurrentAttachedWebmcpTab } from "../extension/lib/attached-webmcp-attestation.js";

const registry = [{ origin: "https://example.test", documents: [
  { tabId: 9, documentId: "doc-one", url: "https://example.test/start", toolCount: 2 },
] }];

function browser({ urls = ["https://example.test/start"], documentId = "doc-one", frameId = 0 } = {}) {
  let read = 0;
  const calls: string[] = [];
  return {
    calls,
    getTab: async (id: number) => { calls.push("tab"); return { id, url: urls[Math.min(read++, urls.length - 1)] }; },
    executeTopFrame: async (id: number) => { calls.push("chrome-doc"); return [{ frameId, documentId, result: true }]; },
  };
}

Deno.test("3p3e.3: current top-frame Chrome document and same-origin registry yield only a count-bound candidate", async () => {
  const source = browser();
  const candidate = await attestCurrentAttachedWebmcpTab(9, { ...source, registry, enrolledOrigins: [] });
  assertEquals(candidate, { origin: "https://example.test", tabId: 9, documentId: "doc-one", toolCount: 2 });
  assertEquals(source.calls, ["tab", "chrome-doc", "tab"], "re-read the tab after the injection result");
});

Deno.test("3p3e.3: stale document, navigation, another frame, or enrolled site cannot lend a tab tool authority", async () => {
  for (const source of [
    browser({ documentId: "doc-replaced" }),
    browser({ urls: ["https://example.test/start", "https://evil.test/after"] }),
    browser({ frameId: 1 }),
  ]) {
    assertEquals(await attestCurrentAttachedWebmcpTab(9, { ...source, registry, enrolledOrigins: [] }), null);
  }
  assertEquals(await attestCurrentAttachedWebmcpTab(9, { ...browser(), registry, enrolledOrigins: ["https://example.test"] }), null);
});

Deno.test("3p3e.3: owner-only SW route returns count/document without granting descriptors or requesting permission", async () => {
  const source = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  const start = source.indexOf('async "agent.attached-webmcp-document"(');
  const end = source.indexOf('async "agent.tool-offers"(', start);
  assert(start > 0 && end > start, "owner attachment attestation route is wired before count-only offers");
  const block = source.slice(start, end);
  assert(block.includes("isOwnerPrincipal(context)"));
  assert(block.includes("attestCurrentAttachedWebmcpTab"));
  assert(block.includes('permissions.contains({ permissions: ["scripting"] })'));
  assert(!block.includes("permissions.request") && !block.includes("getTools") && !block.includes("tool.description"));
});

Deno.test("3p3e.3: tab ID and top-frame document come only from browser APIs, never attachment URL or page fields", async () => {
  const source = browser();
  assertEquals(await attestCurrentAttachedWebmcpTab(-1, { ...source, registry }), null);
  assertEquals(source.calls, [], "a malformed or forged ID triggers no browser operation");
  const candidate = await attestCurrentAttachedWebmcpTab(9, { ...source, registry,
    attachment: { tabId: 9, documentId: "forged", url: "https://evil.test/" } });
  assertEquals(candidate?.documentId, "doc-one");
});
