// kat-task-view-simplify.ts — live-browser KAT for the task-view
// simplification (owner directive 2026-08-28: the durable run registry must
// NOT be a visible panel; the conversation IS the status surface; the
// registry becomes a small top-right debug affordance; tasks keep running in
// the background and re-opening a task shows what happened while away).
//
// Round-2 additions (review findings):
//  - the toggle must anchor to the inline-end of the view head (LTR and RTL),
//  - the hover-revealed panel must be TRAVERSABLE unpinned (cancellable close
//    delay bridges the toggle→panel gap),
//  - page evaluation exceptions are surfaced as failures (CDP exceptionDetails
//    are never discarded), and prerequisite interactions are guarded, so a
//    base-tree run reports honest RED checks instead of silently continuing.
//
// Headless honesty note: headless Chromium has no pointer device, so
// matchMedia("(pointer: fine)") is false by default. The KAT installs a
// matchMedia stub via Page.addScriptToEvaluateOnNewDocument to simulate a
// fine-pointer environment (and a coarse-pointer one for the no-hover
// scenario); the wiring, geometry and timing under test are still the real
// page code driven by real CDP input events.
//
// Falsification: run against the pre-change tree (base 550a9c8b) — the
// registry-in-flow, toggle, geometry and hover checks go RED there. The exact
// base output is recorded in the round-2 commit message.
//
//   deno run -A scripts/kat-task-view-simplify.ts <path-to-extension> [<out-dir>]

import { launchChrome } from "./lib/chrome-launch.ts";
import { chromeProfileDir } from "./lib/chrome-profile-dir.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? `${ROOT}.cache/kat-task-view-simplify`;
const CHROMIUM = "/usr/bin/chromium";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`); }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
await Deno.mkdir(OUT, { recursive: true });

// Kernel-assigned debugging port, read back from THIS Chrome by the shared
// launcher — a named port can silently attach to another lane's browser
// (CAP-FB-20260829-FIXED-DEBUG-PORTS-01).
const { proc, wsUrl, port } = await launchChrome({
  binary: CHROMIUM,
  args: ["--headless=new", "--no-sandbox", "--disable-gpu", "--silent-debugger-extension-api",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${chromeProfileDir("kat-tvs")}`, "about:blank"],
});
const ws = new WebSocket(wsUrl);
await new Promise((r) => { ws.onopen = () => r(null); });
let id = 0; const pending = new Map<string, (v: any) => void>();
const send = (method: string, params: any = {}, sessionId?: string) => new Promise<any>((res) => {
  const mid = ++id; pending.set(String(mid), res);
  ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
});
ws.onmessage = (m: MessageEvent) => {
  const j = JSON.parse(m.data as string);
  if (j.id && pending.has(String(j.id))) { pending.get(String(j.id))!(j); pending.delete(String(j.id)); }
};
// Surface page evaluation exceptions as FAILURES — silently discarded
// exceptionDetails made the round-1 base falsification un-auditable.
const evalIn = async (expr: string, sid: string) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sid);
  const exc = r?.result?.exceptionDetails;
  if (exc) {
    const desc = String(exc.exception?.description ?? exc.text ?? "unknown evaluation exception");
    check(`page evaluation did not throw (${expr.replace(/\s+/g, " ").slice(0, 70)}…)`, false, desc.slice(0, 300));
    return undefined;
  }
  return r?.result?.result?.value;
};

let sw = null;
for (let i = 0; i < 40 && !sw; i++) {
  const { result: { targetInfos } } = await send("Target.getTargets");
  sw = targetInfos.find((t: any) => t.type === "service_worker");
  if (!sw) await sleep(500);
}
if (!sw) { console.log("FAIL: no service worker target"); Deno.exit(1); }
const extId = new URL(sw.url).host;
const { result: { targetId } } = await send("Target.createTarget", { url: `chrome-extension://${extId}/ntp/ntp.html` });
const { result: { sessionId: pageSession } } = await send("Target.attachToTarget", { targetId, flatten: true });
await send("Runtime.enable", {}, pageSession);
await send("Page.enable", {}, pageSession);

// Headless has no pointer device; simulate a fine pointer so the hover wiring
// (gated on matchMedia("(pointer: fine)")) is active. Swapped to "coarse" for
// the no-hover scenario later.
const pointerStub = (mode: string) => `(() => {
  const MODE = ${JSON.stringify(mode)};
  const orig = window.matchMedia.bind(window);
  const fake = (q, matches) => ({ matches, media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    dispatchEvent: () => false });
  window.matchMedia = (q) => {
    const s = String(q);
    if (/\\(\\s*pointer\\s*:\\s*fine\\s*\\)/.test(s)) return fake(s, MODE === "fine");
    if (/\\(\\s*pointer\\s*:\\s*coarse\\s*\\)/.test(s)) return fake(s, MODE === "coarse");
    if (/\\(\\s*hover\\s*:\\s*hover\\s*\\)/.test(s)) return fake(s, MODE === "fine");
    if (/\\(\\s*hover\\s*:\\s*none\\s*\\)/.test(s)) return fake(s, MODE === "coarse");
    return orig(s);
  };
})()`;
let pointerScriptId = (await send("Page.addScriptToEvaluateOnNewDocument", { source: pointerStub("fine") }, pageSession))?.result?.identifier;

await sleep(1500);
const shot = async (name: string) => {
  const r = await send("Page.captureScreenshot", { format: "png" }, pageSession);
  if (r?.result?.data) await Deno.writeFile(`${OUT}/${name}.png`, Uint8Array.from(atob(r.result.data), (c) => c.charCodeAt(0)));
};

// Seed a REAL thread (SHORT title — geometry assertions need the title to
// leave free space in the view head) + a REAL running durable run bound to it.
const seeded = await evalIn(`(async () => {
  try {
    const t = await import(chrome.runtime.getURL("/lib/threads.js"));
    const m = await import(chrome.runtime.getURL("/lib/durable-runs.js"));
    const thread = await t.createThread("kat-tvs");
    const exec = "exec_kattvs" + Date.now().toString(36);
    await m.durableRuns.start({
      executionId: exec,
      kind: "task",
      threadId: thread.id,
      taskPreview: "kat-task-view-simplify: watch the nightly rollup",
      journalTarget: "master",
      resumeRequest: { route: "agent.run", task: "kat-task-view-simplify", attachments: [], history: [] },
    });
    return { ok: true, threadId: thread.id, exec };
  } catch (e) { return { err: String((e && e.message) ?? e) }; }
})()`, pageSession);
check("seeded a thread + a running durable run through the real stores", !!seeded && seeded.ok === true, seeded);

// Open the task through the REAL path: click its row in the hub task list.
await send("Page.reload", {}, pageSession);
await sleep(2500);
const clickTaskRow = `(async () => {
  for (const r of document.querySelectorAll('button, [role="button"], a, li')) {
    const txt = r.textContent || '';
    if (txt.includes('kat-tvs') || txt.includes('nightly rollup')) { r.click(); return { clicked: true }; }
  }
  return { clicked: false };
})()`;
const opened = await evalIn(clickTaskRow, pageSession);
check("the seeded task is clickable in the hub list", !!opened && opened.clicked === true, opened);
await sleep(2000);

const viewState = `(() => {
  const view = document.getElementById('thread-view');
  const reg = document.getElementById('durable-run-registry');
  const panel = document.getElementById('run-debug-panel');
  const toggle = document.getElementById('run-debug-toggle');
  const regRect = reg ? reg.getBoundingClientRect() : null;
  const panelRect = panel && !panel.hidden ? panel.getBoundingClientRect() : null;
  return {
    viewOpen: !!view && !view.hidden,
    regHiddenAttr: reg ? reg.hidden : null,
    panelExists: !!panel,
    panelHidden: panel ? panel.hidden : null,
    toggleExists: !!toggle,
    toggleHidden: toggle ? toggle.hidden : null,
    ariaExpanded: toggle ? toggle.getAttribute('aria-expanded') : null,
    panelInFlow: panelRect ? (panelRect.top >= 0 && panelRect.height > 0) : false,
    regInFlow: regRect ? (regRect.height > 0 && !reg.closest('[hidden]')) : false,
  };
})()`;

let st = await evalIn(viewState, pageSession);
check("the task view opened", !!st && st.viewOpen === true, st);
check("the registry is NOT a visible in-flow panel", !!st && st.regInFlow === false, st);
check("the debug toggle exists + is visible for a surface with runs", !!st && st.toggleExists === true && st.toggleHidden === false, st);
check("the debug panel starts closed", !!st && st.panelExists === true && st.panelHidden === true, st);
await shot("01-task-view-no-registry-panel");

// GEOMETRY (P1-a): with a short title the toggle anchors to the inline-end of
// the view head in LTR, and flips side in RTL (margin-inline-start: auto).
const geometry = `(() => {
  const head = document.querySelector('#thread-view .view-head');
  const toggle = document.getElementById('run-debug-toggle');
  const title = document.getElementById('thread-title');
  if (!head || !toggle || !title || toggle.hidden) return { ok: false, reason: 'missing' };
  const h = head.getBoundingClientRect(), g = toggle.getBoundingClientRect(), t = title.getBoundingClientRect();
  return { ok: true, headL: h.left, headR: h.right, togL: g.left, togR: g.right, titleR: t.right, titleL: t.left };
})()`;
let geo = await evalIn(geometry, pageSession);
check("LTR: the toggle hugs the inline-end (right) edge of the view head", !!geo && geo.ok === true && Math.abs(geo.togR - geo.headR) < 40 && geo.titleR < geo.headR - 80, geo);
await shot("02-inline-end-ltr");
await evalIn(`(() => { document.documentElement.dir = 'rtl'; return true; })()`, pageSession);
await sleep(400);
geo = await evalIn(geometry, pageSession);
check("RTL: the toggle hugs the inline-end (left) edge of the view head", !!geo && geo.ok === true && Math.abs(geo.togL - geo.headL) < 40 && geo.titleL > geo.headL + 80, geo);
await shot("03-inline-end-rtl");
await evalIn(`(() => { document.documentElement.dir = 'ltr'; return true; })()`, pageSession);
await sleep(300);

// Click the toggle → the overlay opens with the run's debug details.
// Guarded: on the base tree there is no toggle — the click reports
// clicked:false and the state check goes RED (no swallowed exception).
const clickedToggle = await evalIn(`(() => { const t = document.getElementById('run-debug-toggle'); if (!t) return { clicked: false }; t.click(); return { clicked: true }; })()`, pageSession);
await sleep(800);
st = await evalIn(viewState, pageSession);
const overlayText = await evalIn(`(() => (document.getElementById('run-debug-panel')?.textContent || '') + (document.getElementById('durable-run-registry')?.shadowRoot?.textContent || ''))()`, pageSession);
check("toggle opens the overlay (aria-expanded=true)", !!clickedToggle && clickedToggle.clicked === true && !!st && st.panelHidden === false && st.ariaExpanded === "true", { clickedToggle, panelHidden: st?.panelHidden, ariaExpanded: st?.ariaExpanded });
check("the overlay shows the run's debug details", typeof overlayText === "string" && overlayText.includes("Running") && overlayText.includes("kat-task-view-simplify"), (overlayText || "").slice(0, 160));
await shot("04-debug-overlay-open");

// Escape closes it (and unpins).
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, pageSession);
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, pageSession);
await sleep(500);
st = await evalIn(viewState, pageSession);
check("Escape closes the overlay", !!st && st.panelHidden === true && st.ariaExpanded === "false", st);

// HOVER TRAVERSAL (P1-b): move the pointer onto the toggle (unpinned open),
// then move it INTO the panel across the gap; the panel must still be open
// 500ms later (a synchronous pointerleave close would have destroyed it).
const centerOf = (r: any) => ({ x: Math.round((r.left + r.right) / 2), y: Math.round((r.top + r.bottom) / 2) });
const toggleRect = await evalIn(`(() => { const t = document.getElementById('run-debug-toggle'); if (!t || t.hidden) return null; const r = t.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; })()`, pageSession);
let hoverTraversed = false, hoverOpened = false, hoverClosedAfter = false;
if (toggleRect) {
  const tc = centerOf(toggleRect);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: tc.x, y: tc.y }, pageSession);
  await sleep(350);
  st = await evalIn(viewState, pageSession);
  hoverOpened = !!st && st.panelHidden === false;
  const panelRect = await evalIn(`(() => { const p = document.getElementById('run-debug-panel'); if (!p || p.hidden) return null; const r = p.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; })()`, pageSession);
  if (hoverOpened && panelRect) {
    const pc = centerOf(panelRect);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pc.x, y: pc.y }, pageSession);
    await sleep(500); // longer than the cancellable close delay
    st = await evalIn(viewState, pageSession);
    hoverTraversed = !!st && st.panelHidden === false;
    await shot("05-hover-traversal");
  }
  // Move away entirely → the delayed close fires.
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 40, y: 540 }, pageSession);
  await sleep(500);
  st = await evalIn(viewState, pageSession);
  hoverClosedAfter = !!st && st.panelHidden === true;
}
check("hover reveal opens the panel unpinned (fine pointer)", hoverOpened, { toggleRect });
check("the hover-opened panel is TRAVERSABLE (pointer moved toggle→panel, still open after 500ms)", hoverTraversed, { hoverOpened });
check("leaving both closes the hover-opened panel", hoverClosedAfter, { hoverTraversed });

// CLICK-OUTSIDE: pin via click, then a real pointerdown outside panel+toggle
// closes it.
await evalIn(`(() => { const t = document.getElementById('run-debug-toggle'); if (t) t.click(); return true; })()`, pageSession);
await sleep(500);
st = await evalIn(viewState, pageSession);
const pinnedOpen = !!st && st.panelHidden === false;
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: 120, y: 520, button: "left", clickCount: 1 }, pageSession);
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 120, y: 520, button: "left", clickCount: 1 }, pageSession);
await sleep(500);
st = await evalIn(viewState, pageSession);
check("click pins the overlay, and a click OUTSIDE closes it", pinnedOpen && !!st && st.panelHidden === true, { pinnedOpen, after: st?.panelHidden });

// REPEATED LIFECYCLE: open/close 3x, state stays coherent, Escape returns
// focus to the toggle.
let lifecycleOk = true, lifecycleDetail: unknown[] = [];
for (let i = 0; i < 3; i++) {
  await evalIn(`(() => { const t = document.getElementById('run-debug-toggle'); if (t) t.click(); return true; })()`, pageSession);
  await sleep(400);
  const openSt = await evalIn(viewState, pageSession);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, pageSession);
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, pageSession);
  await sleep(400);
  const closedSt = await evalIn(viewState, pageSession);
  const focus = await evalIn(`(() => document.activeElement && document.activeElement.id)()`, pageSession);
  const ok = !!openSt && openSt.panelHidden === false && !!closedSt && closedSt.panelHidden === true && closedSt.ariaExpanded === "false" && focus === "run-debug-toggle";
  lifecycleDetail.push({ i, open: openSt?.panelHidden, closed: closedSt?.panelHidden, focus });
  if (!ok) lifecycleOk = false;
}
check("repeated open/Escape-close lifecycle stays coherent (3x, focus returns to the toggle)", lifecycleOk, lifecycleDetail);

// COARSE POINTER: with (pointer: fine) false the hover wiring is not
// installed — hovering does nothing, click still pins. Requires a reload so
// the page re-evaluates the pointer capability at script init.
await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: pointerScriptId }, pageSession);
pointerScriptId = (await send("Page.addScriptToEvaluateOnNewDocument", { source: pointerStub("coarse") }, pageSession))?.result?.identifier;
await send("Page.reload", {}, pageSession);
await sleep(2500);
await evalIn(clickTaskRow, pageSession);
await sleep(2000);
const toggleRect2 = await evalIn(`(() => { const t = document.getElementById('run-debug-toggle'); if (!t || t.hidden) return null; const r = t.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; })()`, pageSession);
let coarseHoverClosed = false, coarseClickOpens = false;
if (toggleRect2) {
  const tc = centerOf(toggleRect2);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: tc.x, y: tc.y }, pageSession);
  await sleep(500);
  st = await evalIn(viewState, pageSession);
  coarseHoverClosed = !!st && st.panelHidden === true;
  await evalIn(`(() => { const t = document.getElementById('run-debug-toggle'); if (t) t.click(); return true; })()`, pageSession);
  await sleep(500);
  st = await evalIn(viewState, pageSession);
  coarseClickOpens = !!st && st.panelHidden === false;
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, pageSession);
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, pageSession);
  await sleep(300);
}
check("coarse pointer: hover does NOT open the panel (no hover wiring)", coarseHoverClosed, { toggleRect2 });
check("coarse pointer: click still pins the panel open", coarseClickOpens, { coarseHoverClosed });

// BACKGROUND CONTINUITY: leave the task, journal run-log rows while away (the
// real background path — thread.get projects tool cards from the durable run
// log), return, and confirm the away-progress is in the conversation.
await evalIn(`(() => { document.getElementById('thread-back').click(); return true; })()`, pageSession);
await sleep(1200);
const journaled = await evalIn(`(async () => {
  const m = await import(chrome.runtime.getURL("/lib/durable-runs.js"));
  const callId = "kat-away-" + Date.now().toString(36);
  await m.durableRuns.appendLog("${seeded?.exec}", { type: "tool-call", tool: "kat_away_collect", args: { source: "nightly-rollup" }, callId, at: Date.now() });
  await m.durableRuns.appendLog("${seeded?.exec}", { type: "tool-result", tool: "kat_away_collect", result: { ok: true, note: "kat-away-result: rollup sources gathered" }, callId, at: Date.now() + 1 });
  return { ok: true };
})()`, pageSession);
check("journaled run-log rows while the view was closed (background progress)", !!journaled && journaled.ok === true, journaled);

// Reopen the task and confirm the away-progress is in the conversation.
await evalIn(clickTaskRow, pageSession);
await sleep(2000);
const convoText = await evalIn(`(() => { const c = document.getElementById('thread-conversation'); return (c?.textContent || '') + '||' + (c?.innerHTML || ''); })()`, pageSession);
check("returning to the task shows the steps that ran while away", typeof convoText === "string" && convoText.includes("kat_away_collect"), (convoText || "").slice(0, 200));
st = await evalIn(viewState, pageSession);
check("the registry stays OUT of flow after reopening", !!st && st.regInFlow === false && st.panelHidden === true, st);
await shot("06-reopened-with-away-progress");

// Settle the run → the debug affordance disappears for this surface (reload).
await evalIn(`(async () => {
  const m = await import(chrome.runtime.getURL("/lib/durable-runs.js"));
  await m.durableRuns.settle("${seeded?.exec}", { ok: true, summary: "kat done" });
  return true;
})()`, pageSession);
await send("Page.reload", {}, pageSession);
await sleep(2500);
await evalIn(clickTaskRow, pageSession);
await sleep(2000);
st = await evalIn(viewState, pageSession);
check("a settled run leaves no debug affordance", !!st && st.toggleExists === true && st.toggleHidden === true, st);

console.log(`\n${pass} passed, ${fail} failed`);
proc.kill();
Deno.exit(fail ? 1 : 0);
