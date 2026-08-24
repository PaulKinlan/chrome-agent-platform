// @ts-nocheck — focused page/document/toolset identity + proactive-state tests.
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import {
  attestReportedPageUrl,
  boundedPageTitle,
  buildLoadingSiteIdentity,
  buildSiteIdentity,
  buildTabDiscoveryState,
  canonicalPageUrl,
  canonicalPath,
  classifyInjectability,
  documentScopeKey,
  formatSiteAgentName,
  historicalSiteIdentity,
  staleSiteIdentity,
} from "../extension/lib/site-identity.js";

const ORIGIN = "https://same.example";
const toolsA = [{
  name: "cart.add",
  source: "declared",
  description: "Add",
  inputSchema: { type: "object", properties: { sku: { type: "string" } } },
}];
const toolsB = [{
  name: "account.rename",
  source: "declared",
  description: "Rename",
  inputSchema: { type: "object", properties: { name: { type: "string" } } },
}];

Deno.test("site identity: same-origin pages and toolsets never collapse", async () => {
  const a = await buildSiteIdentity({
    origin: ORIGIN,
    pageUrl: `${ORIGIN}/shop?view=cart#local`,
    title: "Cart",
    tabId: 7,
    documentId: "doc-a",
    navigationEpoch: 2,
    tools: toolsA,
    observedAt: 100,
  });
  const b = await buildSiteIdentity({
    origin: ORIGIN,
    pageUrl: `${ORIGIN}/account`,
    title: "Account",
    tabId: 7,
    documentId: "doc-b",
    navigationEpoch: 3,
    tools: toolsB,
    observedAt: 200,
  });
  const changedTools = await buildSiteIdentity({
    origin: ORIGIN,
    pageUrl: `${ORIGIN}/shop?view=cart`,
    title: "Cart",
    tabId: 7,
    documentId: "doc-c",
    navigationEpoch: 4,
    tools: toolsB,
    observedAt: 300,
  });
  assert(a && b && changedTools);
  assertNotEquals(a.id, b.id, "different same-origin pages have distinct ids");
  assertNotEquals(
    a.id,
    changedTools.id,
    "a changed canonical toolset changes the id",
  );
  assertNotEquals(a.pageKey, b.pageKey);
  assertNotEquals(a.toolsetKey, changedTools.toolsetKey);
  assertEquals(
    a.pageUrl,
    `${ORIGIN}/shop?view=cart`,
    "fragment is excluded from stable page identity",
  );
  assertEquals(a.path, "/shop");
  assertEquals(b.path, "/account");
});

Deno.test("site identity: reload changes document authority without changing stable page/toolset id", async () => {
  const first = await buildSiteIdentity({
    origin: ORIGIN,
    pageUrl: `${ORIGIN}/shop`,
    tabId: 4,
    documentId: "doc-1",
    navigationEpoch: 8,
    tools: toolsA,
  });
  const reload = await buildSiteIdentity({
    origin: ORIGIN,
    pageUrl: `${ORIGIN}/shop`,
    tabId: 4,
    documentId: "doc-2",
    navigationEpoch: 9,
    tools: toolsA,
  });
  assert(first && reload);
  assertEquals(
    first.id,
    reload.id,
    "durable key is page + toolset scoped, not tied to ephemeral document id",
  );
  assertNotEquals(
    first.documentKey,
    reload.documentKey,
    "live authority is document/epoch scoped",
  );
});

Deno.test("site identity: documentScopeKey validates bounds and rejects malformed inputs", () => {
  assertEquals(documentScopeKey(3, "doc-123", 5), "3:5:doc-123");
  assertEquals(documentScopeKey(-1, "doc-123", 5), null, "negative tabId rejected");
  assertEquals(documentScopeKey(3, "", 5), null, "empty documentId rejected");
  assertEquals(documentScopeKey(3, "x".repeat(300), 5), null, "oversized documentId rejected");
  assertEquals(documentScopeKey(3, "doc-123", -2), null, "negative epoch rejected");
});

Deno.test("site identity: canonicalPageUrl strips hashes/credentials and enforces expectedOrigin", () => {
  assertEquals(
    canonicalPageUrl("https://user:pass@example.com:443/app/page?q=1#section", "https://example.com"),
    "https://example.com/app/page?q=1",
  );
  assertEquals(
    canonicalPageUrl("https://other.example/page", "https://example.com"),
    null,
    "cross-origin URL fails expectedOrigin check",
  );
  assertEquals(
    canonicalPageUrl("javascript:alert(1)"),
    null,
    "non-http URL rejected",
  );
});

Deno.test("site identity: attestReportedPageUrl verifies page URL against browser-attested tab URL", () => {
  const matching = attestReportedPageUrl(
    "https://example.com/checkout?step=2#frag",
    "https://example.com/checkout?step=2",
    "https://example.com",
  );
  assertEquals(matching.ok, true);
  assertEquals(matching.canonicalUrl, "https://example.com/checkout?step=2");

  const mismatch = attestReportedPageUrl(
    "https://example.com/checkout",
    "https://example.com/cart",
    "https://example.com",
  );
  assertEquals(mismatch.ok, false);
  assert(mismatch.reason.includes("does not match"));
});

Deno.test("site identity: formatSiteAgentName surfaces path for subpages and root for top-level", () => {
  assertEquals(formatSiteAgentName({ origin: "https://example.com" }), "@example.com");
  assertEquals(formatSiteAgentName({ origin: "https://example.com", path: "/" }), "@example.com");
  assertEquals(formatSiteAgentName({ origin: "https://example.com", path: "/booking" }), "@example.com/booking");
  assertEquals(formatSiteAgentName({ origin: "https://example.com", pageUrl: "https://example.com/cart?view=full" }), "@example.com/cart");
});

Deno.test("site identity: buildTabDiscoveryState handles known, probable, loading, and empty states", async () => {
  const identity = await buildSiteIdentity({
    origin: ORIGIN,
    pageUrl: `${ORIGIN}/items`,
    title: "Items Page",
    tabId: 10,
    documentId: "doc-10",
    navigationEpoch: 1,
    tools: toolsA,
  });

  const tab = { id: 10, url: `${ORIGIN}/items`, title: "Items Page", status: "complete" };
  const knownState = buildTabDiscoveryState(tab, { current: identity, enrolled: true });
  assertEquals(knownState.state, "known");
  assertEquals(knownState.authority, true);
  assertEquals(knownState.toolCount, 1);

  const loadingTab = { id: 10, url: `${ORIGIN}/items`, title: "Items Page", status: "loading" };
  const loadingState = buildTabDiscoveryState(loadingTab, { current: identity, enrolled: true });
  assertEquals(loadingState.state, "loading");
  assertEquals(loadingState.authority, false);

  const history = [historicalSiteIdentity(identity)];
  const otherTabSameUrl = { id: 12, url: `${ORIGIN}/items`, title: "Items Page", status: "complete" };
  const probableState = buildTabDiscoveryState(otherTabSameUrl, { current: null, history, enrolled: true });
  assertEquals(probableState.state, "probable");
  assertEquals(probableState.authority, false);
  assertEquals(probableState.toolCount, 1);
});
