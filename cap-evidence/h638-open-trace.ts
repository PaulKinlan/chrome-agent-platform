// cap-evidence/h638-open-trace.ts — MEASURE task-open latency for a RUNNING task
// that has REAL history (bead chrome-agent-platform-h638), in a REAL loaded
// extension, with genuine CDP input. Re-run after any change.
//
// The owner's case is not "a running task" and not "a big task" — it is a task
// he has been using (history) that is CURRENTLY running. So this harness:
//   1. builds a task's history with real hub/thread composer turns; each turn
//      must produce a NEW successfully settled durable execution;
//   2. sends a follow-up carrying @demo-slow (10 s hold on the
//      first model step) + @demo-stream (paced chunks) so the run is genuinely
//      IN FLIGHT on that thread;
//   3. goes home and clicks the row with real mouse input, timing the open;
//   4. repeats once the run settles (the control).
//
// The demo model needs the developer flag (`cap:developerFeatures`); without it
// a "demo" provider runs the local assistant and no marker engages.
//
//   deno run -A cap-evidence/h638-open-trace.ts [--first="h638 trace turn 1"]

import { launchChrome, waitForServiceWorker, teardownChrome, withTimeout, SW_MATCH } from "../scripts/lib/chrome-launch.ts";
import { chromeProfileDir } from "../scripts/lib/chrome-profile-dir.ts";
import { selectLiveOpenExecution, requireTraceMeasures, isDemoProviderConfigured } from "../scripts/lib/live-open-precondition.ts";
import { composerInput, composerSend } from "../scripts/lib/composer-target.ts";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXT = `${ROOT}extension`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const profile = chromeProfileDir("h638-open-trace");
// House-style consolidation, NOT a fix (see the correction below): this used to
// pass the hand-rolled `binary: CHROMIUM` + --load-extension form; it now uses
// the launcher's `extension:` option, which is the shape every other live
// harness uses. Both forms load the extension on this box — `extension:` does
// NOT resolve a Chrome-for-Testing binary; launchChrome uses /usr/bin/chromium
// through the same CHROMIUM const (only the kat-* harnesses pass
// resolveChromeForTesting() themselves). What actually stopped this driver
// running was (a) a FRESH WORKTREE whose extension/ had not been built, so
// "extension service worker not found" fired before any composer was touched,
// and (b) the retired-id selectors below, which were the load-bearing fix.
const chrome = await launchChrome({ extension: EXT, profile, windowSize: "1400,1200", clearEnv: true });
let ws: WebSocket | undefined;
try {
ws = new WebSocket(chrome.wsUrl);
await withTimeout(new Promise((r, j) => { ws!.onopen = r; ws!.onerror = j; }), 15000);
let msgId = 0;
const pending = new Map<number, (v: any) => void>();
ws.onmessage = (e: MessageEvent) => {
  const d = JSON.parse(String(e.data));
  if (d.id && pending.has(d.id)) { pending.get(d.id)!(d); pending.delete(d.id); }
};
const send = async (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
  const id = ++msgId;
  const call = new Promise<any>((res) => { pending.set(id, res); ws!.send(JSON.stringify({ id, method, params, sessionId })); });
  try { return await withTimeout(call, 15000); }
  finally { pending.delete(id); }
};

const sw = await waitForServiceWorker(send, {
  timeoutMs: 20000,
  match: SW_MATCH,
});
if (!sw) throw new Error("extension service worker not found");
const extId = new URL(sw.url).host;

async function openPage(url: string) {
  const t = await send("Target.createTarget", { url });
  await send("Target.activateTarget", { targetId: t.result.targetId });
  const a = await send("Target.attachToTarget", { targetId: t.result.targetId, flatten: true });
  const session = a.result.sessionId;
  await send("Runtime.enable", {}, session);
  await send("Page.enable", {}, session);
  await send("Page.bringToFront", {}, session);
  const deadline = Date.now() + 15000;
  let state;
  do {
    const reply = await send("Runtime.evaluate", { expression: `(() => ({ url:location.href, ready:document.readyState,
      composer:!!document.querySelector('#composer [data-composer-input]'), options:!!document.getElementById('prompts') }))()`, returnByValue: true }, session);
    state = reply?.result?.result?.value;
    if (state?.url === url && state.ready === "complete" && (url.includes("/ntp/") ? state.composer : state.options)) return session;
    await sleep(100);
  } while (Date.now() < deadline);
  throw new Error(`extension page never became ready: expected ${url}, observed ${JSON.stringify(state)}`);
}
const evl = async (session: string, expression: string) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, timeout: 300000 }, session);
  if (r?.result?.exceptionDetails) return { __error: r.result.exceptionDetails.exception?.description ?? "eval threw" };
  return r?.result?.result?.value;
};
const boxOf = async (session: string, expr: string) => {
  const v = await evl(session, `(() => { const el = ${expr}; if (!el) return null;
    el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) }; })()`);
  return v && typeof (v as any).x === "number" ? v as { x: number; y: number } : null;
};
const clickAt = async (session: string, box: { x: number; y: number }) => {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", buttons: 1, clickCount: 1 }, session);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", buttons: 0, clickCount: 1 }, session);
};
const clickSel = async (session: string, expr: string) => {
  const b = await boxOf(session, expr);
  if (!b) return false;
  await clickAt(session, b);
  return true;
};
const typeInto = async (session: string, expr: string, text: string) => {
  if (!await clickSel(session, expr)) return false;
  await send("Input.insertText", { text }, session);
  return true;
};

// ── provider: developer flag + demo model (the marker seam the journeys use)
const opts = await openPage(`chrome-extension://${extId}/options/options.html`);
await sleep(1200);
const developerFlag = await evl(opts, `chrome.runtime.sendMessage({ type: "kv.set", values: { "cap:developerFeatures": true } })`);
if (developerFlag?.ok !== true) throw new Error(`demo developer flag refused: ${JSON.stringify(developerFlag)}`);
const demoProvider = await evl(opts, `chrome.runtime.sendMessage({ type: "provider.set", config: { provider: "demo", apiKey: "", baseURL: "", model: "" } })`);
if (!isDemoProviderConfigured(demoProvider)) throw new Error(`demo provider setup refused or unexpected reply: ${JSON.stringify(demoProvider)}`);
await send("Target.closeTarget", { targetId: (await send("Target.getTargets")).result.targetInfos.find((t: any) => t.url.includes("options.html"))?.targetId });

const ntp = await openPage(`chrome-extension://${extId}/ntp/ntp.html`);
await sleep(2500);

const traceMeasures = async () => requireTraceMeasures(await evl(ntp, `chrome.runtime.sendMessage({ type: "observability.dumpTrace" })`));
const spans = async () => {
  const out: Record<string, { count: number; totalMs: number }> = {};
  for (const m of await traceMeasures()) {
    const key = String(m.name ?? "").replace(/^cap:/, "").replace(/:\d+$/, "");
    const bucket = key.startsWith("thread-view:logs:") ? "thread-view:logs:*" : key;
    const b = out[bucket] ?? (out[bucket] = { count: 0, totalMs: 0 });
    b.count += m.count ?? 1;
    b.totalMs += m.totalMs ?? 0;
  }
  return out;
};
/** RAW spans (ids kept) for the window — per-execution log reads included. */
const spansRaw = async () => {
  const out: Record<string, { count: number; totalMs: number }> = {};
  for (const m of await traceMeasures()) {
    const key = String(m.name ?? "").replace(/^cap:/, "");
    const b = out[key] ?? (out[key] = { count: 0, totalMs: 0 });
    b.count += m.count ?? 1;
    b.totalMs += m.totalMs ?? 0;
  }
  return out;
};
const spanDeltaRaw = (before: Record<string, any>, after: Record<string, any>) => {
  const delta: Array<{ name: string; count: number; totalMs: number }> = [];
  for (const [name, v] of Object.entries(after)) {
    const b = before[name] ?? { count: 0, totalMs: 0 };
    const count = v.count - b.count;
    if (count > 0) delta.push({ name, count, totalMs: Math.round(v.totalMs - b.totalMs) });
  }
  return delta.sort((a, b) => b.totalMs - a.totalMs);
};

const spanDelta = (before: Record<string, any>, after: Record<string, any>) => {
  const delta: Array<{ name: string; count: number; totalMs: number }> = [];
  for (const [name, v] of Object.entries(after)) {
    const b = before[name] ?? { count: 0, totalMs: 0 };
    const count = v.count - b.count;
    if (count > 0) delta.push({ name, count, totalMs: Math.round(v.totalMs - b.totalMs) });
  }
  return delta.sort((a, b) => b.totalMs - a.totalMs);
};

// ── build a REAL task with history through the UI (the path the owner uses).
// A store-level seed does not appear in the sidebar and is not what he clicks:
// every filler turn below is a genuine run, and the transcript they leave is
// what the measured open has to project.
const HUB_INPUT = `document.querySelector(${JSON.stringify(composerInput("hub"))})`;
const HUB_SEND = `document.querySelector(${JSON.stringify(composerSend("hub"))})`;
const THREAD_INPUT = `document.querySelector(${JSON.stringify(composerInput("thread"))})`;
const THREAD_SEND = `document.querySelector(${JSON.stringify(composerSend("thread"))})`;

let runBootId: string | undefined;
const runSnapshot = async () => {
  const snapshot = await evl(ntp, `chrome.runtime.sendMessage({ type: "run.list" })`);
  if (!Array.isArray(snapshot?.runs) || typeof snapshot.bootId !== "string") throw new Error(`run.list unavailable: ${JSON.stringify(snapshot)}`);
  if (runBootId && runBootId !== snapshot.bootId) throw new Error("REFUSING live-open: service worker boot changed during measurement");
  runBootId = snapshot.bootId;
  return snapshot.runs;
};
const settledRunIds = new Set<string>((await runSnapshot()).map((r: any) => r.executionId));
const waitForIdle = async (timeoutMs = 60000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const fresh = (await runSnapshot()).filter((r: any) => !settledRunIds.has(r.executionId));
    // A 0-dot snapshot immediately after Send is NOT evidence of a settled turn:
    // the new run may not have been admitted yet. Require its durable terminal row.
    if (fresh.length && fresh.every((r: any) => r.phase === "terminal" && r.terminal?.ok === true)) {
      for (const row of fresh) settledRunIds.add(row.executionId);
      return true;
    }
    await sleep(300);
  }
  return false;
};

// Turn 1 from the HUB (starts the task); the rest continue the SAME thread.
const firstText = Deno.args.find((a) => a.startsWith("--first="))?.split("=")[1] ?? "h638 trace turn 1";
if (!await typeInto(ntp, HUB_INPUT, firstText)) throw new Error("hub composer not found");
if (!await clickSel(ntp, HUB_SEND)) throw new Error("hub send not found");
if (!await waitForIdle()) throw new Error("the first turn never settled");

// Filler turns: the LONG-ANSWER and BIG-RESULT markers put real projection work
// in the thread (a >4000-char message and a ~5 KiB nested tool result).
const FILLERS = ["@demo-long-answer summarise", "@demo-big-result dump", "second turn", "third turn"];
for (const filler of FILLERS) {
  if (!await typeInto(ntp, THREAD_INPUT, filler)) throw new Error("thread composer not found");
  if (!await clickSel(ntp, THREAD_SEND)) throw new Error("thread send not found");
  if (!await waitForIdle()) throw new Error(`filler turn \"${filler}\" never settled`);
}
const historyState = await evl(ntp, `(() => { const c = document.getElementById("thread-conversation");
  return { bubbles: c ? c.querySelectorAll("message-bubble").length : 0, chars: c ? (c.textContent || "").length : 0 }; })()`);
console.log(`built a real task with history: ${JSON.stringify(historyState)}`);

// Pin the EXACT row the click will use, not a name-substring thread.list guess
// (the latter could silently select another task or fall back to list[0]).
const TASK_ROW = `[...document.querySelectorAll("#thread-sidebar .thread-item")].find(it => (it.title || "").toLowerCase().includes(${JSON.stringify(firstText.toLowerCase().slice(0, 18))}))?.querySelector("button.t-open")`;
const threadId = await evl(ntp, `(() => (${TASK_ROW})?.closest('.thread-item')?.getAttribute('data-thread-id') ?? null)()`);
if (typeof threadId !== "string" || !threadId) throw new Error("the clicked task row has no durable thread id");
// Even a durable terminal row can settle before the UI releases its control bar.
// Steer/queue modes absorb a send; require the real composer to offer a fresh
// turn BEFORE typing the measured @demo-slow turn.
let readyToSend = false;
for (let i = 0; i < 50; i++) {
  const state = await evl(ntp, `(() => ({ barHidden: document.getElementById('run-control-bar')?.hidden === true,
    running: !!document.querySelector('[data-thread-id=${JSON.stringify(threadId)}] .t-dot.running') }))()`);
  if (state?.barHidden === true && state.running === false) { readyToSend = true; break; }
  await sleep(200);
}
if (!readyToSend) throw new Error("REFUSING live-open: run-control bar is still active; the turn would be steered/queued");
const priorIds = (await runSnapshot()).filter((r: any) => r.threadId === threadId).map((r: any) => r.executionId);
console.log(`clicked task ${threadId}: ${priorIds.length} prior executions before measured send`);

// The live turn: @demo-slow holds the first model step for 10 s, so the task is
// genuinely RUNNING while the open below happens.
if (!await typeInto(ntp, THREAD_INPUT, "@demo-slow @demo-stream live turn")) throw new Error("thread composer gone");
if (!await clickSel(ntp, THREAD_SEND)) throw new Error("thread send gone");

// Click INSIDE the run. The @demo-slow hold is 10 s, so home + click must happen
// well within it — and the phase is asserted at that moment, because a run that
// quietly settled turns this measurement into a different one (the first read
// after a settle drains the settle/compaction writes).
// Mirror the page's actionable updatedAt authority, but require a NEW run
// (not a steered/queued send into an old run) with phase running at click.
let atClick = selectLiveOpenExecution({ threadId, runs: await runSnapshot(), priorIds });
for (let i = 0; i < 40 && !atClick.ok; i++) {
  if (atClick.reason !== "send_absorbed") break; // a fresh run already settled; do not relabel it
  await sleep(200);
  atClick = selectLiveOpenExecution({ threadId, runs: await runSnapshot(), priorIds });
}
console.log(`clicked task execution at click time: ${JSON.stringify(atClick)}`);
if (!atClick.ok) throw new Error(`REFUSING live-open: ${atClick.reason} (${atClick.executionId ?? "no fresh id"}, ${atClick.phase ?? "no phase"})`);
// The sidebar must also show it running (what the owner clicks).
const rowState = await evl(ntp, `(() => { const row = document.querySelector('[data-thread-id=${JSON.stringify(threadId)}]');
  return { exists: !!row, running: !!row?.querySelector('.t-dot.running') }; })()`);
if (rowState?.exists !== true || rowState?.running !== true) throw new Error(`REFUSING live-open: clicked row does not show a running task: ${JSON.stringify(rowState)}`);
console.log(`clicked sidebar row at click time: ${JSON.stringify(rowState)}\n`);

/** Time one open: measure from the real click to the first transcript repaint. */
async function measureOpen(label: string, rowExpr: string, expectedLiveId: string | null = null) {
  // Clear the live conversation so "first paint" means THIS open repainted the
  // transcript (otherwise the previous surface is simply still on screen).
  await evl(ntp, `(() => { const c = document.getElementById("thread-conversation"); c?.replaceChildren?.(); return true; })()`);
  await evl(ntp, `(() => {
    window.__h638 = { t0: performance.now(), firstBubble: null, viewVisible: null };
    // Re-QUERY every tick: an open may replace the conversation/view elements,
    // and a captured reference then watches a detached node forever (that bug
    // reported a running open as "never painted").
    const stamp = () => {
      const o = window.__h638;
      const view = document.getElementById("thread-view");
      const conv = document.getElementById("thread-conversation");
      if (o.viewVisible == null && view && !view.hidden) o.viewVisible = performance.now() - o.t0;
      if (o.firstBubble == null && conv && conv.querySelector("message-bubble, tool-call-card, .tool-card")) o.firstBubble = performance.now() - o.t0;
    };
    window.__h638Mo?.disconnect?.();
    window.__h638Mo = new MutationObserver(stamp);
    window.__h638Mo.observe(document.body, { childList: true, subtree: true });
    stamp();
    return true;
  })()`);
  const before = await spans();
  const beforeRaw = await spansRaw();
  const box = await boxOf(ntp, rowExpr);
  if (!box) return { label, error: `row not found` };
  if (expectedLiveId) {
    const live = selectLiveOpenExecution({ threadId, runs: await runSnapshot(), priorIds });
    if (!live.ok || live.executionId !== expectedLiveId) return { label, error: `the live run settled/changed before pointer click: ${JSON.stringify(live)}` };
  }
  await clickAt(ntp, box);
  let result: any = null;
  for (let i = 0; i < 200; i++) {
    result = await evl(ntp, `window.__h638 ? { firstBubble: window.__h638.firstBubble, viewVisible: window.__h638.viewVisible } : null`);
    if (result && typeof result === "object" && result.firstBubble != null) break;
    await sleep(50);
  }
  await sleep(250); // let the open settle so the span delta is attributable
  // Nothing-dropped check: the open must paint the thread's own turns, and the
  // live path must then add the running execution's rows (which this build of
  // the view deliberately did not read).
  const painted = await evl(ntp, `(() => { const c = document.getElementById("thread-conversation");
    return { bubbles: c ? c.querySelectorAll("message-bubble").length : 0,
             live: !!c?.querySelector?.(".live-status, [data-live-status]") || /running|working/i.test(document.getElementById("status")?.textContent || "") }; })()`);
  await sleep(4000);
  const afterLive = await evl(ntp, `(() => { const c = document.getElementById("thread-conversation");
    return { bubbles: c ? c.querySelectorAll("message-bubble").length : 0,
             status: document.getElementById("status")?.textContent ?? "" }; })()`);
  const after = await spans();
  const afterRaw = await spansRaw();
  const rawSpans = spanDeltaRaw(beforeRaw, afterRaw);
  return {
    label,
    liveLogReads: expectedLiveId ? rawSpans.filter((s) => s.name === `thread-view:logs:${expectedLiveId}`).length : null,
    firstPaintMs: Math.round(result?.firstBubble ?? -1),
    viewVisibleMs: Math.round(result?.viewVisible ?? -1),
    spans: spanDelta(before, after).slice(0, 14),
    rawSpans: rawSpans.slice(0, 12),
    painted,
    afterLive,
  };
}

await evl(ntp, `document.getElementById("home")?.click?.(); true`);
await sleep(500);
const runningMeasure = await measureOpen("RUNNING task with history", TASK_ROW, atClick.executionId);
if (runningMeasure.error) throw new Error(`REFUSING live-open: ${runningMeasure.error}`);
if (runningMeasure.liveLogReads !== 0) throw new Error(`REFUSING live-open: view read the live execution's own log: ${JSON.stringify(runningMeasure)}`);

// The diagnostics run AFTER the measured open: their own multi-second work
// would otherwise consume the run's 10 s live window and turn this measurement
// into "a task that just settled" (which is exactly what happened once).
// DIAGNOSTIC: call the view builder itself, in the live window, with listLogs
// wrapped — this shows exactly which executions the view reads.
const viewProbe = await evl(ntp, `(async () => {
  const { durableRuns } = await import("/lib/durable-runs.js");
  const { buildThreadRunView } = await import("/lib/thread-run-view.js");
  const { getThread } = await import("/lib/threads.js");
  const targetId = ${JSON.stringify(threadId)};
  const thread = await getThread(targetId);
  const reads = [];
  const t0 = performance.now();
  const view = await buildThreadRunView(thread, {
    listThreadExecutions: (id) => durableRuns.listThreadExecutions(id),
    listLogs: (id) => { reads.push(id); return durableRuns.listLogs(id); },
    commitTerminal: () => {}, recordFailure: () => {},
  });
  return { ms: Math.round(performance.now() - t0), reads, messages: view?.messages?.length ?? null };
})()`);
console.log(`direct view build while running: ${JSON.stringify(viewProbe).slice(0, 400)}\n`);

// CONTROL: clear the trace and do NOTHING for 2 s. Any span that appears here
// is re-reported by another context (the dump merges SW + page measures), which
// would make a naive attribution of the next call wrong.
const noopWindow = await evl(ntp, `(async () => {
  await chrome.runtime.sendMessage({ type: "observability.clearTrace" });
  await new Promise(r => setTimeout(r, 2000));
  const dump = await chrome.runtime.sendMessage({ type: "observability.dumpTrace" });
  return (dump?.perf?.measures ?? []).map(m => ({ name: String(m.name || "").replace(/^cap:/, ""), count: m.count ?? 1, totalMs: Math.round(m.totalMs ?? 0) }))
    .sort((a, b) => b.totalMs - a.totalMs).slice(0, 6);
})()`);
console.log(`2 s control (no call): ${JSON.stringify(noopWindow).slice(0, 400)}\n`);

// ISOLATE THE SW: clear the trace, call the SAME route the UI calls, dump the
// SW's own spans. This is the clean attribution (the merged dump cannot say
// which context a span came from).
const swIsolated = await evl(ntp, `(async () => {
  const targetId = ${JSON.stringify(threadId)};
  await chrome.runtime.sendMessage({ type: "observability.clearTrace" });
  const t0 = performance.now();
  const r = await chrome.runtime.sendMessage({ type: "thread.get", id: targetId });
  const ms = Math.round(performance.now() - t0);
  const dump = await chrome.runtime.sendMessage({ type: "observability.dumpTrace" });
  const spans = (dump?.perf?.measures ?? []).map(m => ({ name: String(m.name || "").replace(/^cap:/, ""), count: m.count ?? 1, totalMs: Math.round(m.totalMs ?? 0) }))
    .sort((a, b) => b.totalMs - a.totalMs).slice(0, 6);
  return { ms, ok: r?.ok === true, messages: r?.thread?.messages?.length ?? null,
    probe: r?.thread?.__h638probe ?? null, spans };
})()`);
console.log(`SW thread.get while RUNNING: ${JSON.stringify(swIsolated).slice(0, 500)}\n`);


// ── control: the SAME task once settled
await evl(ntp, `document.getElementById("home")?.click?.(); true`);
let settled = false;
for (let i = 0; i < 240; i++) {
  const st = await evl(ntp, `(() => { const items = [...document.querySelectorAll("#thread-sidebar .thread-item")];
    return { running: items.filter(it => it.querySelector(".t-dot.running")).length,
             runs: null }; })()`);
  if (st?.running === 0) { settled = true; break; }
  await sleep(500);
}
const settledMeasure = settled
  ? await measureOpen("SETTLED task with history (control)", TASK_ROW)
  : { label: "SETTLED task with history (control)", error: "still running after 120 s" };

console.log("─".repeat(72));
console.log(`bead h638 — task open in the loaded extension (${FILLERS.length + 2} real turns, measured ${JSON.stringify(historyState)})\n`);
for (const r of [runningMeasure, settledMeasure]) {
  console.log(r.label);
  if ((r as any).error) { console.log(`  ERROR ${(r as any).error}\n`); continue; }
  console.log(`  first transcript paint : ${(r as any).firstPaintMs} ms`);
  console.log(`  thread view visible    : ${(r as any).viewVisibleMs} ms`);
  for (const s of (r as any).spans ?? []) console.log(`    ${String(s.name).padEnd(34)} ${String(s.totalMs).padStart(6)} ms over ${s.count}`);
  console.log(`  painted at open: ${JSON.stringify((r as any).painted)}   after 4 s: ${JSON.stringify((r as any).afterLive)}`);
  console.log("  raw spans (ids kept):");
  for (const s of (r as any).rawSpans ?? []) console.log(`    ${String(s.name).padEnd(52)} ${String(s.totalMs).padStart(6)} ms`);
  console.log("");
}
console.log("─".repeat(72));

const failed = [runningMeasure, settledMeasure].some((r) => (r as any).error || (r as any).firstPaintMs < 0);
if (failed) throw new Error("h638 live/settled open measurement failed — see per-case result above");
} finally {
  try { ws?.close(); } catch { /* already closed */ }
  await teardownChrome(chrome, profile);
}
