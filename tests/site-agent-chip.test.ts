// @ts-nocheck — this file stubs browser globals (HTMLElement/customElements)
// that Deno's type-checker doesn't know about; the runtime behavior is what's
// under test.
// tests/site-agent-chip.test.ts — the hub's "<host> offers N tools — use
// them?" chip (CAP-FB-20260825-SITE-AGENT-SHOWCASE-01).
//
// The chip is the reusable <site-agent-card> in its `offer` variant, fed by
// the pure `selectSiteOffer` projection over the SW's permission-free
// `agent.tool-offers` rows. Two properties are pinned here:
//   1. the chip renders the host + the tool count from a row and emits
//      `select` carrying the EXACT tab id (the enrollment binds that tab);
//   2. an origin that is already enrolled never gets a chip (the falsification
//      gate: revert the enrolled filter in selectSiteOffer → this goes RED).
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";

// ── a recording DOM double (the components.test.ts pattern) ──────────────────
const registry = new Map();
const dispatched: any[] = [];
class FakeEl {
  constructor(tag = "div") { this.tagName = tag; this.listeners = {}; this.attributes = {}; this.textContent = ""; }
  addEventListener(t, f) { (this.listeners[t] ??= []).push(f); }
  setAttribute(n, v) { this.attributes[n] = String(v); }
  getAttribute(n) { return this.attributes[n] ?? null; }
  click() { for (const f of this.listeners.click ?? []) f({ preventDefault() {} }); }
  key(k) { for (const f of this.listeners.keydown ?? []) f({ key: k, preventDefault() {} }); }
}
class ShadowRootStub {
  constructor() { this.innerHTML = ""; this.card = new FakeEl("div"); }
  querySelector(sel) { return sel === ".card" ? this.card : null; }
  querySelectorAll() { return []; }
  appendChild() {}
}
class HTMLElementStub {
  constructor() { this._attrs = new Map(); }
  attachShadow(_init) { return new ShadowRootStub(); }
  getAttribute(n) { return this._attrs.has(n) ? this._attrs.get(n) : null; }
  hasAttribute(n) { return this._attrs.has(n); }
  setAttribute(n, v) { this._attrs.set(n, String(v)); }
  removeAttribute(n) { this._attrs.delete(n); }
  dispatchEvent(e) { dispatched.push(e); return true; }
  addEventListener() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
}
globalThis.HTMLElement = HTMLElementStub;
globalThis.customElements = {
  define(name, cls) { registry.set(name, cls); },
  get(name) { return registry.get(name); },
};
globalThis.window = globalThis;
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init = {}) { this.type = type; this.detail = init.detail ?? {}; }
};
globalThis.matchMedia = () => ({ matches: false });
globalThis.document = {
  head: new FakeEl("head"), body: new FakeEl("body"), documentElement: new FakeEl("html"),
  createElement: (tag) => new FakeEl(tag),
  getElementById() { return null; },
  addEventListener() {}, removeEventListener() {},
};

const { selectSiteOffer, selectSiteOfferState, siteOfferLabel, siteUsingLabel, SITE_AGENT_COPY } = await import("../extension/shared/site-agent-copy.js");
await import("../extension/shared/components.js");

const SHOP = "http://127.0.0.1:8934";
const row = (over = {}) => ({
  id: 12, title: "Showcase Shop", url: `${SHOP}/shop`, origin: SHOP, toolCount: 5,
  active: false, lastAccessed: 1000, ...over,
});

Deno.test("site-agent chip: the chip renders host and tool count from a discoverable-tabs row and emits select with the tab id", () => {
  const offer = selectSiteOffer([row()], []);
  assert(offer, "an unenrolled tab with tools is offered");
  assertEquals(siteOfferLabel(offer), "127.0.0.1:8934 offers 5 tools — use them?");
  assertEquals(siteUsingLabel(offer), "Using 127.0.0.1:8934 · 5 tools");

  const Klass = registry.get("site-agent-card");
  assert(Klass, "site-agent-card is registered");
  const chip = new Klass();
  chip.setAttribute("origin", offer.origin);
  chip.setAttribute("tool-count", String(offer.toolCount));
  chip.setAttribute("tab-id", String(offer.id));
  chip.setAttribute("offer", "");
  chip.connectedCallback();
  const html = chip._root.innerHTML;
  assertMatch(html, /127\.0\.0\.1:8934 offers 5 tools — use them\?/);
  assertMatch(html, /role="button"/);
  // The accessible name names the host — a screen reader hears which site.
  assertMatch(html, /aria-label="[^"]*127\.0\.0\.1:8934[^"]*"/);
  // Host text is escaped (the host comes from the page's URL — untrusted).
  chip.setAttribute("origin", "http://<b>evil</b>.example");
  chip.connectedCallback();
  assert(!chip._root.innerHTML.includes("<b>evil</b>"), "the host is escaped, never markup");

  dispatched.length = 0;
  chip.setAttribute("origin", offer.origin);
  chip.connectedCallback();
  chip._root.card.click();
  const ev = dispatched.find((e) => e.type === "select");
  assert(ev, "click emits select");
  assertEquals(ev.detail.origin, SHOP);
  assertEquals(ev.detail.tabId, 12, "select carries the EXACT tab id the enrollment binds");
  dispatched.length = 0;
  chip._root.card.key("Enter");
  assertEquals(dispatched.find((e) => e.type === "select")?.detail?.tabId, 12, "keyboard-operable");
});

Deno.test("site-agent chip: no chip for an already-enrolled origin", () => {
  assertEquals(selectSiteOffer([row()], [SHOP]), null, "an enrolled origin is never offered again");
  assertEquals(selectSiteOffer([row({ enrolled: true })], []), null, "a row the SW marks enrolled is not offered");
  assertEquals(selectSiteOffer([row({ toolCount: 0 })], []), null, "a page with no tools is not offered");
  assertEquals(selectSiteOffer([], []), null);
  assertEquals(selectSiteOffer(null, null), null);
  // The most-recently-used unenrolled tab wins; the enrolled one is skipped
  // even when it was used last.
  const other = row({ id: 7, origin: "https://shop.example", url: "https://shop.example/", toolCount: 4, lastAccessed: 500 });
  const picked = selectSiteOffer([row({ lastAccessed: 9000 }), other], [SHOP]);
  assertEquals(picked?.id, 7);
  assertEquals(siteOfferLabel(picked), "shop.example offers 4 tools — use them?");
  assertEquals(siteOfferLabel({ origin: "https://one.example", toolCount: 1 }), "one.example offers 1 tool — use it?");
});

Deno.test("site-agent chip: before the one-time scripting grant the chip offers exactly that check, and an offer always wins", () => {
  // No scripting yet + open http(s) pages → the named check click.
  assertEquals(selectSiteOfferState({ ok: true, offers: [], needScripting: true, candidateTabs: 2 }, []), { kind: "check", tabs: 2 });
  // No scripting but nothing open to check → nothing (a fresh hub with no pages stays quiet).
  assertEquals(selectSiteOfferState({ ok: true, offers: [], needScripting: true, candidateTabs: 0 }, []), null);
  // Scripting granted, nothing detected → nothing.
  assertEquals(selectSiteOfferState({ ok: true, offers: [], needScripting: false, candidateTabs: 3 }, []), null);
  // A detected page beats the check, and the enrolled filter still applies.
  assertEquals(selectSiteOfferState({ ok: true, offers: [row()], needScripting: false, candidateTabs: 1 }, [])?.kind, "offer");
  assertEquals(selectSiteOfferState({ ok: true, offers: [row()], needScripting: false, candidateTabs: 1 }, [SHOP]), null);
  assertEquals(selectSiteOfferState({ ok: false }, []), null);
  assertEquals(selectSiteOfferState(null, []), null);

  const Klass = registry.get("site-agent-card");
  const chip = new Klass();
  chip.setAttribute("check", "");
  chip.connectedCallback();
  const html = chip._root.innerHTML;
  assertMatch(html, /Check open pages for site tools/);
  assertMatch(html, /role="button"/);
  assert(html.includes(`aria-label="${SITE_AGENT_COPY.checkOpenPagesName}"`), "the accessible name says what the click grants");
  assert(!/offers \d+ tools/.test(html), "the check chip never claims a tool count it cannot know");
  dispatched.length = 0;
  chip._root.card.click();
  assertEquals(dispatched.find((e) => e.type === "select")?.detail, { check: true }, "select says it is the check, not an origin grant");
});

Deno.test("site-agent chip: a site @mention routes to the site — the registry's site ref is the canonical site:<origin>", async () => {
  const { selectionFromAgentCandidate, canonicalRef } = await import("../extension/shared/agent-registry.js");
  // The composer's selection contract: a candidate whose ref id disagrees
  // with its agent id is refused (fail closed), so a ref carrying the page
  // path ("site:<origin>/shop") never routes — the task silently runs on the
  // hub, which has no site tools. The canonical ref routes.
  assertEquals(
    selectionFromAgentCandidate({ ref: "site:http://127.0.0.1:8934/shop", kind: "site", agentId: "http://127.0.0.1:8934", name: "@127.0.0.1:8934/shop" }),
    null,
    "a path-suffixed site ref is refused by the selection contract",
  );
  assertEquals(
    selectionFromAgentCandidate({ ref: canonicalRef("site", "http://127.0.0.1:8934"), kind: "site", agentId: "http://127.0.0.1:8934", name: "@127.0.0.1:8934/shop" })?.id,
    "http://127.0.0.1:8934",
    "the canonical site:<origin> ref selects the site",
  );
  // The registry builder must therefore emit the canonical ref, never the
  // page path (the display name keeps the path).
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  const registryAt = sw.indexOf('async "agent.registry"()');
  assert(registryAt > 0, "the agent.registry route exists");
  const body = sw.slice(registryAt, registryAt + 4000);
  assert(body.includes("const ref = `site:${info.origin}`;"), "agent.registry builds the site ref as site:<origin>");
  assert(!body.includes("`site:${info.origin}${info.path}`"), "agent.registry never appends the page path to the site ref");
});

Deno.test("site-agent chip: the hub composes the chip after the composer (Tab #1 stays the composer) and above it visually", async () => {
  const html = await Deno.readTextFile(new URL("../extension/ntp/ntp.html", import.meta.url));
  const js = await Deno.readTextFile(new URL("../extension/ntp/ntp.js", import.meta.url));
  const composerAt = html.indexOf('<agent-composer id="composer"');
  const chipAt = html.indexOf('<site-agent-card id="site-offer"');
  assert(chipAt > 0, "the hub declares the site-offer chip");
  assert(chipAt > composerAt, "the chip follows the composer in DOM order (focus order)");
  assertMatch(html, /\.main-wrap > site-agent-card \{ order: -2; \}/);
  assertMatch(html, /\.main-wrap > agent-composer \{ order: -1; \}/);
  assert(js.includes("selectSiteOfferState("), "the hub projects the chip through selectSiteOfferState (offer / check / nothing)");
  assert(js.includes('send("agent.tool-offers"'), "the hub reads the permission-free tool offers");
  const dir = await Deno.readTextFile(new URL("../extension/directory/directory.js", import.meta.url));
  assert(!dir.includes("Browse the web with the extension installed"), "the Directory empty copy says what actually happens");
  assertMatch(dir, /the hub shows a chip/);
});
