// @ts-nocheck — this file stubs browser globals (HTMLElement/customElements)
// that Deno's type-checker doesn't know about; the runtime behavior is what's
// under test.
// tests/components.test.ts — the design-system Web Components, tested without a
// real DOM by stubbing the browser globals the module touches at load time.
//
// The components use `HTMLElement`, `customElements`, `window`/`document` (the
// latter only at runtime inside connectedCallback/event handlers, not at module
// load). We stub the minimum to import the module + assert the pure helpers,
// the metadata (themes/permissions/views), and that every component registers.

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
  get _root() { return this; }
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
globalThis.matchMedia = () => ({ matches: false });

const COMPONENTS = [
  "run-task-button",
  "mic-button",
  "attach-button",
  "theme-picker",
  "switch-toggle",
  "permission-row",
  "capability-row",
  "site-agent-card",
  "artifact-card",
  "code-block",
  "message-bubble",
  "agent-conversation",
  "screenshot-strip",
  "agent-composer",
  "agent-dialog",
  "agent-picker",
  "agent-config-form",
  "provider-select",
  "model-picker",
  "agent-nav",
  "error-console",
  "security-shield",
  // BeautifulUI-inspired primitives
  "loading-state",
  "thinking-trace",
  "tool-chips",
  "task-row",
  "streaming-text",
  "approval-card",
  "prompt-bar",
];

Deno.test("components: every design-system element registers as a custom element", async () => {
  await import("../extension/shared/components.js");
  for (const name of COMPONENTS) {
    if (!registry.has(name)) {
      throw new Error(`missing custom element: <${name}>`);
    }
  }
});

Deno.test("components: theme metadata covers the four themes", async () => {
  const mod = await import("../extension/shared/components.js");
  const ids = mod.THEMES.map((t) => t.id);
  const expected = ["midnight", "sunlit", "neon", "terminal"];
  if (JSON.stringify(ids) !== JSON.stringify(expected)) {
    throw new Error(`themes ${ids} != ${expected}`);
  }
});

Deno.test("components: permission metadata lists the seven optional capabilities", async () => {
  const mod = await import("../extension/shared/components.js");
  const ids = mod.PERMISSIONS.map((p) => p.id);
  const expected = [
    "storage", "alarms", "tabs", "activeTab", "scripting", "notifications",
    "sidePanel",
  ];
  if (JSON.stringify(ids) !== JSON.stringify(expected)) {
    throw new Error(`permissions ${ids} != ${expected}`);
  }
});

Deno.test("components: navigation views cover hub/chat/directory/settings", async () => {
  const mod = await import("../extension/shared/components.js");
  const ids = mod.VIEWS.map((v) => v.id);
  const expected = ["hub", "chat", "directory", "settings"];
  if (JSON.stringify(ids) !== JSON.stringify(expected)) {
    throw new Error(`views ${ids} != ${expected}`);
  }
});

Deno.test("components: escapeHtml neutralises markup", async () => {
  const mod = await import("../extension/shared/components.js");
  const out = mod.escapeHtml(`<script>alert("x")</script>`);
  if (out.includes("<script>")) {
    throw new Error("escapeHtml leaked markup");
  }
  if (out !== "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;") {
    throw new Error(`unexpected escape: ${out}`);
  }
});

Deno.test("components: parseJSONAttr returns fallback on invalid input", async () => {
  const mod = await import("../extension/shared/components.js");
  const good = mod.parseJSONAttr('[{"a":1}]', []);
  if (good.length !== 1 || good[0].a !== 1) throw new Error("valid JSON not parsed");
  const bad = mod.parseJSONAttr("{not json", []);
  if (bad.length !== 0) throw new Error("invalid JSON did not fall back");
  const empty = mod.parseJSONAttr("", ["x"]);
  if (empty[0] !== "x") throw new Error("empty attr did not fall back");
});

Deno.test("components: renderHtmlFrame is a sandboxed double-iframe with CSP + preference bootstrap", async () => {
  const mod = await import("../extension/shared/components.js");
  const nonce = "0123456789abcdef0123456789abcdef";
  const html = "<!doctype html><html><head></head><body><h1>hi</h1></body></html>";
  const out = mod.renderHtmlFrame(html, { nonce });
  // the frame is sandboxed (opaque origin, no parent access) + srcdoc carries the guards
  if (!out.includes('sandbox="allow-scripts"')) throw new Error("iframe not sandboxed");
  if (!out.includes(`data-frame-nonce="${nonce}"`)) throw new Error("nonce not carried");
  // the CSP meta is injected
  if (!out.includes("Content-Security-Policy")) throw new Error("CSP meta not injected");
  // the preference bootstrap is injected with the nonce
  if (!out.includes("cap:preference")) throw new Error("preference bootstrap not injected");
  if (!out.includes(nonce)) throw new Error("bootstrap missing the nonce");
});

Deno.test("components: injectFrameGuards blocks network + allows inline scripts", async () => {
  const mod = await import("../extension/shared/components.js");
  const csp = mod.HTML_FRAME_CSP;
  if (!csp.includes("connect-src 'none'")) throw new Error("network egress not blocked");
  if (!csp.includes("default-src 'none'")) throw new Error("default-src not closed");
  if (!csp.includes("script-src 'unsafe-inline'")) throw new Error("inline scripts not allowed");
});

Deno.test("components: generateNonce is unique + 32 hex chars", async () => {
  const mod = await import("../extension/shared/components.js");
  const a = mod.generateNonce();
  const b = mod.generateNonce();
  if (a === b) throw new Error("nonces collided");
  if (!/^[0-9a-f]{32}$/.test(a)) throw new Error(`nonce not 32 hex chars: ${a}`);
});

Deno.test("components: preferenceBootstrapScript applies theme/locale + validates source + nonce", async () => {
  const mod = await import("../extension/shared/components.js");
  const script = mod.preferenceBootstrapScript("abc123");
  if (!script.includes("cap:preference-ready")) throw new Error("no readiness announce");
  if (!script.includes("e.source!==window.parent")) throw new Error("no source check");
  if (!script.includes("nonce")) throw new Error("no nonce check");
  if (!script.includes("data-theme")) throw new Error("no theme apply");
  if (!script.includes("lang")) throw new Error("no locale apply");
});

Deno.test("components: formatTsLabel renders relative + absolute time", async () => {
  const mod = await import("../extension/shared/components.js");
  const now = Date.now();
  if (mod.formatTsLabel(now - 10_000) !== "just now") throw new Error("recent time not 'just now'");
  if (mod.formatTsLabel(now - 5 * 60_000) !== "5m ago") throw new Error("5 minutes not '5m ago'");
  // > 60 min but same day renders the time-of-day (no "ago" once past the hour)
  const hourPlus = mod.formatTsLabel(now - 90 * 60_000);
  if (/ago/.test(hourPlus)) throw new Error(`past-hour rendered relative: ${hourPlus}`);
  if (!/\d/.test(hourPlus)) throw new Error(`past-hour not a time: ${hourPlus}`);
  // a far-past timestamp renders a date, not a relative label
  const old = mod.formatTsLabel(Date.UTC(2024, 0, 1));
  if (/ago|just now/.test(old)) throw new Error(`old timestamp rendered relative: ${old}`);
});

Deno.test("components: TS_GAP_MS is the subtle-timestamp threshold", async () => {
  const mod = await import("../extension/shared/components.js");
  if (mod.TS_GAP_MS !== 5 * 60 * 1000) throw new Error(`TS_GAP_MS unexpected: ${mod.TS_GAP_MS}`);
});
