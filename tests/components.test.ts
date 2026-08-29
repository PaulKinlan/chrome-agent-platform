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
  "storage-durability-warning",
  "first-run-guide",
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
    click() { this.dispatch("click", { target: this }); }
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

Deno.test("components: every design-system element registers as a custom element", async () => {
  await import("../extension/shared/components.js");
  for (const name of COMPONENTS) {
    if (!registry.has(name)) {
      throw new Error(`missing custom element: <${name}>`);
    }
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
  const AgentComposer = registry.get("agent-composer");
  const composer = new AgentComposer();
  const attrs = new Map();
  const popup = {
    hidden: true,
    _html: "",
    _items: [] as any[],
    set innerHTML(value: unknown) {
      this._html = String(value);
      const count = (this._html.match(/class="item"/g) ?? []).length;
      this._items = Array.from({ length: count }, (_, index) => ({
        dataset: { index: String(index) },
        addEventListener() {},
        scrollIntoView() {},
      }));
    },
    get innerHTML() { return this._html; },
    replaceChildren() { this._html = ""; this._items = []; },
    querySelectorAll(selector: string) {
      return selector === ".item" || selector === '[role="option"]' ? this._items : [];
    },
    querySelector(selector: string) {
      const match = selector.match(/data-index="?(\d+)/);
      return match ? this._items[Number(match[1])] ?? null : null;
    },
  };
  composer._popup = popup;
  composer._input = {
    setAttribute(name: string, value: unknown) { attrs.set(name, value); },
    removeAttribute(name: string) { attrs.delete(name); },
  };

  composer._showPopup([{ label: "Prior candidate", kind: "agent" }], { type: "mention", start: 0, end: 6 });
  if (popup.hidden || popup.querySelectorAll(".item").length !== 1) {
    throw new Error("prior candidate did not render");
  }

  // Regression: @Disabled/no-match used to hide the popup but leave the prior
  // .item/role=option nodes in the DOM, so AX and later assertions saw ghosts.
  composer._showPopup([], { type: "mention", start: 0, end: 9 });
  if (!popup.hidden || popup.querySelectorAll(".item").length !== 0 || popup.querySelectorAll('[role="option"]').length !== 0) {
    throw new Error("hidden empty popup retained stale option DOM");
  }
  if (attrs.has("aria-expanded") || attrs.has("aria-activedescendant")) {
    throw new Error("empty popup left combobox accessibility state on the input");
  }
  // A11Y (UX-006): the plain textarea may never carry combobox state — the
  // reset must leave NO aria-expanded/activedescendant on the input at all
  // (the ghost-DOM guard above still pins the popup itself).

  composer._showPopup([{ label: "Fresh candidate", kind: "agent" }], { type: "mention", start: 0, end: 6 });
  if (popup.hidden || popup.querySelectorAll(".item").length !== 1) {
    throw new Error("popup did not rerender after an empty result");
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
  wired.get(".psep")._fn(); // the Pause/Resume control
  wired.get(".retry")._fn(); // the Retry control
  wired.get(".row-open")._fn(); // the open affordance
  if (JSON.stringify(emissions) !== JSON.stringify(["toggle-pause", "retry", "open"])) {
    throw new Error(`wrong dispatches: ${JSON.stringify(emissions)}`);
  }
  // Source pin: the pause button must NOT carry the retry class (the r1 defect
  // was `class="retry psep"` — one click fired both handlers).
  const source = await Deno.readTextFile(new URL("../extension/shared/components.js", import.meta.url));
  if (source.includes('class="retry psep"')) throw new Error("the pause button still carries the retry class");
  if (!source.includes('class="psep"')) throw new Error("the pause button lost its own class");
});
