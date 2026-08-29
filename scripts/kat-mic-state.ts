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

import { launchChrome } from "./lib/chrome-launch.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? "/tmp/cap-mic-state-kats";
const CHROMIUM = "/usr/bin/chromium";

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
    `--user-data-dir=${ROOT}.cache/kat-mic-state-${Date.now()}`, "about:blank"],
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

const { result: { targetInfos } } = await send("Target.getTargets");
const sw = targetInfos.find((t: any) => t.type === "service_worker");
if (!sw) { console.log("FAIL: no service worker target"); Deno.exit(1); }
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

// 16 ─ a second click while pending supersedes the first start (double-click)
await evalJs(clickMic); await sleep(150);
await evalJs(clickMic); await sleep(150);
const dbl = await evalJs(`(async () => {
  const s1 = await window.__origGum({ audio: true });
  const s2 = await window.__origGum({ audio: true });
  const c1 = s1.clone(); const c2 = s2.clone();
  window.__pending.shift()(c1);
  await new Promise((r) => setTimeout(r, 200));
  window.__pending.shift()(c2);
  await new Promise((r) => setTimeout(r, 500));
  const host = document.querySelector("#composer mic-button");
  const res = {
    c1State: c1.getTracks()[0].readyState,
    c2State: c2.getTracks()[0].readyState,
    listening: host._listening,
    hostAttr: host.hasAttribute("listening"),
  };
  s1.getTracks().forEach((t) => t.stop()); s2.getTracks().forEach((t) => t.stop());
  return res;
})()`);
check("double-click pending: the superseded first stream is STOPPED (never orphaned), the second start wins",
  dbl.c1State === "ended" && dbl.listening === true && dbl.hostAttr === true, dbl);
check("double-click pending: the winning stream stays live", dbl.c2State === "live", dbl);
await evalJs(`(() => { navigator.mediaDevices.getUserMedia = window.__origGum; document.querySelector("#composer mic-button").stop(); return true; })()`);
await sleep(400);
await shot("09-after-pending-cancels");

console.log(`${pass} passed, ${fail} failed`);
proc.kill();
Deno.exit(fail ? 1 : 0);
