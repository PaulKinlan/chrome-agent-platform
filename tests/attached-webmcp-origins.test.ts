import { assertEquals } from "jsr:@std/assert@1";
import { selectAttachedWebmcpOrigins } from "../extension/lib/attached-webmcp-origins.js";

const origin = "https://shop.example";
const report = { tabId: 41, documentId: "document-A", url: `${origin}/cart`, toolCount: 3 };
const registry = [{ origin, documents: [report] }];
const attestedDocuments = [{ tabId: 41, documentId: "document-A", url: `${origin}/checkout` }];
const attachments = [{ kind: "tab", tabId: 41, documentId: "document-A", url: "https://evil.example", name: "untrusted label" }];
const select = (overrides: Record<string, unknown> = {}) => selectAttachedWebmcpOrigins({
  attachments, registry, attestedDocuments, enrolledOrigins: [], ...overrides,
});

Deno.test("attached declared WebMCP: a current browser-attested document selects the registry origin, never attachment URL", () => {
  assertEquals(select(), [{ origin, tabId: 41, documentId: "document-A", toolCount: 3 }]);
});

Deno.test("attached declared WebMCP: forged URL alone and missing report never create a worker", () => {
  assertEquals(select({ attachments: [{ kind: "tab", url: "https://evil.example" }] }), []);
  assertEquals(select({ registry: [] }), []);
  assertEquals(select({ attachments: [{ ...attachments[0], tabId: 42 }] }), []);
});

Deno.test("attached declared WebMCP: same-tab navigation and mismatched origins refuse stale document authority", () => {
  assertEquals(select({ attestedDocuments: [{ tabId: 41, documentId: "document-B", url: `${origin}/cart` }] }), []);
  assertEquals(select({ attestedDocuments: [{ tabId: 41, documentId: "document-A", url: "https://other.example/cart" }] }), []);
  assertEquals(select({ registry: [{ origin, documents: [{ ...report, documentId: "document-B" }] }] }), []);
  assertEquals(select({ registry: [{ origin, documents: [{ ...report, url: "https://other.example/cart" }] }] }), []);
});

Deno.test("attached declared WebMCP: no capability, non-web document, enrolled origin or non-tab attachment selects nothing", () => {
  assertEquals(select({ registry: [{ origin, documents: [{ ...report, toolCount: 0 }] }] }), []);
  assertEquals(select({ attestedDocuments: [{ ...attestedDocuments[0], url: "chrome://settings" }] }), []);
  assertEquals(select({ enrolledOrigins: [origin] }), []);
  assertEquals(select({ attachments: [{ ...attachments[0], kind: "link" }] }), []);
});

Deno.test("attached declared WebMCP: two documents of one origin yield one worker bound to the first attachment", () => {
  const second = { tabId: 42, documentId: "document-B", url: `${origin}/offers`, toolCount: 7 };
  assertEquals(select({
    attachments: [attachments[0], { kind: "tab", tabId: 42, documentId: "document-B" }],
    registry: [{ origin, documents: [report, second] }],
    attestedDocuments: [attestedDocuments[0], second],
  }), [{ origin, tabId: 41, documentId: "document-A", toolCount: 3 }]);
});
