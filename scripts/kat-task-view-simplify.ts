// kat-task-view-simplify.ts — live-browser KAT for the task-view
// simplification (owner directive 2026-08-28: the durable run registry must
// NOT be a visible panel; the conversation IS the status surface; the
// registry becomes a small top-right debug affordance; tasks keep running in
// the background and re-opening a task shows what happened while away).
//
// Falsification: checks 1-4 fail on the pre-change code (no #run-debug-toggle
// element exists; the registry renders in flow when runs exist).
//
//   deno run -A scripts/kat-task-view-simplify.ts <path-to-extension> [<out-dir>]

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? `${ROOT}.cache/kat-task-view-simplify`;
const CHROMIUM = "/usr/bin/chromium";
const PORT = 9361;

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`); }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
await Deno.mkdir(OUT, { recursive: true });

const proc = new Deno.Command(CHROMIUM, {
  args: ["--headless=new", "--no-sandbox", "--disable-gpu", "--silent-debugger-extension-api",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    `--remote-debugging-port=${PORT}`, "--remote-allow-origins=*",
    `--user-data-dir=${ROOT}.cache/kat-tvs-${Date.now()}`, "about:blank"],
  stdout: "null", stderr: "piped",
}).spawn();

let wsUrl = "";
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    const j = await r.json();
    wsUrl = j.webSocketDebuggerUrl as string;
    break;
  } catch { await sleep(300); }
}
if (!wsUrl) { console.error("no devtools url"); Deno.exit(1); }
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
const evalIn = async (expr: string, sid: string) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sid);
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
await sleep(1500);
const shot = async (name: string) => {
  const r = await send("Page.captureScreenshot", { format: "png" }, pageSession);
  if (r?.result?.data) await Deno.writeFile(`${OUT}/${name}.png`, Uint8Array.from(atob(r.result.data), (c) => c.charCodeAt(0)));
};

// Seed a REAL thread + a REAL running durable run bound to it (the same store
// + module the SW uses — page-realm import over the same origin store).
const seeded = await evalIn(`(async () => {
  try {
    const t = await import(chrome.runtime.getURL("/lib/threads.js"));
    const m = await import(chrome.runtime.getURL("/lib/durable-runs.js"));
    const thread = await t.createThread("kat-task-view-simplify: watch the nightly rollup");
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
const threadId = seeded?.threadId;

// Open the task through the REAL path: click its row in the hub task list.
await send("Page.reload", {}, pageSession);
await sleep(2500);
const opened = await evalIn(`(async () => {
  const rows = [...document.querySelectorAll('#tasks [data-thread-id], #tasks li, #tasks .task')];
  for (const r of document.querySelectorAll('button, [role="button"], a, li')) {
    if ((r.textContent || '').includes('kat-task-view-simplify')) { r.click(); return { clicked: true }; }
  }
  return { clicked: false, rows: rows.length };
})()`, pageSession);
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

// Click the toggle → the overlay opens with the run's debug details.
await evalIn(`(() => { document.getElementById('run-debug-toggle').click(); return true; })()`, pageSession);
await sleep(800);
st = await evalIn(viewState, pageSession);
const overlayText = await evalIn(`(() => (document.getElementById('run-debug-panel')?.textContent || '') + (document.getElementById('durable-run-registry')?.shadowRoot?.textContent || ''))()`, pageSession);
check("toggle opens the overlay (aria-expanded=true)", !!st && st.panelHidden === false && st.ariaExpanded === "true", st);
check("the overlay shows the run's debug details", typeof overlayText === "string" && overlayText.includes("Running") && overlayText.includes("kat-task-view-simplify"), (overlayText || "").slice(0, 160));
await shot("02-debug-overlay-open");

// Escape closes it (and unpins).
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, pageSession);
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, pageSession);
await sleep(500);
st = await evalIn(viewState, pageSession);
check("Escape closes the overlay", !!st && st.panelHidden === true && st.ariaExpanded === "false", st);

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
await evalIn(`(async () => {
  for (const r of document.querySelectorAll('button, [role="button"], a, li')) {
    if ((r.textContent || '').includes('kat-task-view-simplify')) { r.click(); return true; }
  }
  return false;
})()`, pageSession);
await sleep(2000);
const convoText = await evalIn(`(() => { const c = document.getElementById('thread-conversation'); return (c?.textContent || '') + '||' + (c?.innerHTML || ''); })()`, pageSession);
check("returning to the task shows the steps that ran while away", typeof convoText === "string" && convoText.includes("kat_away_collect"), (convoText || "").slice(0, 200));
st = await evalIn(viewState, pageSession);
check("the registry stays OUT of flow after reopening", !!st && st.regInFlow === false && st.panelHidden === true, st);
await shot("03-reopened-with-away-progress");

// Settle the run → the debug affordance disappears for this surface (reload).
await evalIn(`(async () => {
  const m = await import(chrome.runtime.getURL("/lib/durable-runs.js"));
  await m.durableRuns.settle("${seeded?.exec}", { ok: true, summary: "kat done" });
  return true;
})()`, pageSession);
await send("Page.reload", {}, pageSession);
await sleep(2500);
await evalIn(`(async () => {
  for (const r of document.querySelectorAll('button, [role="button"], a, li')) {
    if ((r.textContent || '').includes('kat-task-view-simplify')) { r.click(); return true; }
  }
  return false;
})()`, pageSession);
await sleep(2000);
st = await evalIn(viewState, pageSession);
check("a settled run leaves no debug affordance", !!st && st.toggleExists === true && st.toggleHidden === true, st);

console.log(`\n${pass} passed, ${fail} failed`);
proc.kill();
Deno.exit(fail ? 1 : 0);
