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
  // The enumeration gate (fbg7i round 3): start() awaits the settled device
  // selection before the meter request, so a SYNCHRONOUS second start would
  // abandon the first at the gate before it ever requested a stream — no
  // orphan to supersede. The real race this test pins is a second click
  // landing while the first start's getUserMedia is PENDING (the permission
  // prompt can pend for seconds), so let the first start pass the gate first.
  await tick();
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

Deno.test("mic state (fbg7i): the IntersectionObserver pays the hidden-check ONLY for non-intersecting entries", () => {
  // The boot-cost fix: IO fires on every intersection-ratio change through the
  // boot's layout churn, and each unchecked callback read offsetParent — a
  // forced synchronous layout on a dirty tree (~90ms self per warm boot). The
  // callback must skip intersecting entries entirely and run _stopIfHidden
  // only on a non-intersecting transition, where the offsetParent distinction
  // (display:none ancestor vs merely scrolled-off) still governs.
  let ioCallback = null;
  const PrevIO = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = class {
    constructor(cb) { ioCallback = cb; }
    observe() {} unobserve() {} disconnect() {}
  };
  try {
    const el = new MicButton();
    const events = [];
    el._emit = (type, detail) => events.push({ type, detail });
    el.connectedCallback();
    assert(typeof ioCallback === "function", "the visibility observer is installed at connect");

    // Intersecting entries (boot churn) never reach the layout read.
    let checks = 0;
    el._stopIfHidden = () => { checks++; };
    ioCallback([{ isIntersecting: true }]);
    ioCallback([]);
    assertEquals(checks, 0, "intersecting/empty entries must skip the hidden check");

    // Non-intersecting: the REAL check runs; the offsetParent distinction governs.
    delete el._stopIfHidden; // back to the prototype method
    el._button = { offsetParent: {} }; // scrolled off but NOT display:none
    el._listening = true;
    ioCallback([{ isIntersecting: false }]);
    assertEquals(el._listening, true, "scrolled-off is not hidden — recording continues");
    el._button = { offsetParent: null }; // a display:none ancestor
    ioCallback([{ isIntersecting: false }]);
    assertEquals(el._listening, false, "display:none stops the recording");
    assert(
      events.some((e) => e.type === "mic-error" && /hidden/.test(e.detail?.message ?? "")),
      "the stop is reported as the hidden-composer stop",
    );
    el.disconnectedCallback();
  } finally {
    globalThis.IntersectionObserver = PrevIO;
  }
});

Deno.test("mic state (fbg7i): device enumeration is deferred off the connect path", () => {
  // connectedCallback used to call _loadDevices() synchronously — a ~65ms
  // main-thread enumeration continuation during stage1-composer of the NTP
  // boot. It must now be scheduled for idle (requestIdleCallback, or the
  // setTimeout fallback), not run in the connect task.
  let scheduled = null;
  const prevRic = globalThis.requestIdleCallback;
  globalThis.requestIdleCallback = (cb, opts) => { scheduled = { cb, opts }; return 1; };
  try {
    const el = new MicButton();
    let loads = 0;
    el._loadDevices = () => { loads++; };
    el.connectedCallback();
    assertEquals(loads, 0, "connect must not enumerate devices synchronously");
    assert(scheduled, "the enumeration is scheduled for idle");
    assertEquals(typeof scheduled.cb, "function");
    scheduled.cb(); // idle arrives
    assertEquals(loads, 1, "the idle callback performs the deferred enumeration");
    el.disconnectedCallback();
  } finally {
    if (prevRic === undefined) delete globalThis.requestIdleCallback;
    else globalThis.requestIdleCallback = prevRic;
  }
});

Deno.test("mic state (fbg7i): the hide-observer walks the COMPOSED chain — across the shadow host to the body — and covers a self-hide", () => {
  // The gallery's <prompt-bar> renders its mic inside a shadow root. An
  // ancestor walk on parentElement alone stops at the shadow boundary, so
  // the body's view-switch class goes unobserved and a recording mic stays
  // live while its composer is display:none (round-3 review, blocking).
  const observed = [];
  let mutCallback = null;
  const PrevMO = globalThis.MutationObserver;
  globalThis.MutationObserver = class {
    constructor(cb) { mutCallback = cb; }
    observe(target) { observed.push(target); }
    disconnect() {}
  };
  try {
    const el = new MicButton();
    const events = [];
    el._emit = (type, detail) => events.push({ type, detail });
    // Composed parentage: mic → wrapper (shadow child) → [shadow root] → host → body.
    const body = { parentElement: null, getRootNode() { return {}; } };
    const host = { parentElement: body, getRootNode() { return {}; } };
    const shadowRoot = { host };
    const wrapper = { parentElement: null, getRootNode() { return shadowRoot; } };
    el.parentElement = wrapper;
    el.getRootNode = () => shadowRoot;
    el.connectedCallback();
    assert(observed.includes(el), "the element itself is observed (a self-hide must stop the recording)");
    assert(observed.includes(wrapper), "the in-shadow ancestor is observed");
    assert(observed.includes(host), "the walk crosses the shadow host");
    assert(observed.includes(body), "the walk reaches the body — the view switch is observed");

    // The hidden-recording path: a view-switch mutation fires while recording.
    el._listening = true;
    el._button = { offsetParent: null }; // the switch display:none'd the composer
    mutCallback();
    assertEquals(el._listening, false, "a hidden composer stops the recording through the shadow boundary");
    assert(
      events.some((e) => e.type === "mic-error" && /hidden/.test(e.detail?.message ?? "")),
      "the stop is reported as the hidden-composer stop",
    );
    el.disconnectedCallback();
  } finally {
    globalThis.MutationObserver = PrevMO;
  }
});

Deno.test("mic state (fbg7i): a click that beats the idle enumeration waits for it — the meter opens the settled selection, never a default-input stream the late resolution discards", async () => {
  // Round-3 review: with enumeration deferred to idle, a quick click read a
  // null _selectedDeviceId (metering the DEFAULT input) and the late
  // resolution then failed _adoptMeterStream's deviceId check, discarding
  // the pending stream. start() must await the in-flight enumeration.
  const enumGate = deferred();
  const gumCalls = [];
  const stream = fakeStream();
  Object.defineProperty(globalThis, "navigator", {
    value: {
      mediaDevices: {
        enumerateDevices: () => enumGate.promise,
        getUserMedia: (constraints) => { gumCalls.push(constraints); return Promise.resolve(stream); },
        addEventListener() {},
      },
    },
    configurable: true, writable: true,
  });
  globalThis.chrome = { storage: { local: { get: async () => ({}), set: async () => {} } } };
  installFakeSR();
  window.AudioContext = class {
    constructor() { this.state = "running"; }
    createAnalyser() { return { fftSize: 0, connect() {}, getByteTimeDomainData() {} }; }
    createMediaStreamSource() { return { connect() {} }; }
    close() { return Promise.resolve(); }
  };
  let scheduled = null;
  const prevRic = globalThis.requestIdleCallback;
  globalThis.requestIdleCallback = (cb) => { scheduled = cb; return 1; };
  try {
    const { el } = makeMic();
    el.connectedCallback();
    assert(scheduled, "enumeration is still idle-scheduled at connect");

    // The click lands BEFORE idle fires and before enumeration resolves.
    const startP = el.start();
    await tick();
    assertEquals(gumCalls.length, 0, "the meter request waits for the enumeration");

    enumGate.resolve([
      { deviceId: "mic-a", kind: "audioinput", groupId: "ga", label: "Mic A" },
      { deviceId: "mic-b", kind: "audioinput", groupId: "gb", label: "Mic B" },
      { deviceId: "default", kind: "audioinput", groupId: "ga" },
    ]);
    await startP;
    await tick(); await tick();
    assertEquals(gumCalls.length, 1, "exactly one meter request");
    assertEquals(
      gumCalls[0]?.audio?.deviceId?.exact, "mic-a",
      "the meter opens the settled selection (the OS default's matching concrete mic), not the default input",
    );
    assertEquals(stream.tracks[0].stopped, 0, "the pending stream is adopted, never discarded by the late resolution");
    assertEquals(el._listening, true, "recording is live after the wait");
    el.stop();
    el.disconnectedCallback();
  } finally {
    if (prevRic === undefined) delete globalThis.requestIdleCallback;
    else globalThis.requestIdleCallback = prevRic;
    delete globalThis.chrome;
    delete window.AudioContext;
    Object.defineProperty(globalThis, "navigator", { value: { mediaDevices: null }, configurable: true, writable: true });
  }
});
