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

// Execute the actual inline SW handlers with controlled collaborators. A test
// that checks only their argument names misses a global toggle in the result.
const swSource = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
function inlineHandler(route: string, dependencies: Record<string, unknown>) {
  const start = swSource.indexOf(`  async "${route}"(`);
  assert(start >= 0, `find the actual ${route} handler`);
  const end = swSource.indexOf("\n  },", start);
  assert(end > start, `find the end of ${route}`);
  const body = swSource.slice(start, end + "\n  }".length);
  return new Function(...Object.keys(dependencies), `return ({${body}})[${JSON.stringify(route)}];`)(...Object.values(dependencies));
}

Deno.test("89rk4: page senders never receive the owner diagnostics toggle from its handler", async () => {
  const getDiagnostics = inlineHandler("webmcp.diagnostics.get", {
    isOwnerPrincipal: (context: { principal?: string }) =>
      context?.principal === "extension" || context?.principal === "owner-options",
    webmcpDiagnosticsEnabled: async () => true,
  });
  for (const origin of ["https://enrolled.example", "https://unenrolled.example"]) {
    const response = await getDiagnostics({}, {
      principal: "page",
      pageSender: { tabId: 7, documentId: `doc-${origin}`, documentLifecycle: "active", url: `${origin}/` },
    });
    assertEquals(response, { ok: false, error: "owner_extension_required" }, `page sender at ${origin} must not read the global preference`);
  }
  assertEquals(await getDiagnostics({}, { principal: "owner-options" }), { enabled: true },
    "the owner settings page retains its diagnostics control");
});

Deno.test("89rk4: enrolled and unenrolled page status returns no global diagnostics and never arms MAIN with it", async () => {
  let globalReads = 0;
  const armed: unknown[][] = [];
  const status = inlineHandler("enrollment.status", {
    canonicalOrigin: (origin: string) => origin,
    ERR_INVALID_ORIGIN: { ok: false, error: "invalid_origin" },
    enrollmentSnapshot: async (origin: string) => ({ enrolled: origin === "https://enrolled.example", gen: 2 }),
    withEnrollmentLock: async (fn: () => unknown) => await fn(),
    getSnapshotGateMap: async () => ({ "https://enrolled.example": { epoch: 1 } }),
    syncSnapshotDocument: () => ({ gate: { epoch: 1 }, bound: true }),
    setSnapshotGateMap: async () => {},
    issueBridgeNonce: async (...args: unknown[]) => { armed.push(args); return "bridge-key-1234567890"; },
    webmcpDiagnosticsEnabled: async () => { globalReads++; return true; },
  });
  for (const [origin, enrolled] of [["https://enrolled.example", true], ["https://unenrolled.example", false]] as const) {
    const response = await status({ origin, __sender: {
      tabId: 7, documentId: `doc-${origin}`, documentLifecycle: "active",
    } });
    assertEquals(response.ok, true);
    assertEquals(response.enrolled, enrolled);
    assertEquals(Object.hasOwn(response, "diagnostics"), false,
      `the ${enrolled ? "enrolled" : "unenrolled"} page must never receive the owner toggle`);
  }
  assertEquals(armed.length, 1, "only the enrolled page may receive a bridge nonce");
  assertEquals(armed[0]?.length, 2, "enrollment cannot supply the owner's global preference to MAIN");
  assertEquals(globalReads, 0, "a page-facing enrollment request must not read the owner global toggle");
  assertEquals(PAGE_ALLOWED_ROUTES.has("webmcp.diagnostics.get"), false,
    "page dispatcher must reject the diagnostics route before the handler");
  assertEquals(PAGE_ALLOWED_ROUTES.has("webmcp.status"), false,
    "owner-only status cannot provide a second page route to the global toggle");
});

Deno.test("89rk4: the real MAIN-world bootstrap receives false, never an owner-global toggle", async () => {
  const start = swSource.indexOf("async function issueBridgeNonce(");
  const end = swSource.indexOf("\n// Cached diagnostics toggle", start);
  assert(start >= 0 && end > start, "find the live MAIN-world bootstrap helper");
  const scriptCalls: unknown[] = [];
  const session = new Map<string, unknown>();
  const key = "cap:webmcpBridgeNonces";
  const dependencies = {
    BRIDGE_NONCE_KEY: key,
    BRIDGE_NONCE_MAX: 256,
    bridgeNonceMemory: new Map<string, string>(),
    crypto: { randomUUID: () => "per-document-bridge-key-0123456789" },
    chrome: {
      storage: { session: {
        get: async () => ({ [key]: session.get(key) }),
        set: async (values: Record<string, unknown>) => { session.set(key, values[key]); },
      } },
      scripting: { executeScript: async (options: unknown) => { scriptCalls.push(options); return []; } },
    },
  };
  const issueBridgeNonce = new Function(...Object.keys(dependencies),
    `${swSource.slice(start, end)}\nreturn issueBridgeNonce;`)(...Object.values(dependencies));
  const nonce = await issueBridgeNonce(7, "doc-enrolled");
  assertEquals(nonce, "per-document-bridge-key-0123456789");
  assertEquals(scriptCalls.length, 1);
  const call = scriptCalls[0] as { world: string; target: unknown; args: unknown[] };
  assertEquals(call.world, "MAIN");
  assertEquals(call.target, { tabId: 7, documentIds: ["doc-enrolled"] });
  assertEquals(call.args, [nonce, false], "no owner-global boolean enters the page-visible bootstrap");
});
