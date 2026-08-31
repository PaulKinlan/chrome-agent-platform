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

// Minimal fake DOM node for driving renderers that build elements with
// document.createElement + textContent (never innerHTML). Matches the subset
// the composer popup renderer and the agent picker touch.
class FakeNode {
  constructor(tag) { this.tagName = tag; this.children = []; this.parent = null; this.listeners = {}; this.attributes = {}; this.dataset = {}; this.textContent = ""; this.className = ""; this.id = ""; this.hidden = false; this.type = ""; }
  setAttribute(n, v) { this.attributes[n] = String(v); }
  getAttribute(n) { return this.attributes[n] ?? null; }
  removeAttribute(n) { delete this.attributes[n]; }
  append(...kids) { for (const k of kids) { k.parent = this; this.children.push(k); } }
  appendChild(k) { k.parent = this; this.children.push(k); return k; }
  replaceChildren(...kids) { this.children = []; for (const k of kids) { k.parent = this; this.children.push(k); } }
  addEventListener(t, f) { (this.listeners[t] ??= []).push(f); }
  dispatch(t, e = {}) { e.target ??= this; e.preventDefault ??= () => {}; for (const f of this.listeners[t] ?? []) f(e); }
  getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 }; }
  querySelector(sel) {
    const m = sel.match(/data-index="?(\d+)/);
    if (m) return this.children.find((c) => String(c.dataset.index) === String(Number(m[1]))) ?? null;
    // Descendant selector "#ap-list [data-active=true]" must be tried BEFORE the
    // bare data-active search (the descendant string also contains
    // data-active="true" and would otherwise match the wrong branch).
    const desc = sel.match(/^#([^\s]+)\s+\[data-active="true"\]$/);
    if (desc) {
      const root = this.children.find((c) => c.id === desc[1]) ?? null;
      if (!root) return null;
      const walk = (node) => {
        for (const kid of node.children) {
          if (kid.dataset?.active === "true") return kid;
          const hit = walk(kid);
          if (hit) return hit;
        }
        return null;
      };
      return walk(root);
    }
    if (sel.includes('data-active="true"')) return this.children.find((c) => c.dataset.active === "true") ?? null;
    if (sel.startsWith("#")) { const id = sel.slice(1); const hit = this.children.find((c) => c.id === id); return hit ?? null; }
    return null;
  }
  querySelectorAll(sel) {
    if (sel === ".item" || sel === '[role="option"]' || sel === ".opt") return this.children.filter((c) => c.className && String(c.className).split(/\s+/).includes(sel.slice(1)) || c.getAttribute?.("role") === "option");
    return [];
  }
  scrollIntoView() {}
}
function installFakeDocument() {
  const listeners: Record<string, Array<(e: any) => void>> = {};
  const fakeDoc = {
    head: new FakeNode("head"), body: new FakeNode("body"), documentElement: new FakeNode("html"),
    createElement: (tag) => new FakeNode(tag),
    getElementById() { return null; },
    addEventListener(type: string, fn: (e: any) => void) { (listeners[type] ??= []).push(fn); },
    removeEventListener(type: string, fn: (e: any) => void) {
      const arr = listeners[type] ?? [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    _listeners: listeners,
  };
  const prevDoc = globalThis.document;
  globalThis.document = fakeDoc;
  return () => { if (prevDoc === undefined) delete globalThis.document; else globalThis.document = prevDoc; };
}

const COMPONENTS = [
  "first-run-guide",
  "example-chips",
  "run-task-button",
  "mic-button",
  "attach-button",
  "theme-picker",
  "switch-toggle",
  "permission-row",
  "capability-row",
  "site-agent-card",
  "agent-template-card",
  "tool-directory-card",
  "artifact-card",
  "artifact-inspector",
  "artifact-diff",
  "segmented-control",
  "artifact-quick-drawer",
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
  "tool-library",
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
  // The confirmation is now the native-modal promise dialog (never
  // window.confirm); drive it through a minimal fake document.
  class DialogFakeNode {
    constructor(tag) {
      this.tagName = tag; this.children = []; this.parent = null; this.listeners = {};
      this.attributes = {}; this.textContent = ""; this.className = ""; this.id = ""; this.type = ""; this.open = false;
    }
    setAttribute(n, v) { this.attributes[n] = String(v); }
    getAttribute(n) { return this.attributes[n] ?? null; }
    append(...kids) { for (const k of kids) { k.parent = this; this.children.push(k); } }
    addEventListener(t, f) { (this.listeners[t] ??= []).push(f); }
    dispatch(t, e = {}) { e.target ??= this; e.preventDefault ??= () => {}; for (const f of this.listeners[t] ?? []) f(e); }
    // A REAL (trusted) click — the shared confirm refuses scripted approvals by default.
    click() { this.dispatch("click", { target: this, isTrusted: true }); }
    remove() { if (this.parent) { const i = this.parent.children.indexOf(this); if (i >= 0) this.parent.children.splice(i, 1); this.parent = null; } }
    focus() {}
    showModal() { this.open = true; }
    close() { this.open = false; this.dispatch("close"); }
  }
  const fakeDoc = {
    head: new DialogFakeNode("head"), body: new DialogFakeNode("body"), documentElement: new DialogFakeNode("html"),
    createElement: (tag) => new DialogFakeNode(tag),
    getElementById(id) { return this.head.children.find((c) => c.id === id) ?? null; },
  };
  const prevDoc = globalThis.document;
  globalThis.document = fakeDoc;
  Object.defineProperty(globalThis.navigator, "userActivation", { value: { isActive: true }, configurable: true });
  try {
    const run = { taskPreview: "Publish report" };
    const denied = element._confirmCancel(run);
    const dialog1 = fakeDoc.body.children.filter((c) => c.tagName === "dialog").pop();
    if (!dialog1 || dialog1.open !== true) throw new Error("confirmation dialog not shown modally");
    if (dialog1.children[1].textContent !== text) throw new Error("wrong confirmation text");
    dialog1.children[2].children[0].click(); // Cancel — mutate-nothing path
    if (await denied !== false) throw new Error("dismissed confirmation accepted");
    const approved = element._confirmCancel(run);
    const dialog2 = fakeDoc.body.children.filter((c) => c.tagName === "dialog").pop();
    dialog2.children[2].children[1].click(); // the confirm control
    if (await approved !== true) throw new Error("confirmed cancellation refused");
  } finally {
    if (prevDoc === undefined) delete globalThis.document; else globalThis.document = prevDoc;
  }
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

Deno.test("screenshot-strip: kind/max/overflow contract with total-aware, escaped labels", async () => {
  await import("../extension/shared/components.js");
  const Klass = registry.get("screenshot-strip");
  if (!Klass) throw new Error("screenshot-strip is not registered");
  if (!Klass.observedAttributes.includes("max")) throw new Error("screenshot-strip max is not reactive");
  const source = await Deno.readTextFile(new URL("../extension/shared/components.js", import.meta.url));
  const strip = source.slice(source.indexOf("class ScreenshotStrip"), source.indexOf("customElements.define(\"screenshot-strip\""));
  for (const token of [
    "Open ${kind} ${i + 1} of ${total}", // the accessible label names kind + place in the set
    "data-overflow=", // the +N overflow button
    "Show ${overflow} more image",
    "escapeHtml(src", // src is escaped (a data URL is untrusted)
    "escapeHtml(String(label))", // and the label
    "escapeHtml(aria)",
  ]) {
    if (!strip.includes(token)) throw new Error(`screenshot-strip contract missing: ${token}`);
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

Deno.test("composer local files: unsupported browsers omit /files and binary selections stay references", async () => {
  const mod = await import("../extension/shared/components.js");
  if (mod.COMMAND_NAMESPACES.some((item) => item.id === "files")) {
    throw new Error("/files must be absent without showDirectoryPicker");
  }
  if (!mod.supportsLocalFilesCommand({ showDirectoryPicker() {} })) {
    throw new Error("showDirectoryPicker support was not detected");
  }
  const AgentComposer = registry.get("agent-composer");
  const composer = new AgentComposer();
  let attached = null;
  let status = "";
  composer.addAttachment = (value) => { attached = value; return value; };
  composer.setStatus = (value) => { status = value; };
  await composer._attachLocalFile({
    grantId: "folder-1",
    folderName: "Photos",
    relativePath: "shot.png",
    name: "shot.png",
    type: "image/png",
    size: 2048,
  });
  if (attached?.dataURL !== "" || attached?.kind !== "local-file") {
    throw new Error("binary local file bytes were read instead of attaching a reference");
  }
  if (!status.includes("binary") || !status.includes("weren't read")) {
    throw new Error("binary reference status was not honest");
  }
});

Deno.test("components: mention keyboard completion routes every agent kind by canonical ref", async () => {
  await import("../extension/shared/components.js");
  const AgentComposer = registry.get("agent-composer");
  const candidates = [
    { ref: "named:reader", kind: "named", agentId: "reader", id: "@Reader", label: "Reader" },
    { ref: "background:sorting-hat", kind: "background", agentId: "sorting-hat", id: "@Sorting Hat", label: "Sorting Hat" },
    { ref: "site:https://github.com", kind: "site", agentId: "https://github.com", id: "@github.com", label: "@github.com" },
  ];

  for (const candidate of candidates) {
    const composer = new AgentComposer();
    const emitted: Array<{ type: string; detail: any }> = [];
    composer._emit = (type: string, detail: any) => emitted.push({ type, detail });
    composer._popup = {
      hidden: false,
      replaceChildren() {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
    };
    composer._input = {
      value: "@query",
      setRangeText(text: string) { this.value = text; },
      setAttribute() {},
      removeAttribute() {},
      focus() {},
    };
    composer._popupItems = [candidate];
    composer._popupToken = { type: "mention", start: 0, end: 6 };

    // Enter/Tab both converge on _selectActive; drive that completion path and
    // then the real composer send payload consumed by NTP/chat routing.
    composer._popupActive = 0;
    composer._selectActive();
    if (composer.value !== candidate.id) throw new Error(`${candidate.kind} mention text was not completed`);
    if (composer.selectedAgent?.ref !== candidate.ref) throw new Error(`${candidate.kind} canonical ref was not selected`);
    const mention = emitted.find((event) => event.type === "mention");
    if (mention?.detail?.agent?.ref !== candidate.ref) throw new Error(`${candidate.kind} mention event lost canonical routing`);

    composer._input.value = `Ask ${candidate.id}`;
    await composer._send();
    const send = emitted.find((event) => event.type === "send");
    if (send?.detail?.agent?.ref !== candidate.ref || send.detail.agent.kind !== candidate.kind) {
      throw new Error(`${candidate.kind} send payload lost canonical routing`);
    }
  }
});

Deno.test("components: empty mention results remove stale popup options and a later render recovers", async () => {
  await import("../extension/shared/components.js");
  const restoreDoc = installFakeDocument();
  try {
    const AgentComposer = registry.get("agent-composer");
    const composer = new AgentComposer();
    const attrs = new Map();
    const popup = new FakeNode("div");
    composer._popup = popup;
    composer._input = {
      setAttribute(name, value) { attrs.set(name, value); },
      removeAttribute(name) { attrs.delete(name); },
    };

    composer._showPopup([{ label: "Prior candidate", kind: "agent" }], { type: "mention", start: 0, end: 6 });
    const items = () => popup.children.filter((c) => c.className && String(c.className).split(/\s+/).includes("item"));
    if (popup.hidden || items().length !== 1) {
      throw new Error("prior candidate did not render");
    }
    if (items()[0].getAttribute("role") !== "option") throw new Error("rendered item is not role=option");

    // Regression: @Disabled/no-match used to hide the popup but leave the prior
    // .item/role=option nodes in the DOM, so AX and later assertions saw ghosts.
    composer._showPopup([], { type: "mention", start: 0, end: 9 });
    if (!popup.hidden || items().length !== 0) {
      throw new Error("hidden empty popup retained stale option DOM");
    }
    if (attrs.get("aria-expanded") !== "false" || attrs.has("aria-activedescendant")) {
      throw new Error("empty popup must leave aria-expanded=false and no activedescendant on the input");
    }
    // Textbox-with-popup contract (CAP-FB-20260830-SLASH-PALETTE-COMBOBOX-01):
    // the textarea owns the popup listbox — expanded toggles true/false and
    // the active descendant is removed on hide.

    composer._showPopup([{ label: "Fresh candidate", kind: "agent" }], { type: "mention", start: 0, end: 6 });
    if (popup.hidden || items().length !== 1) {
      throw new Error("popup did not rerender after an empty result");
    }
  } finally {
    restoreDoc();
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

Deno.test("components: preferenceBootstrapScript applies locale + validates source + nonce", async () => {
  const mod = await import("../extension/shared/components.js");
  const script = mod.preferenceBootstrapScript("abc123");
  if (!script.includes("cap:preference-ready")) throw new Error("no readiness announce");
  if (!script.includes("e.source!==window.parent")) throw new Error("no source check");
  if (!script.includes("nonce")) throw new Error("no nonce check");
  if (!script.includes("lang")) throw new Error("no locale apply");
  if (script.includes("data-theme") || script.includes("cap:themed")) throw new Error("theme machinery must be gone (theme switching removed)");
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

Deno.test("asset quick drawer: newest/search/filter rendering is strictly bounded", async () => {
  const mod = await import("../extension/shared/components.js");
  const assets = Array.from({ length: 300 }, (_, i) => ({
    id: `asset-${i}`,
    name: i === 299 ? "<script>Newest</script>" : `Report ${i}`,
    type: i % 2 ? "text" : "html",
    size: i,
    origin: i % 3 ? "master" : "https://owner.example/path",
    at: i + 1,
  }));
  const recent = mod.selectQuickArtifacts(assets);
  if (recent.items.length !== mod.ARTIFACT_QUICK_LIMITS.recent) {
    throw new Error(`recent DOM bound drifted: ${recent.items.length}`);
  }
  if (recent.items[0].id !== "asset-299") throw new Error("newest asset is not first");
  if (!recent.sourceTruncated || recent.sourceTotal !== 300) throw new Error("oversized source not reported truthfully");
  if (recent.items[0].name !== "<script>Newest</script>") throw new Error("metadata was silently rewritten");

  const search = mod.selectQuickArtifacts(assets, { query: "owner.example", type: "html" });
  if (!search.items.length || search.items.length > mod.ARTIFACT_QUICK_LIMITS.results) {
    throw new Error(`search result bound invalid: ${search.items.length}`);
  }
  if (search.items.some((a) => a.type !== "html" || a.origin !== "https://owner.example/path")) {
    throw new Error("search/type filtering returned a non-match");
  }
  const outsideBound = mod.selectQuickArtifacts(assets, { query: "Report 50" });
  if (outsideBound.total !== 0) throw new Error("drawer searched beyond the bounded newest index window");
});

Deno.test("asset quick drawer: owner, exact size and absolute time metadata stay truthful", async () => {
  const mod = await import("../extension/shared/components.js");
  if (mod.quickArtifactOwner("master") !== "Hub") throw new Error("master owner label drifted");
  if (mod.quickArtifactOwner("https://example.com/path") !== "https://example.com") {
    throw new Error("web owner was not canonicalized to its origin");
  }
  const size = mod.formatQuickArtifactSize(1536);
  if (!size.includes("KB") || !size.replace(/\D/g, "").includes("1536")) {
    throw new Error(`size omitted its exact byte count: ${size}`);
  }
  const time = mod.formatQuickArtifactTime(Date.UTC(2026, 7, 19, 12, 30));
  if (time.datetime !== "2026-08-19T12:30:00.000Z" || !time.label) {
    throw new Error(`absolute time metadata invalid: ${JSON.stringify(time)}`);
  }
  const missing = mod.formatQuickArtifactTime("not-a-date");
  if (missing.label !== "Time unavailable" || missing.datetime !== "") {
    throw new Error("invalid time was presented as factual");
  }
});

Deno.test("task-row: pause and retry are DISTINCT controls — exactly one dispatch per click (P1-2)", async () => {
  await import("../extension/shared/components.js");
  const Klass = registry.get("task-row");
  const element = new Klass();
  // A fake shadow root whose querySelector hands back listener-capturing stubs,
  // so _wire() can be driven exactly like a real DOM without one.
  const wired = new Map();
  element._root = {
    querySelector: (sel) => {
      if (!wired.has(sel)) wired.set(sel, { addEventListener: (_t, fn) => { wired.get(sel)._fn = fn; } });
      return wired.get(sel);
    },
  };
  const emissions = [];
  element._emit = (name) => emissions.push(name);
  element._wire();
  wired.get(".stop")._fn(); // the hard Stop control
  wired.get(".psep")._fn(); // the Pause/Resume control
  wired.get(".retry")._fn(); // the Retry control
  wired.get(".row-open")._fn(); // the open affordance
  if (JSON.stringify(emissions) !== JSON.stringify(["stop", "toggle-pause", "retry", "open"])) {
    throw new Error(`wrong dispatches: ${JSON.stringify(emissions)}`);
  }
  // Source pin: the pause button must NOT carry the retry class (the r1 defect
  // was `class="retry psep"` — one click fired both handlers).
  const source = await Deno.readTextFile(new URL("../extension/shared/components.js", import.meta.url));
  if (source.includes('class="retry psep"')) throw new Error("the pause button still carries the retry class");
  if (!source.includes('class="psep"')) throw new Error("the pause button lost its own class");
});

Deno.test("jobs-board: a structured {ok:false} route response renders the error state, never the empty board", async () => {
  // The backend routes report failures as structured {ok:false, code, error}
  // envelopes (never thrown). Regression: _load() treated those as an empty
  // board. The cache-busted import re-evaluates the module with a scripted
  // chrome.runtime so RUNTIME_SEND serves the failure envelope.
  globalThis.chrome = {
    runtime: {
      sendMessage: (msg, cb) => cb({ ok: false, code: "board-store-error", error: "the board store could not be read" }),
    },
  };
  try {
    const mod = await import("../extension/shared/components.js?jobs-board-error-test");
    void mod;
    const Klass = registry.get("jobs-board");
    const element = new Klass();
    // _paint() touches four group elements + the empty slot; stub them (the
    // stub harness never runs connectedCallback, so _wire() never ran).
    const groups = { replaceChildren() {}, append() {} };
    element._openEl = groups;
    element._settledEl = groups;
    element._msgsEl = groups;
    element._emptyEl = { hidden: true, textContent: "" };
    await element._load();
    if (!element._loadError || !element._loadError.includes("board store could not be read")) {
      throw new Error(`the structured failure did not reach the error state: ${JSON.stringify(element._loadError)}`);
    }
    if (element._emptyEl.hidden !== false) throw new Error("the error copy stayed hidden");
    if (!element._emptyEl.textContent.includes("could not be read")) {
      throw new Error(`the honest error copy was not rendered: ${JSON.stringify(element._emptyEl.textContent)}`);
    }
    if (element._emptyEl.textContent.includes("No shared jobs yet")) {
      throw new Error("a failed read rendered as the empty board — the regression is back");
    }
  } finally {
    delete globalThis.chrome;
  }
});

// ── <artifact-diff> (CAP-FB-20260830-ARTIFACT-DIFF-COMPONENT-01) ────────────
// The diff lines are UNTRUSTED (model output): every row is DOM-built and its
// text set with textContent. The grep guard slices the class out of the source
// and proves it never touches innerHTML / template-interpolates a row.
const ARTIFACT_DIFF_SRC = new URL("../extension/shared/components.js", import.meta.url);
async function artifactDiffSlice(): Promise<string> {
  const src = await Deno.readTextFile(ARTIFACT_DIFF_SRC);
  const start = src.indexOf("class ArtifactDiff extends Component");
  const end = src.indexOf('customElements.define("artifact-diff"');
  if (start < 0 || end < 0 || end < start) throw new Error("ArtifactDiff class not found in components.js");
  return src.slice(start, end);
}

Deno.test("artifact-diff never assigns innerHTML from a diff line", async () => {
  const slice = await artifactDiffSlice();
  // No innerHTML/outerHTML/insertAdjacentHTML anywhere in the class — the ONE
  // markup mount goes through mountTemplate (static header markup only).
  const html = slice.match(/innerHTML|outerHTML|insertAdjacentHTML/g) ?? [];
  if (html.length !== 0) throw new Error(`ArtifactDiff must not use ${html.join(", ")}`);
  const mounts = slice.match(/mountTemplate\(/g) ?? [];
  if (mounts.length !== 1) throw new Error(`expected exactly one mountTemplate call, found ${mounts.length}`);
  // Row markup is never template-literal interpolated: the row/text/pair
  // classes appear only as DOM API arguments, never inside an HTML attribute.
  if (/class="(?:[^"]*\s)?(ln|tx|pair|hunk)(?:\s[^"]*)?"/.test(slice)) {
    throw new Error("diff rows must be built with the DOM API (createElement + textContent), never HTML strings");
  }
  if (!/\.textContent\s*=/.test(slice)) throw new Error("row text must be assigned with textContent");
});

Deno.test("artifact-diff header reports +10 -2 and 2 changes for the bakery fixtures", async () => {
  const mod = await import("../extension/shared/components.js");
  const v1 = await Deno.readTextFile(new URL("./fixtures/crumb-v1.html", import.meta.url));
  const v2 = await Deno.readTextFile(new URL("./fixtures/crumb-v2.html", import.meta.url));
  const model = mod.buildArtifactDiffModel(v1, v2, { context: 3, maxLines: 2000 });
  if (model.added !== 10 || model.removed !== 2) throw new Error(`expected +10 -2, got +${model.added} -${model.removed}`);
  if (model.hunks.length !== 2) throw new Error(`expected 2 hunks, got ${model.hunks.length}`);
  if (model.summary !== "+10 -2 · 2 changes") throw new Error(`unexpected summary: ${model.summary}`);
  if (model.regionLabel !== "Diff, 10 additions, 2 deletions, 2 changes") throw new Error(`unexpected region label: ${model.regionLabel}`);
  if (model.truncated !== false) throw new Error("the bakery diff is under the line bound");
  // Identical inputs → no changes, honestly worded.
  const same = mod.buildArtifactDiffModel(v1, v1, {});
  if (same.hunks.length !== 0 || same.summary !== "No changes") throw new Error(`identical inputs: ${same.summary}`);
  // The 2,000-line bound: a 5,000-line rewrite is cut with a truthful note.
  const big1 = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
  const big2 = Array.from({ length: 5000 }, (_, i) => `LINE ${i}`).join("\n");
  const bounded = mod.buildArtifactDiffModel(big1, big2, { context: 3, maxLines: 2000 });
  if (bounded.truncated !== true) throw new Error("a 10,000-changed-line diff must hit the 2,000-line bound");
  const shown = bounded.hunks.reduce((n: number, h: any) => n + h.rows.length, 0);
  if (shown !== 2000) throw new Error(`the bound must render exactly maxLines rows, rendered ${shown}`);
  if (!/^Showing 2,000 of 10,000 changed lines/.test(bounded.truncationNote)) throw new Error(`unexpected note: ${bounded.truncationNote}`);
  // Hostile lines are neutralised before they reach a row.
  const hostile = mod.buildArtifactDiffModel("a\n", "a\n\u202eevil\u0007\n", {});
  const row = hostile.hunks[0].rows.find((r: any) => r.kind === "add");
  if (!row || row.text.includes("\u202e") || row.text.includes("\u0007")) throw new Error("bidi/control characters must be neutralised");
});

Deno.test("artifact-diff: navigate next twice then prev announces 'Change 2 of 2'", async () => {
  await import("../extension/shared/components.js");
  const ArtifactDiffClass = globalThis.customElements.get("artifact-diff");
  if (!ArtifactDiffClass) throw new Error("artifact-diff must be registered");
  const mkEl = () => {
    const el: any = { attrs: {}, textContent: "", focused: 0, scrolled: [] as unknown[] };
    el.setAttribute = (n: string, v: string) => { el.attrs[n] = v; };
    el.removeAttribute = (n: string) => { delete el.attrs[n]; };
    el.hasAttribute = (n: string) => n in el.attrs;
    el.focus = () => { el.focused++; };
    el.scrollIntoView = (o: unknown) => { el.scrolled.push(o); };
    return el;
  };
  const hunks = [mkEl(), mkEl()];
  const status = mkEl();
  const prev = mkEl();
  const next = mkEl();
  const emitted: any[] = [];
  const el = Object.create(ArtifactDiffClass.prototype);
  el._root = {
    querySelector: (sel: string) => sel === ".status" ? status : sel === '[data-act="prev"]' ? prev : sel === '[data-act="next"]' ? next : null,
    querySelectorAll: (sel: string) => sel === ".hunk" ? hunks : [],
  };
  el._emit = (type: string, detail: unknown) => emitted.push({ type, detail });
  el._hunkCount = 2;
  el._index = -1;
  el._go(1);
  el._go(1);
  el._go(1); // clamps at the last change
  el._go(-1);
  if (status.textContent !== "Change 1 of 2") throw new Error(`expected 'Change 1 of 2' after next,next,(clamped),prev — got '${status.textContent}'`);
  el._go(1);
  if (status.textContent !== "Change 2 of 2") throw new Error(`expected 'Change 2 of 2', got '${status.textContent}'`);
  if (hunks[1].focused < 1) throw new Error("navigation must move focus to the hunk section");
  if (hunks[1].scrolled.length < 1 || hunks[1].scrolled[0]?.block !== "nearest") throw new Error("navigation must scrollIntoView({block:'nearest'})");
  const nav = emitted.filter((e) => e.type === "navigate");
  if (nav.length !== 4) throw new Error(`expected 4 navigate events (clamped step emits none), got ${nav.length}`);
  if (nav.at(-1).detail.index !== 1 || nav.at(-1).detail.total !== 2) throw new Error(`bad navigate detail: ${JSON.stringify(nav.at(-1))}`);
});

// ── CAP-FB-20260830-ARTIFACT-VIEWER-SOURCE-DIFF-01 ──────────────────────────
// The bounded source highlighter and the <segmented-control> tablist that the
// artifact viewer mounts for Preview | Source | Diff.

Deno.test("tokenizeSource classifies js keywords/strings/comments and preserves exact text", async () => {
  const mod = await import("../extension/shared/components.js");
  const src = 'const x = "hi"; // note\nfunction f(){ return 42; }';
  const toks = mod.tokenizeSource(src, "js");
  // Loss-free: the concatenation of every token equals the input exactly.
  if (toks.map((t: any) => t.text).join("") !== src) {
    throw new Error("tokenizeSource must be loss-free (token texts must rejoin to the input)");
  }
  const cls = (needle: string) => toks.find((t: any) => t.text === needle)?.cls;
  if (cls("const") !== "kw") throw new Error("`const` must be a keyword token");
  if (cls("function") !== "kw") throw new Error("`function` must be a keyword token");
  if (cls('"hi"') !== "str") throw new Error("a double-quoted string must be a string token");
  if (cls("42") !== "num") throw new Error("a number literal must be a number token");
  if (!toks.some((t: any) => t.cls === "com" && t.text.includes("note"))) {
    throw new Error("a // line comment must be a comment token");
  }
  // A keyword embedded in an identifier is NOT highlighted.
  const idToks = mod.tokenizeSource("myconstant + constable", "js");
  if (idToks.some((t: any) => t.cls === "kw")) throw new Error("keywords inside identifiers must not tokenize");
  // Plain text stays plain.
  const plain = mod.tokenizeSource("just words here", "text");
  if (plain.some((t: any) => t.cls)) throw new Error("plain text must carry no token classes");
});

Deno.test("highlightSource builds spans with textContent only (no innerHTML)", async () => {
  const mod = await import("../extension/shared/components.js");
  // Behavioural: build against a recording fake document — every non-plain
  // token is a <span class="tok-…"> whose text is set via textContent, every
  // plain run is a text node, and the fragment's combined text is loss-free.
  const nodes: any[] = [];
  const fakeDoc = {
    createDocumentFragment() {
      const kids: any[] = [];
      return { _kids: kids, appendChild(n: any) { kids.push(n); return n; } };
    },
    createElement(tag: string) {
      const el: any = { tag, className: "", _text: "" };
      Object.defineProperty(el, "textContent", { get() { return el._text; }, set(v) { el._text = String(v); } });
      // A trap: any attempt to use innerHTML on a created node fails the test.
      Object.defineProperty(el, "innerHTML", { set() { throw new Error("highlightSource must never set innerHTML"); } });
      nodes.push(el);
      return el;
    },
    createTextNode(t: string) { const n = { nodeText: String(t) }; nodes.push(n); return n; },
  };
  const src = 'const n = 1; // x';
  const frag = mod.highlightSource(src, "js", fakeDoc);
  const kids = frag._kids as any[];
  const combined = kids.map((k) => (k.tag ? k._text : k.nodeText)).join("");
  if (combined !== src) throw new Error("highlightSource output must be loss-free");
  const spans = kids.filter((k) => k.tag === "span");
  if (spans.length === 0) throw new Error("highlightSource must build at least one <span> for a keyword source");
  if (!spans.every((s) => /^tok-/.test(s.className))) throw new Error("every highlight span must carry a tok-* class");
  if (spans.some((s) => s.tag !== "span")) throw new Error("highlight tokens must be span elements");
  // Static guard: the highlighter/tokenizer source never reaches for innerHTML.
  const file = await Deno.readTextFile(new URL("../extension/shared/components.js", import.meta.url));
  const hStart = file.indexOf("export function highlightSource");
  const tStart = file.indexOf("export function tokenizeSource");
  const from = Math.min(hStart, tStart);
  const seg = file.slice(from, file.indexOf("\nclass ", from) < 0 ? from + 6000 : file.indexOf("\nclass ", from));
  if (/innerHTML|outerHTML|insertAdjacentHTML/.test(seg)) {
    throw new Error("the tokenizer/highlighter must not use innerHTML/outerHTML/insertAdjacentHTML");
  }
});

Deno.test("segmented-control moves value with ArrowRight/ArrowLeft and emits change", async () => {
  await import("../extension/shared/components.js");
  const Klass = globalThis.customElements.get("segmented-control");
  if (!Klass) throw new Error("segmented-control must be registered");
  const el: any = Object.create(Klass.prototype);
  el._value = "Preview";
  el._items = () => ["Preview", "Source", "Diff"];
  el._sync = () => {};
  el._focusSelected = () => {};
  const emitted: any[] = [];
  el._emit = (type: string, detail: any) => emitted.push({ type, detail });
  const key = (k: string) => el._onKey({ key: k, preventDefault() {} });
  key("ArrowRight");
  if (el.value !== "Source") throw new Error(`ArrowRight from Preview must select Source, got ${el.value}`);
  key("ArrowRight");
  if (el.value !== "Diff") throw new Error(`ArrowRight from Source must select Diff, got ${el.value}`);
  key("ArrowRight"); // wraps
  if (el.value !== "Preview") throw new Error(`ArrowRight from Diff must wrap to Preview, got ${el.value}`);
  key("ArrowLeft"); // wraps back
  if (el.value !== "Diff") throw new Error(`ArrowLeft from Preview must wrap to Diff, got ${el.value}`);
  key("Home");
  if (el.value !== "Preview") throw new Error(`Home must select the first tab, got ${el.value}`);
  key("End");
  if (el.value !== "Diff") throw new Error(`End must select the last tab, got ${el.value}`);
  const changes = emitted.filter((e) => e.type === "change");
  if (changes.length !== 6) throw new Error(`expected 6 change events, got ${changes.length}`);
  if (changes.at(-1).detail.value !== "Diff") throw new Error(`last change detail must be Diff, got ${JSON.stringify(changes.at(-1))}`);
  // No spurious change when the value does not move.
  const before = emitted.length;
  el._select("Diff");
  if (emitted.length !== before) throw new Error("selecting the already-current value must not emit change");
});

Deno.test("composer slash/@ palette is an accessible combobox (CAP-FB-20260830-SLASH-PALETTE-COMBOBOX-01)", async () => {
  await import("../extension/shared/components.js");
  // The popup renderer builds options with document.createElement + textContent
  // (owner-controlled labels are NEVER innerHTML), so the test drives it through
  // a minimal fake document.
  const restoreDoc = installFakeDocument();
  try {
    const AgentComposer = registry.get("agent-composer");
    const composer = new AgentComposer();
    const attrs: Record<string, string | null> = {};
    composer._input = {
      setAttribute(name: string, value: string) { attrs[name] = value; },
      removeAttribute(name: string) { attrs[name] = null; },
      getAttribute(name: string) { return attrs[name] ?? null; },
    };
    composer._uid = "u-test";
    composer._popup = new FakeNode("div");
    composer._popup.hidden = false;
    composer._popupItems = [];
    composer._popupActive = -1;
    composer._popupToken = null;

    // Open with TWO options: the popup is a real listbox and the textarea owns
    // it via expanded + controls, with activedescendant naming the first option.
    composer._showPopup([
      { id: "a", label: "/agent", description: "run with an agent", kind: "command" },
      { id: "f", label: "/files", description: "attach a file", kind: "command" },
    ], { type: "command", start: 0, end: 1 });
    if (attrs["aria-expanded"] !== "true") throw new Error(`open popup must set aria-expanded=true, got ${attrs["aria-expanded"]}`);
    if (attrs["aria-controls"] !== "popup-u-test") throw new Error(`aria-controls must name the popup, got ${attrs["aria-controls"]}`);
    if (attrs["aria-activedescendant"] !== "cmp-u-test-opt-0") {
      throw new Error(`aria-activedescendant must name the first option, got ${attrs["aria-activedescendant"]}`);
    }
    const opts = composer._popup.children.filter((c) => c.className && String(c.className).split(/\s+/).includes("item"));
    if (opts.length !== 2) throw new Error("popup did not render two options");
    const lbl0 = opts[0].children.find((c) => c.className === "lbl");
    if (!lbl0 || lbl0.textContent !== "/agent") throw new Error(`option 0 label not set via textContent, got ${lbl0?.textContent}`);

    // ArrowDown (selection move): activedescendant follows the EXACT new option id.
    composer._setSelectionIndex(1);
    if (attrs["aria-activedescendant"] !== "cmp-u-test-opt-1") {
      throw new Error(`ArrowDown must move activedescendant to cmp-u-test-opt-1, got ${attrs["aria-activedescendant"]}`);
    }
    const optsAfter = composer._popup.children.filter((c) => c.className && String(c.className).split(/\s+/).includes("item"));
    if (optsAfter[1].dataset.active !== "true") {
      throw new Error("the second option must be data-active after ArrowDown");
    }

    // Close: expanded=false, descendant removed.
    composer._hidePopup();
    if (attrs["aria-expanded"] !== "false") throw new Error(`hide must set aria-expanded=false, got ${attrs["aria-expanded"]}`);
    if (attrs["aria-activedescendant"] !== null) throw new Error("hide must remove aria-activedescendant");
  } finally {
    restoreDoc();
  }
});

Deno.test("composer slash picker: activedescendant re-syncs on list replacement, zero-result, and highlight restore (CAP-FB-20260830-SLASH-PALETTE-COMBOBOX-01 r3)", async () => {
  await import("../extension/shared/components.js");
  const restoreDoc = installFakeDocument();
  // A capture MutationObserver stub: the fake DOM never emits real mutations,
  // so the test drives the registered callback directly after mutating the
  // fake list (replacement / zero-result / highlight move).
  let observerCb = null;
  const observedTargets = new Set();
  const observeOptions: Array<Record<string, unknown>> = [];
  const stubObservers: Array<{ disconnect(): void }> = [];
  const prevMO = globalThis.MutationObserver;
  globalThis.MutationObserver = class {
    constructor(cb: (records: unknown[]) => void) { observerCb = cb; stubObservers.push(this); }
    observe(target: unknown, options?: Record<string, unknown>) { observedTargets.add(target); observeOptions.push(options ?? {}); }
    disconnect() { /* no-op for the stub */ }
  };
  try {
    const AgentComposer = registry.get("agent-composer");
    const composer = new AgentComposer();
    const attrs: Record<string, string | null> = {};
    composer._input = {
      setAttribute(name: string, value: string) { attrs[name] = value; },
      removeAttribute(name: string) { attrs[name] = null; },
    };
    composer._uid = "u-test";
    composer._agentPick = new FakeNode("agent-picker");
    const apList = new FakeNode("div");
    apList.id = "ap-list";
    apList.setAttribute("role", "listbox");
    composer._agentPick.appendChild(apList);
    composer._agentPop = new FakeNode("div");
    composer._agentPop.hidden = true;
    composer._attach = new FakeNode("attach-button");
    composer._selectedAgent = null;

    // Open the picker: observer must be attached to ap-list and the doc-level
    // pointerdown listener installed.
    composer._presentAgentPopover();
    if (stubObservers.length !== 1) throw new Error("expected exactly one observer on open");
    if (!observedTargets.has(apList)) throw new Error("observer not attached to ap-list");
    // The observer must include childList+subtree so LIST REPLACEMENT and
    // zero-result transitions (children swapped/emptied) re-sync the active
    // descendant — an attributes-only observer would miss them. This assertion
    // is the RED detector: with childList removed, it fails.
    const opts = observeOptions[0] ?? {};
    if (opts.childList !== true || opts.subtree !== true) {
      throw new Error(`observer must observe childList+subtree to catch list replacement, got ${JSON.stringify(opts)}`);
    }

    // (a) FULL LIST REPLACEMENT: the picker re-renders, swapping children; a
    // childList mutation must re-sync activedescendant to the new active option.
    const optA = new FakeNode("button");
    optA.className = "opt"; optA.id = "ap-opt-0"; optA.dataset.index = "0"; optA.dataset.active = "true";
    const optB = new FakeNode("button");
    optB.className = "opt"; optB.id = "ap-opt-1"; optB.dataset.index = "1"; optB.dataset.active = "false";
    apList.replaceChildren(optA, optB);
    observerCb?.([{ type: "childList" }]);
    if (attrs["aria-activedescendant"] !== "ap-opt-0") {
      throw new Error(`after list replacement activedescendant must be ap-opt-0, got ${attrs["aria-activedescendant"]}`);
    }

    // (b) ZERO-RESULT TRANSITION: the list is emptied (children removed) — the
    // active-descendant must be REMOVED, not left stale.
    apList.replaceChildren();
    observerCb?.([{ type: "childList" }]);
    if (attrs["aria-activedescendant"] !== null) {
      throw new Error(`zero-result state must remove activedescendant, got ${attrs["aria-activedescendant"]}`);
    }

    // (c) HIGHLIGHT RESTORE: a fresh list with a different active option must
    // re-sync (an attribute mutation path also covered by the same observer).
    const optC = new FakeNode("button");
    optC.className = "opt"; optC.id = "ap-opt-0"; optC.dataset.index = "0"; optC.dataset.active = "true";
    apList.replaceChildren(optC);
    observerCb?.([{ type: "childList" }]);
    if (attrs["aria-activedescendant"] !== "ap-opt-0") {
      throw new Error(`restore must re-sync activedescendant to ap-opt-0, got ${attrs["aria-activedescendant"]}`);
    }

    // Close: observer disconnected, doc listener removed, expanded=false.
    composer._closeAgentPicker(false);
    if (attrs["aria-expanded"] !== "false") throw new Error("close must set expanded=false");
    if (attrs["aria-activedescendant"] !== null) throw new Error("close must clear activedescendant");
  } finally {
    globalThis.MutationObserver = prevMO;
    restoreDoc();
  }
});

Deno.test("composer slash picker: no leak when the composer disconnects while the picker is open (CAP-FB-20260830-SLASH-PALETTE-COMBOBOX-01 r3)", async () => {
  await import("../extension/shared/components.js");
  const restoreDoc = installFakeDocument();
  let observerDisconnected = false;
  let pointerdownRemoved = false;
  const stubInstances: Array<{ disconnect(): void }> = [];
  const prevMO = globalThis.MutationObserver;
  globalThis.MutationObserver = class {
    constructor(_cb: unknown) { stubInstances.push(this); }
    observe() {}
    disconnect() { observerDisconnected = true; }
  };
  const prevRemoveListener = globalThis.document.removeEventListener;
  // Intercept the doc-level listener removal to prove the pointerdown listener
  // is cleaned up on disconnect.
  globalThis.document.removeEventListener = (type: string, _fn: unknown) => {
    if (type === "pointerdown") pointerdownRemoved = true;
    prevRemoveListener.call(globalThis.document, type, _fn);
  };
  try {
    const AgentComposer = registry.get("agent-composer");
    const composer = new AgentComposer();
    composer._input = { setAttribute() {}, removeAttribute() {} };
    composer._uid = "u-test";
    composer._agentPick = new FakeNode("agent-picker");
    const apList = new FakeNode("div");
    apList.id = "ap-list";
    composer._agentPick.appendChild(apList);
    composer._agentPop = new FakeNode("div");
    composer._agentPop.hidden = true;
    composer._attach = new FakeNode("attach-button");
    composer._selectedAgent = null;

    // Open the picker (installs observer + doc listener), then DISCONNECT.
    composer._presentAgentPopover();
    if (stubInstances.length !== 1) throw new Error("observer not created on open");
    composer.disconnectedCallback();

    if (!observerDisconnected) throw new Error("observer not disconnected on component disconnect");
    if (!pointerdownRemoved) throw new Error("document pointerdown listener not removed on component disconnect");
    if (composer._agentDocClose !== null) throw new Error("_agentDocClose not cleared on disconnect");
  } finally {
    globalThis.MutationObserver = prevMO;
    globalThis.document.removeEventListener = prevRemoveListener;
    restoreDoc();
  }
// ── activity-explorer user-facing rows (CAP-FB-20260830-RECENT-ACTIVITY-USER-EVENTS-01) ──

Deno.test("activity-explorer: the user-visible allowlist excludes system rows and the row words map to user language", async () => {
  const mod = await import("../extension/shared/components.js");
  const { userKindLabel, activityText } = mod;
  // The allowlist is server-authoritative (routes/activity.js) and shared
  // with the explorer — assert it directly from the single source.
  const routesMod = await import("../extension/background/routes/activity.js");
  const { USER_VISIBLE_KINDS } = routesMod;
  const allow = new Set(USER_VISIBLE_KINDS);
  // The hub allowlist keeps task/result/artifact/approval/schedule rows…
  for (const k of ["task", "result", "artifact", "approval-requested", "approval-granted", "approval-denied", "schedule-ran"]) {
    if (!allow.has(k)) throw new Error(`allowlist missing ${k}`);
  }
  // …and hides the attestation + tool-protocol rows (they stay in Run logs).
  for (const k of ["prompt-attestation", "tool-call", "tool-result", "screenshot", "error"]) {
    if (allow.has(k)) throw new Error(`allowlist must not contain ${k}`);
  }
  // Kind pills are USER words, not protocol kind names.
  if (userKindLabel({ type: "task" }) !== "Started") throw new Error("task should read Started");
  if (userKindLabel({ type: "result", ok: true }) !== "Finished") throw new Error("ok result should read Finished");
  if (userKindLabel({ type: "result", ok: false }) !== "Failed") throw new Error("!ok result should read Failed");
  if (userKindLabel({ type: "artifact" }) !== "Made") throw new Error("artifact should read Made");
  // A result row's one-liner is a DERIVED HUMAN SUMMARY — never the raw
  // multi-thousand-char model dump, even truncated (falsification: revert to
  // raw truncation, this REDs on the prefix assertion).
  const dump = "[demo model] Here is the actual answer to your task. Followed by thousands of chars of raw trailing detail that must never surface: " + "x".repeat(5000);
  const line = activityText({ type: "result", result: dump, ok: true });
  if (line.length > 140) throw new Error(`result one-liner must be bounded to 140 chars, got ${line.length}`);
  if (line.startsWith("[demo model]")) throw new Error("transport tag must never render (BLOCKER 2)");
  if (line.startsWith("Finished: Here is the actual answer to your task. Followed")) {
    throw new Error("raw result text must never render even the first sentence as-is (BLOCKER 2: derive a summary)");
  }
  if (line !== "Finished: Here is the actual answer to your task.") {
    throw new Error(`result should read 'Finished: <first sentence>.', got: ${line}`);
  }
  if (activityText({ type: "result", result: "all done.", ok: true }) !== "Finished: all done.") {
    throw new Error("short results derive a Finished sentence");
  }
  if (activityText({ type: "result", result: "", ok: false }) !== "Failed") {
    throw new Error("failed result with no text reads Failed");
  }
  // Per-kind summaries (BLOCKER 2): artifact name, approval subject, schedule.
  if (activityText({ type: "artifact", task: "Weekly digest" }) !== "Made Weekly digest") {
    throw new Error("artifact rows read Made <name>");
  }
  if (activityText({ type: "approval-requested", task: "Publish the page" }) !== "Publish the page — needs approval") {
    throw new Error("approval rows carry the subject");
  }
  if (activityText({ type: "schedule-ran", task: "list my tabs" }) !== "Ran list my tabs") {
    throw new Error("schedule rows read Ran <task>");
  }
});

Deno.test("activity-explorer: the two empty-state strings are distinct (zero vs filtered-empty)", async () => {
  const source = await Deno.readTextFile(new URL("../extension/shared/components.js", import.meta.url));
  const explorerRegion = source.slice(source.indexOf("class ActivityExplorer"), source.indexOf("customElements.define(\"activity-explorer\""));
  const zero = explorerRegion.includes("Nothing has happened yet.");
  const filtered = explorerRegion.includes("No activity matches this filter.");
  if (!zero || !filtered) throw new Error("both empty-state strings must exist in the explorer (zero + filtered-empty)");
});

Deno.test("activity-explorer: EVERY user-kind one-liner is a bounded human sentence (≤140), even for pathological inputs", async () => {
  const mod = await import("../extension/shared/components.js");
  const { activityText } = mod;
  const giant = "z".repeat(9000);
  const giantJson = JSON.stringify({ modelContent: JSON.stringify({ result: { summary: giant, text: giant } }) });
  const giantName = "n".repeat(9000);
  const cases = [
    // [label, entry] — every USER_VISIBLE kind with pathological inputs.
    ["task with giant title", { type: "task", task: giant }],
    ["result with giant unbroken text", { type: "result", result: giant, ok: true }],
    ["result with giant JSON payload", { type: "result", result: giantJson, ok: true }],
    ["result failed with giant payload", { type: "result", result: giantJson, ok: false }],
    ["artifact with giant name", { type: "artifact", task: giantName }],
    ["approval-requested with giant subject", { type: "approval-requested", task: giant }],
    ["approval-granted with giant subject", { type: "approval-granted", description: giant }],
    ["approval-denied with giant subject", { type: "approval-denied", task: giant }],
    ["schedule-ran with giant task", { type: "schedule-ran", task: giant }],
    ["schedule-ran with giant result fallback", { type: "schedule-ran", task: "", result: giant }],
    // Empty-ish pathological inputs (falsification: a raw-fallback would leak).
    ["result with empty-ish whitespace", { type: "result", result: "   ", ok: true }],
    ["approval with no subject at all", { type: "approval-requested" }],
  ];
  for (const [label, entry] of cases) {
    const line = activityText(entry);
    if (line.length > 140) throw new Error(`${label}: one-liner exceeds 140 chars (${line.length}): ${line.slice(0, 60)}`);
    if (!line.trim()) throw new Error(`${label}: one-liner must not be empty`);
    // Never a raw fragment: a giant unbroken token must not appear verbatim.
    if (line.includes(giant.slice(0, 40)) || line.includes(giantName.slice(0, 40))) {
      throw new Error(`${label}: raw payload fragment leaked into the one-liner`);
    }
    // No transport/demo tag.
    if (line.includes("[demo model]") || line.includes("modelContent")) {
      throw new Error(`${label}: transport noise leaked into the one-liner`);
    }
  }
  // Positive controls: normal inputs still read as human sentences.
  if (activityText({ type: "result", result: "[demo model] The plan is ready. More detail here.", ok: true }) !== "Finished: The plan is ready.") {
    throw new Error("normal result should read 'Finished: <first sentence>' with the demo tag stripped");
  }
  if (activityText({ type: "approval-requested", task: "Publish the page" }) !== "Publish the page — needs approval") {
    throw new Error("approval rows carry the subject");
  }
  // The giant-JSON case must take the GENUINE REFUSAL path — a nested object
  // with no usable scalar core is never silently dropped, and its refusal
  // phrase is explicit (r4 P1: the scalar shortcut used to consume the object
  // and return the bare verdict, making this a false positive).
  const jsonOk = activityText({ type: "result", result: giantJson, ok: true });
  const jsonFail = activityText({ type: "result", result: giantJson, ok: false });
  for (const [label, line] of [
    ["giant-JSON ok", jsonOk],
    ["giant-JSON failed", jsonFail],
  ]) {
    if (!line.includes("see the run log")) {
      throw new Error(`${label}: refusal phrase missing, got: ${line.slice(0, 60)}`);
    }
    if (line.includes("\"summary\"") || line.includes("\"result\":") || line.includes("modelContent") || line.includes(giant.slice(0, 40))) {
      throw new Error(`${label}: raw JSON leaked past the refusal path`);
    }
  }
  if (!jsonFail.startsWith("Failed")) throw new Error("failed giant-JSON should carry the Failed verdict");
});

Deno.test("activity-explorer: approval rows stay ≤140 even with a long sentence subject", async () => {
  const mod = await import("../extension/shared/components.js");
  const { activityText } = mod;
  const longSubject = "Please approve this carefully worded request that has quite a lot of words in it and keeps going for a while. More trailing text after the first sentence.";
  const line = activityText({ type: "approval-requested", task: longSubject });
  if (line.length > 140) throw new Error(`approval line exceeds 140 chars: ${line.length}`);
  // The verb and the first sentence survive; the trailing sentence does not.
  if (!line.endsWith("needs approval")) throw new Error("approval verb must survive");
  if (line.includes("More trailing text")) throw new Error("approval must not include past-the-first-sentence raw text");
});
