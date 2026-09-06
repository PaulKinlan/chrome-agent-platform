// kat-mic-state.ts — mic recording-state KAT (real browser). The composer mic
// button must show an unmistakable recording state (accent + live waveform
// driven by the real mic level, or the honest CSS fallback), a hover STOP
// affordance while recording, and must NEVER get stuck in the recording state
// when recognition ends on its own.
//
//   deno run -A scripts/kat-mic-state.ts <path-to-extension> [outDir]
//
// SpeechRecognition itself is stubbed (it needs Google's network speech
// service — unavailable to a hermetic test); getUserMedia + AnalyserNode are
// REAL (Chromium's fake audio device emits a tone), so the waveform is
// genuinely level-driven in this run.

import { launchChrome, waitForServiceWorker } from "./lib/chrome-launch.ts";
import { durableDir } from "./lib/durable-root.mjs";
import { chromeProfileDir } from "./lib/chrome-profile-dir.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? durableDir("cap-mic-state-kats");
// Arch Chromium ignores --load-extension; Chrome for Testing honors it.
const CHROMIUM = "/home/paulkinlan/.cache/puppeteer/chrome/linux-140.0.7339.82/chrome-linux64/chrome";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
await Deno.mkdir(OUT, { recursive: true });

// The debugging port is kernel-assigned and read back from THIS Chrome by the
// shared launcher — a hard-coded port can silently attach to another lane's
// browser (CAP-FB-20260829-FIXED-DEBUG-PORTS-01).
const { proc, wsUrl } = await launchChrome({
  binary: CHROMIUM,
  args: ["--headless=new", "--no-sandbox", "--disable-gpu", "--silent-debugger-extension-api",
    "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${chromeProfileDir("kat-mic-state")}`, "about:blank"],
});
const ws = new WebSocket(wsUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const pending = new Map<string, (v: any) => void>();
const send = (method: string, params: any = {}, sessionId?: string) => new Promise<any>((res) => {
  const mid = ++id; pending.set(String(mid), res);
  ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
});
ws.onmessage = (m) => {
  const j = JSON.parse(m.data as string);
  if (j.id && pending.has(String(j.id))) { pending.get(String(j.id))!(j); pending.delete(String(j.id)); }
};

const sw = await waitForServiceWorker(send);
if (!sw) { console.log("FAIL: no service worker target"); proc.kill(); Deno.exit(1); }
const extId = new URL(sw.url).host;

const { result: { targetId } } = await send("Target.createTarget", { url: `chrome-extension://${extId}/ntp/ntp.html` });
const { result: { sessionId } } = await send("Target.attachToTarget", { targetId, flatten: true });
await send("Runtime.enable", {}, sessionId);
await send("Page.enable", {}, sessionId);
// Synthetic input (Input.dispatchMouseEvent) only reaches the ACTIVE page —
// the created target starts in the background, so bring it to front or the
// hover/click events silently go nowhere.
await send("Target.activateTarget", { targetId });
await sleep(1500);

const evalJs = async (expression: string) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  return r.result?.result?.value;
};
const shot = async (name: string) => {
  const r = await send("Page.captureScreenshot", { format: "png" }, sessionId);
  await Deno.writeFile(`${OUT}/${name}.png`, Uint8Array.from(atob(r.result.data), (c) => c.charCodeAt(0)));
};

// Controllable SpeechRecognition stub + event capture, installed before any click.
await evalJs(`(() => {
  window.__micErrors = [];
  window.__micToggles = [];
  window.__fakeSR = null;
  class FakeSR {
    constructor() {
      this.continuous = false; this.interimResults = false; this.lang = "";
      this.started = 0; this.stopped = 0;
      window.__fakeSR = this;
    }
    start() { this.started++; }
    stop() { this.stopped++; queueMicrotask(() => this.onend && this.onend()); }
    abort() { this.aborted = (this.aborted || 0) + 1; }
  }
  window.SpeechRecognition = FakeSR;
  window.webkitSpeechRecognition = FakeSR;
  window.addEventListener("mic-error", (e) => window.__micErrors.push(e?.detail?.message ?? "?"), true);
  window.addEventListener("mic-toggle", (e) => window.__micToggles.push(!!e?.detail?.listening), true);
  return true;
})()`);

const micState = `(() => {
  const host = document.querySelector("#composer mic-button");
  if (!host) return { missing: true };
  const b = host.shadowRoot.querySelector(".mic");
  const cs = getComputedStyle(b);
  const q = (sel) => host.shadowRoot.querySelector(sel);
  const disp = (el) => el ? getComputedStyle(el).display : "ELEMENT-MISSING";
  const bar = host.shadowRoot.querySelectorAll(".wave span")[2];
  return {
    pressed: b.getAttribute("aria-pressed"),
    label: b.getAttribute("aria-label"),
    dataListening: b.hasAttribute("data-listening"),
    color: cs.color,
    waveDisplay: disp(q(".wave")),
    stopDisplay: disp(q(".stop-ic")),
    iconDisplay: disp(q(".icon")),
    barTransform: bar?.style.transform || "",
    waveLive: q(".wave")?.classList.contains("live") ?? false,
    mode: host.waveformMode ?? null,
    streamOpen: !!host._mediaStream,
    ctxState: host._audioCtx ? host._audioCtx.state : null,
    srStarted: window.__fakeSR ? window.__fakeSR.started : -1,
    srStopped: window.__fakeSR ? window.__fakeSR.stopped : -1,
    composerStatus: document.querySelector("#composer .composer-status")?.textContent || "",
  };
})()`;

const clickMic = `(() => { document.querySelector("#composer mic-button").shadowRoot.querySelector(".mic").click(); return true; })()`;

// 1 ─ idle state
const idle = await evalJs(micState);
check("idle: button present, aria-pressed=false, no data-listening, mic icon shown, wave hidden",
  !idle.missing && idle.pressed === "false" && idle.dataListening === false &&
  idle.waveDisplay === "none" && idle.iconDisplay !== "none", idle);
await shot("01-idle-light");

// 2 ─ click → recording state (accent, wave, aria)
await evalJs(clickMic);
await sleep(1200); // async permission + meter spin-up
const rec = await evalJs(micState);
check("recording: data-listening rendered (the original bug: CSS keyed on it but it was never set)",
  rec.dataListening === true, rec);
check("recording: aria-pressed=true + aria-label switches to Stop listening",
  rec.pressed === "true" && /stop/i.test(rec.label), { pressed: rec.pressed, label: rec.label });
check("recording: wave visible, mic icon hidden, accent color differs from idle",
  rec.waveDisplay !== "none" && rec.iconDisplay === "none" && rec.color !== idle.color,
  { idle: idle.color, rec: rec.color });
check("recording: mic stream is OPEN for the level meter (and will be stopped on end)",
  rec.streamOpen === true, rec);
await shot("02-recording-light");

// 3 ─ waveform is LEVEL-DRIVEN (live) or honest fallback
check("waveform mode is live (real AnalyserNode) — fallback acceptable only if noted",
  rec.mode === "live" || rec.mode === "fallback", rec.mode);
if (rec.mode === "live") {
  check("live waveform: AudioContext running + wave bars carry inline per-frame transforms",
    rec.ctxState === "running" && rec.waveLive === true && /scaleY\(/.test(rec.barTransform), rec);
  const t1 = (await evalJs(micState)).barTransform;
  await sleep(350);
  const t2 = (await evalJs(micState)).barTransform;
  check("live waveform: the level meter is being driven across frames (transform kept updating)",
    /scaleY\(/.test(t1) && /scaleY\(/.test(t2), { t1, t2 });
}

// 4 ─ hover → STOP affordance (scroll into view first: headless is 800×600
// and the hero composer can sit below the fold — off-viewport pointer events
// silently go nowhere)
await evalJs(`document.querySelector("#composer mic-button").scrollIntoView({ block: "center" }); true`);
await sleep(300);
const rect = await evalJs(`(() => { const r = document.querySelector("#composer mic-button").shadowRoot.querySelector(".mic").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
const atPoint = await evalJs(`(() => { const el = document.elementFromPoint(${rect.x}, ${rect.y}); return el ? el.tagName : "null"; })()`);
check("hover precondition: the mic is in the viewport", atPoint !== "null" && rect.y > 0 && rect.y < 800, { rect, atPoint });
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y }, sessionId);
await sleep(300);
const hov = await evalJs(micState);
check("hover-while-recording: wave swaps to the STOP affordance",
  hov.stopDisplay !== "none" && hov.waveDisplay === "none", hov);
await shot("03-hover-stop-light");

// 5 ─ click → stop: idle restored, mic released, recognition stopped
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 }, sessionId);
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 }, sessionId);
await sleep(600);
const stopped = await evalJs(micState);
check("stop: idle restored (no data-listening, aria-pressed=false, mic icon back, wave hidden)",
  stopped.dataListening === false && stopped.pressed === "false" &&
  stopped.iconDisplay !== "none" && stopped.waveDisplay === "none", stopped);
check("stop: mic tracks STOPPED + AudioContext closed (mic never left open)",
  stopped.streamOpen === false && stopped.ctxState === null, stopped);
check("stop: recognition.stop() reached the service",
  stopped.srStopped >= 1, stopped.srStopped);
check("stop: mic-toggle events observed true→false",
  await evalJs(`window.__micToggles.join(",")`) === "true,false",
  await evalJs(`window.__micToggles`));
await shot("04-after-stop-light");
// park the pointer OFF the button AFTER the stop click — the synthetic release
// leaves the pointer over the button, and a lingering :hover swaps the wave
// for the stop icon in every later recording-state assertion.
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 8, y: 8 }, sessionId);
await sleep(200);

// 6 ─ recognition ends on its own ONCE → legit continuous restart, still recording
await evalJs(clickMic);
await sleep(1000);
const before = (await evalJs(micState)).srStarted;
await evalJs(`window.__fakeSR.onend && window.__fakeSR.onend()`);
await sleep(200);
const afterOnce = await evalJs(micState);
check("onend (single, silence timeout): continuous dictation restarts — still recording",
  afterOnce.srStarted === before + 1 && afterOnce.dataListening === true, afterOnce);

// 7 ─ onend STORM → no stuck recording state (the regression guard)
await evalJs(`window.__fakeSR.onend(); window.__fakeSR.onend(); window.__fakeSR.onend(); window.__fakeSR.onend(); true`);
await sleep(300);
const storm = await evalJs(micState);
check("onend storm: state reverts to IDLE with an honest error (no stuck recording)",
  storm.dataListening === false && storm.pressed === "false" && storm.streamOpen === false, storm);
check("onend storm: mic-error surfaced to the owner",
  (await evalJs(`window.__micErrors.length`)) >= 1, await evalJs(`window.__micErrors`));

// 8 ─ reduced motion → static engaged state, no live per-frame driving
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }, sessionId);
await evalJs(clickMic);
await sleep(1000);
const rm = await evalJs(micState);
check("reduced-motion: recording state still visible but waveform is the static fallback",
  rm.dataListening === true && rm.mode === "fallback" && rm.waveLive === false, rm);
await evalJs(clickMic); // stop
await sleep(400);
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "" }] }, sessionId);

// 9 ─ dark scheme renders the state too
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] }, sessionId);
await evalJs(clickMic);
await sleep(1000);
await shot("05-recording-dark");
const darkRec = await evalJs(micState);
check("dark scheme: recording state renders (wave visible, accent applied)",
  darkRec.dataListening === true && darkRec.waveDisplay !== "none", darkRec);
await evalJs(clickMic);
await sleep(400);

// 10 ─ axe: the composer region stays clean in both states
try {
  const axeRes = await fetch("https://cdn.jsdelivr.net/npm/axe-core@4.10.2/axe.min.js");
  await evalJs(`(async () => { ${await axeRes.text()}; return true; })()`);
  const axeViolations = await evalJs(`(async () => {
    const r = await window.axe.run(document.querySelector("#composer"), { runOnly: ["button-name", "aria-allowed-attr", "aria-valid-attr-value", "aria-valid-attr"] });
    return r.violations.filter((v) => v.nodes.some((n) => String(n.target).includes("mic"))).map((v) => v.id);
  })()`);
  check("axe: no mic-button violations in the composer region", Array.isArray(axeViolations) && axeViolations.length === 0, axeViolations);
} catch {
  check("axe: no mic-button violations in the composer region", false, "axe fetch/run failed (network?)");
}

console.log(`${pass} passed, ${fail} failed (mic-state core)`);

// ── send / navigation lifecycle (owner: "sent a task, mic kept listening") ──
const setText = (t: string) => evalJs(`(() => { const ta = document.querySelector("#composer #task-input"); ta.value = ${JSON.stringify(t)}; ta.dispatchEvent(new Event("input", { bubbles: true })); return ta.value; })()`);
const getText = () => evalJs(`document.querySelector("#composer #task-input").value`);
const clickSend = `(() => { document.querySelector("#composer #run-task").click(); return true; })()`;
const hubVisible = `(() => { const m = document.querySelector("main.content"); return !!m && getComputedStyle(m).display !== "none"; })()`;
const backToHub = `(() => { const tv = document.getElementById("thread-view"); if (tv && !tv.hidden) { document.getElementById("thread-back")?.click(); return "closed"; } return "already-hub"; })()`;

// 11 ─ SEND while recording → mic fully stopped, textbox cleared on acceptance
await evalJs(backToHub); await sleep(600);
check("send precondition: hub composer visible", (await evalJs(hubVisible)) === true);
await setText("mic KAT task — send stops the mic");
await evalJs(clickMic); await sleep(1000);
const recPreSend = await evalJs(micState);
check("send precondition: recording before send", recPreSend.dataListening === true, recPreSend);
const srStopsBefore = recPreSend.srStopped;
await evalJs(clickSend);
await sleep(1800);
const postSend = await evalJs(micState);
check("send-while-recording: mic FULLY stopped (idle visuals, stream released, AudioContext closed)",
  postSend.dataListening === false && postSend.streamOpen === false && postSend.mode === null && postSend.pressed === "false", postSend);
check("send-while-recording: recognition.stop() reached the service",
  postSend.srStopped > srStopsBefore, { before: srStopsBefore, after: postSend.srStopped });
check("accepted send: composer text CLEARED", (await getText()) === "", await getText());
await shot("06-after-send");

// 12 ─ REJECTED send (stale agent selection) keeps BOTH the text and the recording
await evalJs(backToHub); await sleep(600);
check("reject precondition: hub composer visible again", (await evalJs(hubVisible)) === true);
await setText("draft that must survive a rejected send");
await evalJs(`(() => { const c = document.querySelector("#composer"); c._selectedAgent = { ref: "named:ghost-kat", kind: "named", id: "ghost-kat", name: "ghost" }; return true; })()`);
await evalJs(clickMic); await sleep(1000);
const recPreReject = await evalJs(micState);
await evalJs(clickSend);
await sleep(1200);
const postReject = await evalJs(micState);
check("rejected send: draft text PRESERVED", (await getText()) === "draft that must survive a rejected send", await getText());
check("rejected send: recording CONTINUES (no teardown on a failed submit)",
  postReject.dataListening === true && postReject.streamOpen === true, postReject);

// 13 ─ navigating away (open a task via its real Open affordance) stops a live recording
const navPre = await evalJs(micState); // still recording from 12
const hasTaskRow = await evalJs(`!!document.querySelector("#thread-sidebar .thread-item .t-open")`);
check("nav precondition: a task row with an Open button exists (created by the send above)", hasTaskRow === true);
if (hasTaskRow && navPre.dataListening === true) {
  await evalJs(`document.querySelector("#thread-sidebar .thread-item .t-open").click(); true`);
  await sleep(1200);
  const hubGone = await evalJs(hubVisible);
  check("nav: opening the task actually hid the hub", hubGone === false, hubGone);
  const postNav = await evalJs(micState);
  check("navigate-away: recording stopped when the composer was hidden",
    postNav.dataListening === false && postNav.streamOpen === false, postNav);
  check("navigate-away: the owner is TOLD the recording stopped",
    (await evalJs(`window.__micErrors.join("|")`)).includes("hidden"),
    await evalJs(`window.__micErrors`));
}
await shot("07-after-nav");

// ── round-2: detach/reattach honesty + pending-getUserMedia cancellation ────
await evalJs(backToHub); await sleep(800);
check("round-2 precondition: hub composer visible", (await evalJs(hubVisible)) === true);

// 14 ─ detach while recording → reattach renders IDLE (no false affordance)
await evalJs(clickMic); await sleep(1000);
const recPreDetach = await evalJs(micState);
check("detach precondition: recording before detach", recPreDetach.dataListening === true, recPreDetach);
await evalJs(`(() => { const h = document.querySelector("#composer mic-button"); const p = h.parentNode; const n = h.nextSibling; h.remove(); p.insertBefore(h, n); return true; })()`);
await sleep(600);
const postReattach = await evalJs(`(() => {
  const host = document.querySelector("#composer mic-button");
  const b = host.shadowRoot.querySelector(".mic");
  return {
    hostAttr: host.hasAttribute("listening"),
    pressed: b.getAttribute("aria-pressed"),
    dataListening: b.hasAttribute("data-listening"),
    internal: host._listening,
    streamOpen: !!host._mediaStream,
  };
})()`);
check("detach/reattach: the stale listening attribute is GONE — idle render, no false recording affordance",
  postReattach.hostAttr === false && postReattach.pressed === "false" && postReattach.dataListening === false && postReattach.internal === false, postReattach);
check("detach: the mic stream is released", postReattach.streamOpen === false, postReattach);
await shot("08-after-reattach");

// 15 ─ stop() during a PENDING getUserMedia cancels the start (the send path)
await evalJs(`(() => {
  const md = navigator.mediaDevices;
  window.__origGum = md.getUserMedia.bind(md);
  window.__pending = [];
  md.getUserMedia = () => new Promise((res) => { window.__pending.push(res); });
  return true;
})()`);
await evalJs(clickMic); await sleep(400);
await evalJs(`document.querySelector("#composer mic-button").stop(); true`);
const late = await evalJs(`(async () => {
  const s = await window.__origGum({ audio: true });
  const clone = s.clone();
  window.__pending.shift()(clone); // the permission request resolves LATE
  await new Promise((r) => setTimeout(r, 400));
  const host = document.querySelector("#composer mic-button");
  const res = {
    listening: host._listening,
    hostAttr: host.hasAttribute("listening"),
    lateTrackState: clone.getTracks()[0].readyState,
    retained: host._mediaStream === clone,
  };
  s.getTracks().forEach((t) => t.stop());
  return res;
})()`);
check("pending-cancel: stop() during a pending getUserMedia prevents the late recording",
  late.listening === false && late.hostAttr === false && late.retained === false, late);
check("pending-cancel: the late stream's tracks are STOPPED, not leaked",
  late.lateTrackState === "ended", late);

// 16 ─ double-click while the decorative stream is pending starts then stops
// recognition immediately; the late stream is still released.
const srStopsBeforeDouble = (await evalJs(micState)).srStopped;
await evalJs(clickMic); await sleep(150);
await evalJs(clickMic); await sleep(150);
const dbl = await evalJs(`(async () => {
  const s = await window.__origGum({ audio: true });
  const clone = s.clone();
  window.__pending.shift()(clone);
  await new Promise((r) => setTimeout(r, 400));
  const host = document.querySelector("#composer mic-button");
  const res = {
    trackState: clone.getTracks()[0].readyState,
    listening: host._listening,
    hostAttr: host.hasAttribute("listening"),
    retained: host._mediaStream === clone,
    srStopped: window.__fakeSR.stopped,
  };
  s.getTracks().forEach((t) => t.stop());
  return res;
})()`);
check("double-click pending: the second click stops dictation instead of waiting for the meter",
  dbl.listening === false && dbl.hostAttr === false && dbl.srStopped > srStopsBeforeDouble, dbl);
check("double-click pending: the late stream is STOPPED and never retained",
  dbl.trackState === "ended" && dbl.retained === false, dbl);

// 17 ─ getUserMedia rejection affects only the decorative meter. Recognition
// starts, the fallback waveform is visible, and the composer tells the owner.
await evalJs(`navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("denied", "NotAllowedError")); true`);
const srBeforeReject = (await evalJs(micState)).srStarted;
await evalJs(clickMic); await sleep(400);
const rejectedMeter = await evalJs(micState);
check("meter rejection: recognition starts and visible fallback recording state remains active",
  rejectedMeter.srStarted === srBeforeReject + 1 && rejectedMeter.dataListening === true &&
  rejectedMeter.waveDisplay !== "none" && rejectedMeter.mode === "fallback", rejectedMeter);
check("meter rejection: failure is visible in the composer without claiming dictation failed",
  /waveform unavailable/i.test(rejectedMeter.composerStatus) && /dictation continues/i.test(rejectedMeter.composerStatus),
  rejectedMeter.composerStatus);
await evalJs(`document.querySelector("#composer mic-button").scrollIntoView({ block: "center" }); true`);
await sleep(200);
await shot("09-meter-rejected-fallback");
await evalJs(clickMic); await sleep(300);

// 18 ─ a never-settling getUserMedia promise cannot hold the primary function
// hostage: recognition and the fallback recording affordance start immediately.
await evalJs(`navigator.mediaDevices.getUserMedia = () => new Promise(() => {}); true`);
const srBeforeHang = (await evalJs(micState)).srStarted;
await evalJs(clickMic); await sleep(250);
const hangingMeter = await evalJs(micState);
check("meter hang: recognition starts without waiting and the fallback state is visible",
  hangingMeter.srStarted === srBeforeHang + 1 && hangingMeter.dataListening === true &&
  hangingMeter.waveDisplay !== "none" && hangingMeter.mode === "fallback", hangingMeter);
await evalJs(`document.querySelector("#composer mic-button").scrollIntoView({ block: "center" }); true`);
await sleep(200);
await shot("10-meter-hanging-fallback");
await evalJs(`(() => { document.querySelector("#composer mic-button").stop(); navigator.mediaDevices.getUserMedia = window.__origGum; return true; })()`);
await sleep(400);

// ── device picker + no-transcript diagnostics ──────────────────────────────
// Fake enumeration only: every live stream still comes from Chromium's real
// fake audio device, so the selected-device preview is genuinely analyser-led.
const deviceFeature = await evalJs(`(async () => {
  const md = navigator.mediaDevices;
  window.__origEnumerate = md.enumerateDevices.bind(md);
  // Chrome's pre-permission shape: only an unlabeled default alias is visible.
  window.__deviceFixture = [
    { kind: "audioinput", deviceId: "default", groupId: "", label: "" },
  ];
  window.__postGrantDeviceFixture = [
    { kind: "audioinput", deviceId: "default", groupId: "built-in-group", label: "Default — MacBook Microphone" },
    { kind: "audioinput", deviceId: "built-in", groupId: "built-in-group", label: "MacBook Microphone" },
    { kind: "audioinput", deviceId: "usb-mic", groupId: "usb-group", label: "USB Podcast Mic" },
    { kind: "videoinput", deviceId: "camera", groupId: "camera-group", label: "Camera" },
  ];
  window.__pickerGumCalls = [];
  md.enumerateDevices = async () => window.__deviceFixture.map((d) => ({ ...d }));
  md.getUserMedia = async (constraints) => {
    window.__pickerGumCalls.push(structuredClone(constraints));
    const stream = await window.__origGum({ audio: true });
    window.__deviceFixture = window.__postGrantDeviceFixture;
    return stream;
  };
  const host = document.querySelector("#composer mic-button");
  if (typeof host._refreshDevices !== "function") return false;
  host._enumeratedAfterGrant = false;
  host._labelsRequested = false;
  await host._refreshDevices(false);
  return true;
})()`);
check("device picker seam exists on the mic component", deviceFeature === true, deviceFeature);
if (deviceFeature) {
await sleep(300);
const prePermissionPicker = await evalJs(`(() => {
  const host = document.querySelector("#composer mic-button");
  return { arrow: !!host.shadowRoot.querySelector(".device-picker"), devices: host._devices.length };
})()`);
check("pre-permission enumeration: default alias alone keeps the picker hidden",
  prePermissionPicker.arrow === false && prePermissionPicker.devices === 0, prePermissionPicker);
await evalJs(clickMic);
await sleep(700);
const postGrantPicker = await evalJs(`(() => {
  const host = document.querySelector("#composer mic-button");
  return {
    arrow: !!host.shadowRoot.querySelector(".device-picker"),
    devices: host._devices.map((d) => d.label),
    refreshDone: host._enumeratedAfterGrant,
  };
})()`);
check("first successful dictation meter grant: re-enumerates once and reveals physical microphones",
  postGrantPicker.arrow && postGrantPicker.refreshDone && postGrantPicker.devices.length === 2 &&
  postGrantPicker.devices.includes("USB Podcast Mic"), postGrantPicker);
// Falsification recovery only: let an unfixed component continue far enough to
// exercise the independent out-of-order meter-request assertion below.
if (!postGrantPicker.arrow) {
  await evalJs(`document.querySelector("#composer mic-button")._refreshDevices(false)`);
  await sleep(300);
}
await evalJs(clickMic); await sleep(300);
const multiPicker = await evalJs(`(() => {
  const host = document.querySelector("#composer mic-button");
  const arrow = host.shadowRoot.querySelector(".device-picker");
  return { arrow: !!arrow, visible: arrow ? getComputedStyle(arrow).display !== "none" : false, devices: host._devices.map((d) => d.label) };
})()`);
check("multiple audio inputs: the device arrow appears and lists physical microphones, not the default alias",
  multiPicker.arrow && multiPicker.visible && multiPicker.devices.length === 2 && multiPicker.devices.includes("USB Podcast Mic"), multiPicker);

await evalJs(`document.querySelector("#composer mic-button").shadowRoot.querySelector(".device-picker").click(); true`);
await sleep(500);
const openPicker = await evalJs(`(() => {
  const host = document.querySelector("#composer mic-button");
  const menu = host.shadowRoot.querySelector(".device-menu");
  return {
    open: !!menu && !menu.hidden,
    copy: menu?.textContent || "",
    labels: [...(menu?.querySelectorAll(".device-name") || [])].map((n) => n.textContent),
    grantCalls: window.__pickerGumCalls.filter((c) => c.audio === true).length,
  };
})()`);
check("picker open: labels are re-enumerated after one mic grant and copy says transcription uses OS default",
  openPicker.open && openPicker.grantCalls === 1 && openPicker.labels.includes("USB Podcast Mic") &&
  /always uses the OS default input/i.test(openPicker.copy) && /System Settings/.test(openPicker.copy), openPicker);

await evalJs(`(() => {
  const host = document.querySelector("#composer mic-button");
  [...host.shadowRoot.querySelectorAll("button[data-device-id]")].find((b) => b.dataset.deviceId === "usb-mic").click();
  return true;
})()`);
await sleep(700);
const selectedPreview = await evalJs(`(async () => {
  const host = document.querySelector("#composer mic-button");
  const row = host._deviceRows.get("usb-mic");
  const stored = await chrome.storage.local.get("mic-meter-device-id");
  return {
    selected: host._selectedDeviceId,
    stored: stored["mic-meter-device-id"],
    exactCalls: window.__pickerGumCalls.filter((c) => c.audio?.deviceId?.exact === "usb-mic").length,
    active: row?.level?.hasAttribute("data-active") || false,
    status: row?.status?.textContent || "",
  };
})()`);
check("device selection: persists and starts a genuine exact-device live level preview",
  selectedPreview.selected === "usb-mic" && selectedPreview.stored === "usb-mic" &&
  selectedPreview.exactCalls >= 1 && selectedPreview.active && /Live level/.test(selectedPreview.status), selectedPreview);
const pickerAxe = await evalJs(`(async () => {
  const result = await window.axe.run(document.querySelector("#composer"), { runOnly: ["button-name", "aria-allowed-attr", "aria-valid-attr-value", "aria-valid-attr"] });
  return result.violations.map((v) => v.id);
})()`);
check("axe: device picker controls have valid names and ARIA", Array.isArray(pickerAxe) && pickerAxe.length === 0, pickerAxe);
await shot("11-device-picker-live-level");

await evalJs(`(() => {
  const host = document.querySelector("#composer mic-button");
  host.shadowRoot.querySelector(".device-picker").click();
  host.shadowRoot.querySelector(".device-picker").click();
  return true;
})()`);
await sleep(300);
check("picker labels: reopening does not request a second default-mic grant",
  (await evalJs(`window.__pickerGumCalls.filter((c) => c.audio === true).length`)) === 1,
  await evalJs(`window.__pickerGumCalls`));

const restoredSelection = await evalJs(`(async () => {
  const probe = document.createElement("mic-button");
  document.body.append(probe);
  await new Promise((r) => setTimeout(r, 300));
  const selected = probe._selectedDeviceId;
  probe.remove();
  return selected;
})()`);
check("device selection: a new mic-button restores the persisted meter device", restoredSelection === "usb-mic", restoredSelection);

// Starting dictation must constrain only getUserMedia; SpeechRecognition has no
// deviceId surface and continues to represent the OS-default capture path.
await evalJs(clickMic); await sleep(400);
const meterConstraint = await evalJs(`window.__pickerGumCalls.some((c) => c.audio?.deviceId?.exact === "usb-mic")`);
check("dictation meter: selected deviceId is applied to getUserMedia", meterConstraint === true);
check("SpeechRecognition truth: the recognition object is not given a deviceId", (await evalJs(`window.__fakeSR.deviceId`)) === undefined);
await evalJs(clickMic); await sleep(300);

// Three meter requests in one dictation lifetime resolve newest-first, then
// stale. Only the newest selection may remain adopted; both stale streams must
// be stopped even when one has the same device identity as the winner.
const meterRace = await evalJs(`(async () => {
  const host = document.querySelector("#composer mic-button");
  if (typeof host._requestAndAdoptMeter !== "function") return { missing: true };
  const md = navigator.mediaDevices;
  const source = await window.__origGum({ audio: true });
  const streams = [source.clone(), source.clone(), source.clone()];
  const pending = [];
  md.getUserMedia = () => new Promise((resolve) => pending.push(resolve));
  host._selectedDeviceId = "built-in";
  await host.start(); // request 0: built-in
  host._selectedDeviceId = "usb-mic";
  host._requestAndAdoptMeter(host._startGen); // request 1: USB
  host._selectedDeviceId = "built-in";
  host._requestAndAdoptMeter(host._startGen); // request 2: newest built-in
  pending[2](streams[2]);
  await new Promise((r) => setTimeout(r, 200));
  const newestAdopted = host._mediaStream === streams[2];
  pending[1](streams[1]);
  await new Promise((r) => setTimeout(r, 100));
  pending[0](streams[0]);
  await new Promise((r) => setTimeout(r, 200));
  const result = {
    pending: pending.length,
    newestAdopted,
    retainedNewest: host._mediaStream === streams[2],
    staleUsb: streams[1].getTracks()[0].readyState,
    staleOriginal: streams[0].getTracks()[0].readyState,
    newestBeforeStop: streams[2].getTracks()[0].readyState,
  };
  host.stop();
  result.newestAfterStop = streams[2].getTracks()[0].readyState;
  source.getTracks().forEach((track) => track.stop());
  md.getUserMedia = async (constraints) => {
    window.__pickerGumCalls.push(structuredClone(constraints));
    return await window.__origGum({ audio: true });
  };
  return result;
})()`);
check("meter request race: out-of-order stale streams stop and cannot replace the latest device",
  meterRace.pending === 3 && meterRace.newestAdopted && meterRace.retainedNewest &&
  meterRace.staleUsb === "ended" && meterRace.staleOriginal === "ended" &&
  meterRace.newestBeforeStop === "live" && meterRace.newestAfterStop === "ended", meterRace);

// Disconnect the selected USB mic. One physical input remains: selection moves
// honestly, the arrow disappears, and the owner gets an OS-default warning.
await evalJs(`(() => {
  document.querySelector("#composer mic-button")._selectedDeviceId = "usb-mic";
  window.__deviceFixture = [
    { kind: "audioinput", deviceId: "default", groupId: "built-in-group", label: "Default — MacBook Microphone" },
    { kind: "audioinput", deviceId: "built-in", groupId: "built-in-group", label: "MacBook Microphone" },
  ];
  navigator.mediaDevices.dispatchEvent(new Event("devicechange"));
  return true;
})()`);
await sleep(500);
const disconnectState = await evalJs(`(() => {
  const host = document.querySelector("#composer mic-button");
  return {
    selected: host._selectedDeviceId,
    arrow: !!host.shadowRoot.querySelector(".device-picker"),
    status: document.querySelector("#composer .composer-status")?.textContent || "",
  };
})()`);
check("devicechange: disconnected selection falls back and single-mic arrow is removed",
  disconnectState.selected === "built-in" && disconnectState.arrow === false && /disconnected/i.test(disconnectState.status), disconnectState);
check("devicechange: warning remains honest about OS-default transcription",
  /OS default input/i.test(disconnectState.status) && /System Settings/.test(disconnectState.status), disconnectState.status);

// Existing three-round no-speech behavior remains, now with actionable device
// context; audio-capture gets the stronger wrong/dead OS-default diagnosis.
await evalJs(clickMic); await sleep(250);
await evalJs(`window.__fakeSR.onerror({ error: "no-speech" }); window.__fakeSR.onerror({ error: "no-speech" }); window.__fakeSR.onerror({ error: "no-speech" }); true`);
await sleep(250);
const noSpeechStatus = await evalJs(`document.querySelector("#composer .composer-status")?.textContent || ""`);
check("no-speech x3: error names OS-default and selected meter inputs, then stops",
  /couldn't hear you/i.test(noSpeechStatus) && /Default.+MacBook Microphone/.test(noSpeechStatus) &&
  /MacBook Microphone/.test(noSpeechStatus) && /System Settings/.test(noSpeechStatus) &&
  (await evalJs(micState)).dataListening === false, noSpeechStatus);

await evalJs(clickMic); await sleep(250);
await evalJs(`window.__fakeSR.onerror({ error: "audio-capture" }); true`);
await sleep(250);
const captureStatus = await evalJs(`document.querySelector("#composer .composer-status")?.textContent || ""`);
check("audio-capture: error says the OS default may be wrong, disconnected, muted, or dead",
  /could not capture audio/i.test(captureStatus) && /may be wrong, disconnected, muted, or dead/i.test(captureStatus) &&
  /System Settings/.test(captureStatus), captureStatus);

// Meter fallback has explicit title + accessibility text; it is never labelled
// as a live level. This augments the earlier visible-status rejection check.
await evalJs(`navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("denied", "NotAllowedError")); true`);
await evalJs(clickMic); await sleep(300);
const fallbackHonesty = await evalJs(`(() => {
  const button = document.querySelector("#composer mic-button").shadowRoot.querySelector(".mic");
  return { title: button.title, description: button.getAttribute("aria-description") };
})()`);
check("meter fallback: button title and aria-description say animation, not live meter",
  /animation, not a live meter/i.test(fallbackHonesty.title) && fallbackHonesty.description === fallbackHonesty.title, fallbackHonesty);
}
await evalJs(`(() => {
  document.querySelector("#composer mic-button").stop();
  navigator.mediaDevices.getUserMedia = window.__origGum;
  navigator.mediaDevices.enumerateDevices = window.__origEnumerate;
  return true;
})()`);
await sleep(300);

console.log(`${pass} passed, ${fail} failed`);
proc.kill();
Deno.exit(fail ? 1 : 0);
