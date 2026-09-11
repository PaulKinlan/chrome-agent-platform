// tests/internal-sender-contract-audit.test.ts
// Test pins for chrome-agent-platform-lw6d:
// [CAP-FB-20260908-INTERNAL-SENDER-CONTRACT-01] Audit shared sender classifier assumptions before hardening.
//
// Records the exact behavior of authorizeToolReport across legitimate internal senders,
// content scripts, and synthetic test fixtures, and pins the manifest/SW channel invariants.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { authorizeToolReport, PAGE_ALLOWED_ROUTES } from "../extension/lib/pure.js";
import { canonicalOrigin } from "../extension/lib/memory.js";

const EXTENSION_ID = "pkgfemcklkmdlplknigjcadjikchgpad";

Deno.test("lw6d audit: synthetic foreign-no-tab fixture returns kind:extension in pure function", () => {
  const syntheticSender = {
    id: "foreign-extension",
    url: "https://attacker.example/",
    origin: "https://attacker.example",
    documentId: "synthetic-no-tab",
  };

  // Pure function classification returns kind:extension due to absence of sender.tab.url:
  const auth = authorizeToolReport(syntheticSender, null, canonicalOrigin, EXTENSION_ID);
  assertEquals(auth, { kind: "extension" });
});

Deno.test("lw6d audit: legitimate internal extension documents classify as kind:extension", () => {
  // 1. NTP tab
  const ntpSender = {
    id: EXTENSION_ID,
    url: `chrome-extension://${EXTENSION_ID}/ntp/ntp.html`,
    origin: `chrome-extension://${EXTENSION_ID}`,
    frameId: 0,
    documentId: "doc-ntp-uuid-1",
    tab: { id: 10, url: `chrome-extension://${EXTENSION_ID}/ntp/ntp.html` },
  };
  assertEquals(authorizeToolReport(ntpSender, null, canonicalOrigin, EXTENSION_ID), { kind: "extension" });

  // 2. Options page
  const optionsSender = {
    id: EXTENSION_ID,
    url: `chrome-extension://${EXTENSION_ID}/options/options.html`,
    origin: `chrome-extension://${EXTENSION_ID}`,
    frameId: 0,
    documentId: "doc-options-uuid-1",
    tab: { id: 11, url: `chrome-extension://${EXTENSION_ID}/options/options.html` },
  };
  assertEquals(authorizeToolReport(optionsSender, null, canonicalOrigin, EXTENSION_ID), { kind: "extension" });

  // 3. Offscreen document (no tab)
  const offscreenSender = {
    id: EXTENSION_ID,
    url: `chrome-extension://${EXTENSION_ID}/offscreen/offscreen.html`,
    origin: `chrome-extension://${EXTENSION_ID}`,
    frameId: 0,
    documentId: "doc-offscreen-uuid-1",
    // Offscreen documents in Chrome have no tab property:
  };
  assertEquals(authorizeToolReport(offscreenSender, null, canonicalOrigin, EXTENSION_ID), { kind: "extension" });
});

Deno.test("lw6d audit: top-frame and sub-frame content scripts are classified accurately", () => {
  // Top-frame content script on https://shop.example/
  const topContentScript = {
    id: EXTENSION_ID,
    url: "https://shop.example/products",
    origin: "https://shop.example",
    frameId: 0,
    documentId: "doc-content-1",
    tab: { id: 42, url: "https://shop.example/products" },
  };
  assertEquals(authorizeToolReport(topContentScript, null, canonicalOrigin, EXTENSION_ID), {
    kind: "content-script",
    origin: "https://shop.example",
  });

  // Subframe (iframe) content script
  const iframeContentScript = {
    id: EXTENSION_ID,
    url: "https://partner.example/embed",
    origin: "https://partner.example",
    frameId: 2,
    documentId: "doc-iframe-1",
    tab: { id: 42, url: "https://shop.example/products" },
  };
  assertEquals(authorizeToolReport(iframeContentScript, null, canonicalOrigin, EXTENSION_ID), {
    kind: "unmatched",
    error: "tool reports must come from the page's top frame",
  });

  // Origin mismatch
  const spoofedContentScript = {
    id: EXTENSION_ID,
    url: "https://shop.example/products",
    origin: "https://evil.example",
    frameId: 0,
    documentId: "doc-content-1",
    tab: { id: 42, url: "https://shop.example/products" },
  };
  assertEquals(authorizeToolReport(spoofedContentScript, null, canonicalOrigin, EXTENSION_ID), {
    kind: "content-script",
    error: "sender origin mismatch — tool report rejected",
  });
});

Deno.test("lw6d audit: manifest and service worker enforce channel boundary (no external messaging)", async () => {
  const [manifestText, swText] = await Promise.all([
    Deno.readTextFile(new URL("../extension/manifest.json", import.meta.url)),
    Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url)),
  ]);

  const manifest = JSON.parse(manifestText);
  assertEquals(manifest.externally_connectable, undefined, "manifest must not declare externally_connectable");
  assert(!swText.includes("onMessageExternal"), "service worker must not attach onMessageExternal listener");

  // Verify PAGE_ALLOWED_ROUTES is strictly bounded
  assert(PAGE_ALLOWED_ROUTES.size <= 10, "PAGE_ALLOWED_ROUTES must remain tightly bounded");
  assert(!PAGE_ALLOWED_ROUTES.has("named-agent.update"), "admin routes must not be allowed for pages");
  assert(!PAGE_ALLOWED_ROUTES.has("named-agent.create"), "admin routes must not be allowed for pages");
  assert(!PAGE_ALLOWED_ROUTES.has("named-agent.set-mcp-servers"), "mcp server route must not be allowed for pages");
});

Deno.test("lw6d audit: docs/INTERNAL-SENDER-CONTRACT-AUDIT.md exists and records the census", async () => {
  const auditDoc = await Deno.readTextFile(new URL("../docs/INTERNAL-SENDER-CONTRACT-AUDIT.md", import.meta.url));
  assert(auditDoc.includes("CAP-FB-20260908-INTERNAL-SENDER-CONTRACT-01"), "audit doc must cite bead identity");
  assert(auditDoc.includes("foreign-extension"), "audit doc must cite the synthetic fixture");
  assert(auditDoc.includes("externally_connectable"), "audit doc must cite the external messaging boundary");
});
