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
  "tool-directory-card",
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
  "conversation-run-status",
  "thinking-trace",
  "tool-chips",
  "task-row",
  "streaming-text",
  "approval-card",
  "prompt-bar",
  "durable-run-registry",
];

Deno.test("durable run registry: action visibility matrix is fail-closed", async () => {
  const mod = await import("../extension/shared/components.js");
  for (const phase of ["running", "settling", "paused-permission", "paused-interruption", "paused-side-effect-uncertain", "paused-provider-change", "resume-dispatching"]) {
    if (!mod.durableRunActionsForPhase(phase).cancel) throw new Error(`Cancel missing for ${phase}`);
  }
  for (const phase of ["paused-permission", "paused-provider-change", "paused-side-effect-uncertain"]) {
    if (!mod.durableRunActionsForPhase(phase).resume) throw new Error(`Resume missing for ${phase}`);
  }
  for (const phase of ["terminal", "cancelled", "resume-dispatching", "running"]) {
    if (mod.durableRunActionsForPhase(phase).resume) throw new Error(`Resume incorrectly shown for ${phase}`);
  }
  for (const phase of ["terminal", "cancelled"]) {
    if (mod.durableRunActionsForPhase(phase).cancel) throw new Error(`Cancel incorrectly shown for ${phase}`);
    if (!mod.durableRunActionsForPhase(phase).logs) throw new Error(`Logs missing for ${phase}`);
  }
});

Deno.test("durable run registry: confirmation is terminal, context-bound, and retains logs", async () => {
  const mod = await import("../extension/shared/components.js");
  const text = mod.durableCancelConfirmationText({ taskPreview: "Publish report", executionId: "exec_test_0001" });
  for (const expected of ["Publish report", "terminal", "not restart automatically", "Retained logs"]) {
    if (!text.includes(expected)) throw new Error(`confirmation missing ${expected}`);
  }
  const Klass = registry.get("durable-run-registry");
  const element = new Klass();
  let answer = false;
  globalThis.confirm = (message) => { if (message !== text) throw new Error("wrong confirmation text"); return answer; };
  if (element._confirmCancel({ taskPreview: "Publish report" }) !== false) throw new Error("dismissed confirmation accepted");
  answer = true;
  if (element._confirmCancel({ taskPreview: "Publish report" }) !== true) throw new Error("confirmed cancellation refused");
});

Deno.test("durable run registry: exact-ID dispatch suppresses duplicates and exposes success/error completion", async () => {
  await import("../extension/shared/components.js");
  const Klass = registry.get("durable-run-registry");
  const element = new Klass();
  element._render = () => {};
  element._wire = () => {};
  element._runs = [{ executionId: "exec_exact_0001", taskPreview: "Exact task", phase: "running" }];
  const events = [];
  element.dispatchEvent = (event) => { events.push(event); return true; };
  element._emitAction("run-cancel", element._runs[0], "Cancel");
  element._emitAction("run-cancel", element._runs[0], "Cancel");
  if (events.length !== 1 || events[0].detail.executionId !== "exec_exact_0001") throw new Error("duplicate/exact-ID suppression failed");
  events[0].detail.complete({ ok: false, error: "visible failure" });
  if (element._error !== "visible failure") throw new Error("error was not made visible");
  element._emitAction("run-logs", element._runs[0], "View logs");
  events[1].detail.complete({ ok: true, logs: [{ type: "terminal" }] });
  if (!element._message.includes("succeeded") || element._logs.get("exec_exact_0001").length !== 1) throw new Error("success/log completion failed");
  const source = await Deno.readTextFile(new URL("../extension/shared/components.js", import.meta.url));
  for (const marker of ['<button type="button"', ":focus-visible", "disabled", "role=\"status\""]) if (!source.includes(marker)) throw new Error(`native/a11y marker missing: ${marker}`);
});

Deno.test("task-row exposes the owner retry affordance for storage-blocked schedules", async () => {
  await import("../extension/shared/components.js");
  const Klass = registry.get("task-row");
  if (!Klass.observedAttributes.includes("retryable")) throw new Error("task-row retryable state is not reactive");
  const source = await Deno.readTextFile(new URL("../extension/shared/components.js", import.meta.url));
  for (const token of ['class="retry"', 'this._emit("retry")', "Retry ${escapeHtml(name)}"]) {
    if (!source.includes(token)) throw new Error(`task-row retry contract missing ${token}`);
  }
});

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

Deno.test("components: tool-directory schema summary is bounded and truthful", async () => {
  const mod = await import("../extension/shared/components.js");
  const summary = mod.summarizeInputSchema({
    type: "object",
    required: ["title"],
    properties: {
      title: { type: "string" }, startsAt: { type: "string" }, attendees: { type: "array" },
      location: { type: "string" }, notes: { type: "string" }, colour: { type: "string" }, extra: { type: "string" },
    },
  });
  if (summary !== "Inputs: title (required), startsAt, attendees, location, notes, colour, +1 more") {
    throw new Error(`unexpected schema summary: ${summary}`);
  }
  if (mod.summarizeInputSchema({ type: "object", properties: {} }) !== "No inputs") {
    throw new Error("empty object schema was not reported truthfully");
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

Deno.test("components: renderHtmlFrame routes through the manifest-sandbox host (no srcdoc) in the extension", async () => {
  const mod = await import("../extension/shared/components.js");
  globalThis.chrome = { runtime: { getURL: (p) => `chrome-extension://extid/${p}` } };
  try {
    const out = mod.renderHtmlFrame("<script>alert(1)</script>", {});
    if (!out.includes('src="chrome-extension://extid/sandbox/artifact-preview.html"')) throw new Error("the extension frame must point at the sandbox host, not srcdoc");
    if (out.includes("srcdoc=")) throw new Error("the extension frame must NOT use srcdoc (extension_pages script-src 'self' blocks inline)");
    if (!out.includes('sandbox="allow-scripts"')) throw new Error("the sandbox must be allow-scripts only");
  } finally {
    delete globalThis.chrome;
  }
  // Without chrome (the docs showcase) the srcdoc fallback still renders.
  const showcase = mod.renderHtmlFrame("<b>x</b>", {});
  if (!showcase.includes("srcdoc=")) throw new Error("the non-extension showcase keeps the srcdoc fallback");
});

Deno.test("components: wireHtmlFrameContent delivers the staged HTML once, then cleans up the frameContents entry", async () => {
  const mod = await import("../extension/shared/components.js?wire=" + Date.now());
  globalThis.chrome = { runtime: { getURL: (p) => `chrome-extension://extid/${p}` } }; // the extension branch stages the frameContents
  const nonce = "wire-test";
  try {
  const out = mod.renderHtmlFrame("<p>hi</p>", { nonce });
  // Mount the rendered markup into a minimal DOM stub + a fake iframe contentWindow.
  const mkEl = (tag, inner = "") => {
    const el = { tagName: tag, dataset: {}, innerHTML: inner, children: [], listeners: {}, contentWindow: null };
    el.querySelector = (sel) => el.children.find((c) => sel === ".html-frame" ? c.tagName === "div" && c.classList?.includes("html-frame") : sel === "iframe" ? c.tagName === "iframe" : false) ?? null;
    el.querySelectorAll = () => el.children;
    el.matches = () => false;
    el.classList = [];
    el.addClass = (c) => el.classList.push(c);
    el.addEventListener = () => {};
    el.removeEventListener = () => {};
    el.appendChild = (c) => el.children.push(c);
    return el;
  };
  const container = mkEl("div");
  const htmlFrame = mkEl("div"); htmlFrame.addClass("html-frame");
  const iframe = mkEl("iframe");
  iframe.contentWindow = { postMessage: (msg) => posted.push(msg) };
  htmlFrame.children.push(iframe); container.children.push(htmlFrame);
  htmlFrame.querySelector = (sel) => sel === "iframe" ? iframe : null;
  htmlFrame.dataset.frameNonce = nonce;
  // parse the nonce from the rendered markup's data attribute (the stub mirrors it)
  const nonceMatch = out.match(/data-frame-nonce="([^"]+)"/);
  if (nonceMatch) htmlFrame.dataset.frameNonce = nonceMatch[1];
  const frame = htmlFrame;
  frame.matches = (sel) => sel === ".html-frame";
  const posted = [];
  const cleanup = mod.wireHtmlFrameContent(frame, { nonce });
  // The content must be delivered (the sandbox host resolves fast → the timeout(0) path).
  await new Promise((r) => setTimeout(r, 10));
  if (!posted.some((m) => m.type === "cap:artifact-preview-open" && m.nonce === nonce && m.html.includes("<p>hi</p>"))) {
    throw new Error(`the staged HTML must be delivered via postMessage: ${JSON.stringify(posted)}`);
  }
  cleanup();
  // The staged entry must be gone (no memory leak).
  const again = mod.renderHtmlFrame("<p>hi</p>", { nonce });
  if (again.length === 0) throw new Error("renderHtmlFrame still emits for a fresh nonce");
  } finally {
    delete globalThis.chrome;
  }
});

Deno.test("components: the sandbox host files + the manifest sandbox.pages ship together (no 404 preview)", async () => {
  // import.meta.url-RELATIVE paths (portable across worktrees/clones/CI); Deno
  // fs APIs keep the suite free of a @types/node type-check dependency.
  const root = new URL("..", import.meta.url);
  const read = (rel: string) => Deno.readTextFile(new URL(rel, root));
  const exists = async (rel: string) => {
    try { await Deno.stat(new URL(rel, root)); return true; } catch { return false; }
  };
  if (!await exists("extension/sandbox/artifact-preview.html") ||
      !await exists("extension/sandbox/artifact-preview.js") ||
      !await exists("extension/sandbox/artifact-preview.css")) throw new Error("the complete sandbox host must ship (the extension frame would 404 or render at 300×150)");
  const host = await read("extension/sandbox/artifact-preview.js");
  const executableHost = host.replace(/\/\/.*$/gm, "");
  if (/document\.(open|write|close)\s*\(/.test(executableHost)) throw new Error("the stable host must not replace itself with generated HTML");
  if (!host.includes('document.createElement("iframe")') || !host.includes('frame.srcdoc = html')) throw new Error("the host must mount generated HTML in a disposable nested iframe");
  const manifest = JSON.parse(await read("extension/manifest.json"));
  if (!manifest.sandbox?.pages?.includes("sandbox/artifact-preview.html")) throw new Error("the manifest sandbox.pages must declare the artifact preview host");
  if (!manifest.content_security_policy?.extension_pages?.includes("frame-src 'self' about: blob: data:")) throw new Error("the extension CSP must allow the sandbox frame");
});

Deno.test("components: direct artifact preview mounts retain content/preference teardown", async () => {
  const root = new URL("..", import.meta.url);
  const ntp = await Deno.readTextFile(new URL("extension/ntp/ntp.js", root));
  const standalone = await Deno.readTextFile(new URL("extension/artifact/artifact.js", root));
  const gallery = await Deno.readTextFile(new URL("extension/artifacts/index.js", root));
  if (!ntp.includes("frameCleanups.push(wireHtmlFrameContent(frame))") ||
      !ntp.includes("for (const cleanup of frameCleanups.splice(0))")) {
    throw new Error("the NTP artifact dialog must clean staged content/listeners on close");
  }
  if (!standalone.includes('window.addEventListener("pagehide", cleanup, { once: true })') ||
      !standalone.includes("cleanups.push(wireHtmlFramePreference")) {
    throw new Error("the standalone artifact view must clean both content and preference wiring");
  }
  if (!gallery.includes("frameCleanups.forEach") || !gallery.includes("wireHtmlFrameContent(frame)")) {
    throw new Error("the Assets gallery dialog must clean staged frame content on close");
  }
});

// ── ArtifactCard async-preview lifecycle (the browser review's product defect) ──
// The `preview` async setter after the mount must re-render AND re-wire: the
// fresh shadow's click/keydown/reuse/delete listeners + the HTML staging
// (wireHtmlFrameContent) must survive, exactly once (no duplicates), with the
// prior frameContents cleanup run first.
Deno.test("components: ArtifactCard async preview re-renders and re-wires (keyboard/pointer/reuse/delete listeners + HTML staging)", async () => {
  const mod = await import("../extension/shared/components.js?acard=" + Date.now());
  globalThis.chrome = { runtime: { getURL: (p) => `chrome-extension://extid/${p}` } };
  try {
    // A purpose-built stub: elements record their listeners; the preview frame
    // exposes a fake iframe contentWindow that records the staged postMessage.
    const listeners = [];
    const posted = [];
    const mkEl = (tag, cls = []) => {
      const el = { tagName: tag, className: "", classList: cls, dataset: {}, children: [], contentWindow: null };
      el.addClass = (c) => cls.push(c);
      el.listeners = {};
      el.addEventListener = (type, fn) => { listeners.push({ tag: tag, type, fn }); el.listeners[type] = (el.listeners[type] ?? 0) + 1; };
      el.removeEventListener = () => {};
      el.appendChild = (c) => el.children.push(c);
      el.replaceChildren = () => { el.children.length = 0; };
      el.scrollTop = 0; el.scrollHeight = 0;
      el.matches = (sel) => cls.includes(sel) || el.tagName === sel;
      el.querySelector = (sel) => el.children.find((c) => c.tagName === sel || c.classList?.includes(sel)) ?? null;
      el.getBoundingClientRect = () => ({ x: 0, y: 0, width: 10, height: 10 });
      return el;
    };
    const shadow = { innerHTML: "", set innerHTML(v) { this._html = v; }, _html: "", querySelector: (sel) => {
      if (sel === ".preview .html-frame") return htmlFrame;
      if (sel === ".preview") return preview;
      if (sel === '[data-act="reuse"]') return reuseBtn;
      if (sel === '[data-act="delete"]') return deleteBtn;
      return null;
    }, querySelectorAll: () => [] };
    const host = {
      constructor: { shadow: () => true, observedAttributes: mod.ArtifactCard?.observedAttributes ?? [] },
      _root: shadow, _rendered: false, _previewCleanup: undefined, getAttribute: (n) => n === "type" ? "html" : null,
      _emit: (type, detail) => emitted.push({ type, detail }), _render: null, _wire: null,
    };
    let preview = mkEl("div", [".preview"]);
    let htmlFrame = mkEl("div", [".html-frame"]);
    htmlFrame.dataset.frameNonce = "async-nonce";
    let iframe = mkEl("iframe");
    iframe.contentWindow = { postMessage: (m) => posted.push(m) };
    htmlFrame.children.push(iframe);
    const emitted = [];
    // Drive the real _render/_wire via the registered class (customElements.get).
    const ArtifactCardClass = globalThis.customElements.get("artifact-card");
    if (!ArtifactCardClass) throw new Error("artifact-card must be registered");
    let reuseBtn = mkEl("button"); let deleteBtn = mkEl("button");
    const originalRender = ArtifactCardClass.prototype._render;
    const card = Object.create(ArtifactCardClass.prototype);
    Object.assign(card, host);
    // The real _render REPLACES the shadow → the fresh elements each time; the
    // stub recreates them on every render so the listener accounting matches.
    card._render = () => {
      preview = mkEl("div", [".preview"]);
      htmlFrame = mkEl("div", [".html-frame"]);
      iframe.contentWindow = { postMessage: (m) => posted.push(m) };
      htmlFrame.children.push(iframe);
      reuseBtn = mkEl("button"); deleteBtn = mkEl("button");
      const renderSet = (v) => { shadow._html = v; };
      shadow.innerHTML = "";
      originalRender.call(card);
      // Extract the GENERATED frame nonce from the rendered markup (the real
      // _render stages the HTML under it + emits the data-frame-nonce).
      const nonceMatch = String(shadow._html ?? "").match(/data-frame-nonce="([^"]+)"/);
      htmlFrame.dataset.frameNonce = nonceMatch ? nonceMatch[1] : "missing-nonce";
    };
    card._wire = ArtifactCardClass.prototype._wire.bind(card);
    card._rendered = true;
    card._render(); card._wire();
    const firstWire = listeners.length;
    // The async preview set: re-render + re-wire (the browser defect fix).
    card.preview = "<p>async</p>";
    const secondWire = listeners.length;
    if (secondWire <= firstWire) throw new Error("the preview set must re-wire the fresh listeners");
    // Exactly one set on the CURRENT (fresh) elements — the reuse + delete
    // buttons each carry exactly one click listener after the async preview set.
    if (reuseBtn.listeners?.click !== 1) throw new Error(`the fresh reuse button must have exactly one click listener`);
    if (deleteBtn.listeners?.click !== 1) throw new Error(`the fresh delete button must have exactly one click listener`);
    // The staged HTML must be delivered (the wireHtmlFrameContent postMessage).
    await new Promise((r) => setTimeout(r, 10));
    if (!posted.some((m) => m.type === "cap:artifact-preview-open" && m.html.includes("<p>async</p>"))) {
      throw new Error(`the async preview HTML must be staged + delivered: ${JSON.stringify({ posted, nonce: htmlFrame.dataset.frameNonce, markup: String(shadow._html ?? "").slice(0, 120) })}`);
    }
    // A second async set stays idempotent (the cleanup + one fresh wire).
    const before = listeners.length;
    card.preview = "<p>async2</p>";
    const after = listeners.length;
    if (after <= before) throw new Error("the second preview set must re-wire too");
    await new Promise((r) => setTimeout(r, 10));
    if (!posted.some((m) => m.html.includes("<p>async2</p>"))) throw new Error("the second async preview must be delivered");
  } finally {
    delete globalThis.chrome;
  }
});
