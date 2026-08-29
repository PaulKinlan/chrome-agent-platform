// @ts-nocheck — focused behavioral tests for mic-button recording-state
// lifecycle (round-2 review fixes). Stubs the browser globals the module
// touches, then exercises the REAL MicButton class: pending-getUserMedia
// cancellation (stop/disconnect/hide/double-click), disconnect/reattach
// attribute honesty, and the analyser-failure AudioContext cleanup.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

const registry = new Map();

class ShadowRootStub {
  constructor() { this.innerHTML = ""; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}
class HTMLElementStub {
  constructor() { this._attrs = new Map(); }
  attachShadow() { return new ShadowRootStub(); }
  getAttribute(n) { return this._attrs.has(n) ? this._attrs.get(n) : null; }
  hasAttribute(n) { return this._attrs.has(n); }
  setAttribute(n, v) {
    const old = this.hasAttribute(n) ? this.getAttribute(n) : null;
    this._attrs.set(n, String(v));
    if (this.constructor.observedAttributes?.includes(n)) {
      this.attributeChangedCallback?.(n, old, String(v));
    }
  }
  removeAttribute(n) {
    if (!this._attrs.has(n)) return;
    const old = this.getAttribute(n);
    this._attrs.delete(n);
    if (this.constructor.observedAttributes?.includes(n)) {
      this.attributeChangedCallback?.(n, old, null);
    }
  }
  dispatchEvent() { return true; }
  addEventListener() {}
  removeEventListener() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
}

globalThis.HTMLElement = HTMLElementStub;
globalThis.customElements = {
  define: (name, cls) => registry.set(name, cls),
  get: (name) => registry.get(name),
};
globalThis.window = globalThis;
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init = {}) { this.type = type; this.detail = init.detail ?? {}; }
};
globalThis.matchMedia = () => ({ matches: false });
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.document = {
  body: {},
  addEventListener() {},
  removeEventListener() {},
};
Object.defineProperty(globalThis, "navigator", {
  value: { mediaDevices: null },
  configurable: true,
  writable: true,
});

await import("../extension/shared/components.js?test=mic-button-state");
const MicButton = registry.get("mic-button");
assert(MicButton, "mic-button must register");

// ── Harness ────────────────────────────────────────────────────────────────
function fakeStream() {
  const tracks = [{ stopped: 0, stop() { this.stopped++; } }];
  return { tracks, getTracks() { return this.tracks; } };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

function makeMic() {
  const el = new MicButton();
  const events = [];
  el._emit = (type, detail) => events.push({ type, detail });
  const bars = Array.from({ length: 5 }, () => ({ style: {} }));
  const wave = {
    classList: { added: [], add(c) { this.added.push(c); }, contains(c) { return this.added.includes(c); } },
    querySelectorAll: (sel) => (sel === "span" ? bars : []),
  };
  const button = {
    offsetParent: {}, // visible by default; null = display:none ancestor
    addEventListener() {},
  };
  const root = new ShadowRootStub();
  root.querySelector = (sel) => {
    if (sel === ".wave") return wave;
    if (sel === ".mic") return button;
    return null;
  };
  el._root = root;
  el._button = button;
  return { el, events, wave, bars, button, root };
}

function installFakeSR() {
  const made = [];
  class FakeSR {
    constructor() {
      this.continuous = false; this.interimResults = false; this.lang = "";
      this.started = 0; this.stopped = 0;
      made.push(this);
    }
    start() { this.started++; }
    stop() { this.stopped++; }
    abort() { this.aborted = (this.aborted || 0) + 1; }
  }
  window.SpeechRecognition = FakeSR;
  window.webkitSpeechRecognition = FakeSR;
  return made;
}

// ── P1-a: pending getUserMedia must be cancellable ─────────────────────────
Deno.test("mic state: SpeechRecognition starts without waiting for a PENDING meter stream, and stop releases the late stream", async () => {
  const { el } = makeMic();
  const srMade = installFakeSR();
  const gum = deferred();
  navigator.mediaDevices = { getUserMedia: () => gum.promise };
  await el.start();
  assertEquals(el._listening, true, "dictation must enter its visible listening state immediately");
  assertEquals(srMade.length, 1, "recognition must be constructed while the meter request is pending");
  assertEquals(srMade[0].started, 1, "recognition must start without waiting for the meter");
  assertEquals(el.waveformMode, "fallback", "the CSS waveform carries the state until a live meter is ready");
  el.stop(); // the send path calls stop() unconditionally on accepted send
  const stream = fakeStream();
  gum.resolve(stream);
  await tick();
  assertEquals(el._listening, false, "stop() must leave dictation idle");
  assertEquals(el.hasAttribute("listening"), false, "the listening attribute must be removed");
  assertEquals(stream.tracks[0].stopped, 1, "the late stream must be stopped, not leaked");
  assertEquals(el._mediaStream, null, "the late stream must not be retained");
  assertEquals(srMade[0].stopped, 1, "recognition must be stopped independently of the pending meter");
});

Deno.test("mic state: a rejected meter stream keeps recognition running with a visible fallback", async () => {
  const { el, events } = makeMic();
  const srMade = installFakeSR();
  navigator.mediaDevices = { getUserMedia: () => Promise.reject(new DOMException("denied", "NotAllowedError")) };
  await el.start();
  await tick();
  assertEquals(el._listening, true, "meter permission must not block dictation");
  assertEquals(srMade[0].started, 1);
  assertEquals(el.waveformMode, "fallback");
  assert(
    events.some((e) => e.type === "mic-error" && /dictation continues/.test(e.detail?.message ?? "")),
    "the owner must be told that only the live waveform failed",
  );
  el.stop();
});

Deno.test("mic state: disconnect during a PENDING getUserMedia cancels the start and releases the late stream", async () => {
  const { el } = makeMic();
  const srMade = installFakeSR();
  const gum = deferred();
  navigator.mediaDevices = { getUserMedia: () => gum.promise };
  const startP = el.start();
  await tick();
  el.disconnectedCallback();
  const stream = fakeStream();
  gum.resolve(stream);
  await startP;
  await tick();
  assertEquals(el._listening, false);
  assertEquals(el.hasAttribute("listening"), false);
  assertEquals(stream.tracks[0].stopped, 1, "the late stream must be stopped after disconnect");
  assertEquals(el._mediaStream, null);
  assertEquals(srMade.length, 1, "recognition starts before the decorative stream request");
  assertEquals(srMade[0].started, 1);
  assertEquals(srMade[0].aborted, 1, "disconnect aborts recognition while the meter is pending");
});

Deno.test("mic state: a newer start during PENDING getUserMedia supersedes the first — the first stream is stopped, never orphaned", async () => {
  const { el } = makeMic();
  installFakeSR();
  const gums = [deferred(), deferred()];
  let call = 0;
  navigator.mediaDevices = { getUserMedia: () => gums[Math.min(call++, 1)].promise };
  const p1 = el.start();
  const p2 = el.start();
  const streamA = fakeStream();
  const streamB = fakeStream();
  gums[0].resolve(streamA);
  await p1;
  await tick();
  gums[1].resolve(streamB);
  await p2;
  await tick();
  assertEquals(streamA.tracks[0].stopped, 1, "the superseded stream must be stopped");
  assertEquals(streamB.tracks[0].stopped, 0, "the winning stream stays open");
  assertEquals(el._mediaStream, streamB, "the live stream is the second start's");
  assertEquals(el._listening, true);
  el.stop();
});

Deno.test("mic state: composer hidden while getUserMedia is PENDING — the late resolution must not start a background recording", async () => {
  const { el, events, button } = makeMic();
  const srMade = installFakeSR();
  const gum = deferred();
  navigator.mediaDevices = { getUserMedia: () => gum.promise };
  const startP = el.start();
  await tick();
  button.offsetParent = null; // view switch display:none-d the composer mid-request
  const stream = fakeStream();
  gum.resolve(stream);
  await startP;
  await tick();
  assertEquals(el._listening, false, "must not start recording into a hidden composer");
  assertEquals(el.hasAttribute("listening"), false);
  assertEquals(stream.tracks[0].stopped, 1, "the late stream must be stopped");
  assertEquals(srMade.length, 1, "recognition starts before the decorative stream request");
  assertEquals(srMade[0].stopped, 1, "the hidden-composer guard stops recognition");
  assert(
    events.some((e) => e.type === "mic-error" && /hidden/.test(e.detail?.message ?? "")),
    "the owner must be told why the recording did not start",
  );
});

Deno.test("mic state: PAGEHIDE while getUserMedia is PENDING invalidates the start — the late stream is stopped, never adopted", async () => {
  const { el } = makeMic();
  const srMade = installFakeSR();
  el.connectedCallback(); // registers the real pagehide listener on window
  const gum = deferred();
  navigator.mediaDevices = { getUserMedia: () => gum.promise };
  const startP = el.start();
  await tick();
  window.dispatchEvent(new Event("pagehide")); // page hides mid-permission-prompt
  const stream = fakeStream();
  gum.resolve(stream);
  await startP;
  await tick();
  assertEquals(el._listening, false, "must not record into a hidden page");
  assertEquals(el.hasAttribute("listening"), false, "the listening attribute must never be set");
  assertEquals(stream.tracks[0].stopped, 1, "the late stream must be stopped, not leaked");
  assertEquals(el._mediaStream, null, "the late stream must not be retained");
  assertEquals(srMade.length, 1, "recognition starts before the decorative stream request");
  assertEquals(srMade[0].stopped, 1, "pagehide stops recognition while the meter is pending");
});

// ── P1-b: disconnect must not leave a false recording affordance ───────────
Deno.test("mic state: disconnect drops the host listening attribute — reattach renders IDLE, and the detached removal does not re-render", () => {
  const { el, root } = makeMic();
  installFakeSR();
  let renders = 0;
  const origRender = el._render.bind(el);
  el._render = () => { renders++; origRender(); };
  el._listening = true;
  el.setAttribute("listening", "");
  el.connectedCallback(); // renders the recording state
  assert(renders >= 1);
  assertStringIncludes(root.innerHTML, 'aria-pressed="true"');
  const rendersBeforeDisconnect = renders;
  el.disconnectedCallback();
  assertEquals(el.hasAttribute("listening"), false, "the stale listening attribute must be removed on disconnect");
  assertEquals(renders, rendersBeforeDisconnect, "removing the attribute while detached must NOT re-render");
  el.connectedCallback(); // reattach
  assertStringIncludes(root.innerHTML, 'aria-pressed="false"', "reattach must render idle");
  assert(
    !root.innerHTML.includes(' data-listening><span class="icon"'),
    "reattach must not render a false recording affordance on the button",
  );
});

// ── P1-c: analyser failure must not leak the AudioContext ──────────────────
Deno.test("mic state: a throwing createAnalyser falls back AND closes the half-built AudioContext", () => {
  const { el } = makeMic();
  installFakeSR();
  el._mediaStream = fakeStream();
  let closed = 0;
  window.AudioContext = class {
    constructor() { this.state = "running"; }
    createAnalyser() { throw new Error("analyser unavailable"); }
    createMediaStreamSource() { return { connect() {} }; }
    close() { closed++; return Promise.resolve(); }
  };
  el._startMeter();
  assertEquals(el.waveformMode, "fallback", "the CSS fallback carries the recording state");
  assertEquals(closed, 1, "the failed AudioContext must be closed, not leaked");
  assertEquals(el._audioCtx, null);
  el._stopMeter();
});

Deno.test("mic state: the live-meter happy path still works after the failure-path fix", () => {
  const { el, wave } = makeMic();
  installFakeSR();
  el._mediaStream = fakeStream();
  let closed = 0;
  window.AudioContext = class {
    constructor() { this.state = "running"; }
    createAnalyser() { return { fftSize: 0, connect() {}, getByteTimeDomainData() {} }; }
    createMediaStreamSource() { return { connect() {} }; }
    close() { closed++; return Promise.resolve(); }
  };
  el._startMeter();
  assertEquals(el.waveformMode, "live");
  assert(el._audioCtx, "the context is retained while metering");
  assert(wave.classList.contains("live"));
  assertEquals(closed, 0, "nothing to close on the happy path");
  el._stopMeter();
  assertEquals(closed, 1, "stop still closes the live context");
});
