// cap-evidence/h638-open-trace.ts — MEASURE task-open latency for a RUNNING task
// that has REAL history (bead chrome-agent-platform-h638), in a REAL loaded
// extension, with genuine CDP input. Re-run after any change.
//
// The owner's case is not "a running task" and not "a big task" — it is a task
// he has been using (history) that is CURRENTLY running. So this harness:
//   1. seeds a thread with real history through the REAL durable-run API (the
//      same durableRuns.start()/appendLog() the product uses, in the page's own
//      OPFS origin), the way scripts/thread-open-trace.ts does;
//   2. opens it and sends a follow-up carrying @demo-slow (10 s hold on the
//      first model step) + @demo-stream (paced chunks) so the run is genuinely
//      IN FLIGHT on that thread;
//   3. goes home and clicks the row with real mouse input, timing the open;
//   4. repeats once the run settles (the control).
//
// The demo model needs the developer flag (`cap:developerFeatures`); without it
// a "demo" provider runs the local assistant and no marker engages.
//
//   deno run -A cap-evidence/h638-open-trace.ts [--runs=5] [--logs=50]

import { CHROMIUM, launchChrome, waitForServiceWorker } from "../scripts/lib/chrome-launch.ts";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXT = `${ROOT}extension`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const profile = durableDir(`h638-open-trace-${Date.now()}`);
const chrome = await launchChrome({
  binary: CHROMIUM,
  args: [
    "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
    "--silent-debugger-extension-api",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    "--window-size=1400,1200",
  ],
  profile,
  clearEnv: true,
});

const ws = new WebSocket(chrome.wsUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let msgId = 0;
const pending = new Map<number, (v: any) => void>();
ws.onmessage = (e: MessageEvent) => {
  const d = JSON.parse(String(e.data));
  if (d.id && pending.has(d.id)) { pending.get(d.id)!(d); pending.delete(d.id); }
};
const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
  new Promise<any>((res) => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params, sessionId })); });

const sw = await waitForServiceWorker(send, {
  timeoutMs: 20000,
  match: (t: any) => t.type === "service_worker" && t.url.startsWith("chrome-extension://"),
});
if (!sw) { console.error("extension service worker not found"); Deno.exit(1); }
const extId = new URL(sw.url).host;

async function openPage(url: string) {
  const t = await send("Target.createTarget", { url });
  await send("Target.activateTarget", { targetId: t.result.targetId });
  const a = await send("Target.attachToTarget", { targetId: t.result.targetId, flatten: true });
  const session = a.result.sessionId;
  await send("Runtime.enable", {}, session);
  await send("Page.enable", {}, session);
  await send("Page.bringToFront", {}, session);
  return session;
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
await evl(opts, `chrome.runtime.sendMessage({ type: "kv.set", values: { "cap:developerFeatures": true } })`);
await evl(opts, `chrome.runtime.sendMessage({ type: "provider.set", config: { provider: "demo", apiKey: "", baseURL: "", model: "" } })`);
await send("Target.closeTarget", { targetId: (await send("Target.getTargets")).result.targetInfos.find((t: any) => t.url.includes("options.html"))?.targetId });

const ntp = await openPage(`chrome-extension://${extId}/ntp/ntp.html`);
await sleep(2500);

const spans = async () => {
  const dump = await evl(ntp, `chrome.runtime.sendMessage({ type: "observability.dumpTrace" }).then(v => v, e => ({ err: String(e?.message ?? e) }))`);
  const out: Record<string, { count: number; totalMs: number }> = {};
  for (const m of (dump?.perf?.measures ?? [])) {
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
  const dump = await evl(ntp, `chrome.runtime.sendMessage({ type: "observability.dumpTrace" }).then(v => v, e => ({ err: String(e?.message ?? e) }))`);
  const out: Record<string, { count: number; totalMs: number }> = {};
  for (const m of (dump?.perf?.measures ?? [])) {
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
const HUB_INPUT = `document.getElementById("task-input")`;
const HUB_SEND = `document.getElementById("run-task")`;
const THREAD_INPUT = `document.getElementById("thread-composer")?.querySelector("#task-input")`;
const THREAD_SEND = `document.getElementById("thread-composer")?.querySelector("#run-task")`;

const waitForIdle = async (timeoutMs = 60000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const st = await evl(ntp, `(() => { const items = [...document.querySelectorAll("#thread-sidebar .thread-item")];
      return { running: items.filter(it => it.querySelector(".t-dot.running")).length, status: document.getElementById("status")?.textContent ?? "" }; })()`);
    if (st?.running === 0) return true;
    await sleep(300);
  }
  return false;
};

// Turn 1 from the HUB (starts the task); the rest continue the SAME thread.
const firstText = Deno.args.find((a) => a.startsWith("--first="))?.split("=")[1] ?? "h638 trace turn 1";
if (!await typeInto(ntp, HUB_INPUT, firstText)) { console.error("hub composer not found"); Deno.exit(1); }
if (!await clickSel(ntp, HUB_SEND)) { console.error("hub send not found"); Deno.exit(1); }
if (!await waitForIdle()) { console.error("the first turn never settled"); Deno.exit(1); }

// Filler turns: the LONG-ANSWER and BIG-RESULT markers put real projection work
// in the thread (a >4000-char message and a ~5 KiB nested tool result).
const FILLERS = ["@demo-long-answer summarise", "@demo-big-result dump", "second turn", "third turn"];
for (const filler of FILLERS) {
  if (!await typeInto(ntp, THREAD_INPUT, filler)) { console.error("thread composer not found"); Deno.exit(1); }
  if (!await clickSel(ntp, THREAD_SEND)) { console.error("thread send not found"); Deno.exit(1); }
  if (!await waitForIdle()) { console.error(`filler turn \"${filler}\" never settled`); Deno.exit(1); }
}
const historyState = await evl(ntp, `(() => { const c = document.getElementById("thread-conversation");
  return { bubbles: c ? c.querySelectorAll("message-bubble").length : 0, chars: c ? (c.textContent || "").length : 0 }; })()`);
console.log(`built a real task with history: ${JSON.stringify(historyState)}`);

// Record the last settled execution so the live one can be identified by a
// DIFFERENT id (a run is admitted asynchronously: looking too early sees the
// previous turn and would measure the wrong thing).
const beforeLive = await evl(ntp, `(async () => {
  const { durableRuns } = await import("/lib/durable-runs.js");
  const threads = await chrome.runtime.sendMessage({ type: "thread.list" });
  const list = Array.isArray(threads?.threads) ? threads.threads : [];
  const target = list.find(t => String(t.name || "").toLowerCase().includes("h638")) ?? list[0];
  const execs = await durableRuns.listThreadExecutions(target?.id).catch(() => []);
  return Array.isArray(execs) && execs.length ? execs[execs.length - 1].executionId : null;
})()`);
console.log(`last settled execution before the live turn: ${beforeLive}`);

// The live turn: @demo-slow holds the first model step for 10 s, so the task is
// genuinely RUNNING while the open below happens.
if (!await typeInto(ntp, THREAD_INPUT, "@demo-slow @demo-stream live turn")) { console.error("thread composer gone"); Deno.exit(1); }
if (!await clickSel(ntp, THREAD_SEND)) { console.error("thread send gone"); Deno.exit(1); }

// The seeded/live task's row: the one whose title matches the first turn text.
const TASK_ROW = `[...document.querySelectorAll("#thread-sidebar .thread-item")].find(it => (it.title || "").toLowerCase().includes(${JSON.stringify(firstText.toLowerCase().slice(0, 18))}))?.querySelector("button.t-open")`;

// Click INSIDE the run. The @demo-slow hold is 10 s, so home + click must happen
// well within it — and the phase is asserted at that moment, because a run that
// quietly settled turns this measurement into a different one (the first read
// after a settle drains the settle/compaction writes).
const phaseNow = async () => await evl(ntp, `(async () => {
  const { durableRuns } = await import("/lib/durable-runs.js");
  const threads = await chrome.runtime.sendMessage({ type: "thread.list" });
  const list = Array.isArray(threads?.threads) ? threads.threads : [];
  const target = list.find(t => String(t.name || "").toLowerCase().includes("h638")) ?? list[0];
  if (!target) return null;
  const execs = await durableRuns.listThreadExecutions(target.id).catch(() => []);
  const last = Array.isArray(execs) ? execs[execs.length - 1] : null;
  return last ? { id: last.executionId, phase: last.record?.phase ?? null } : null;
})()`);
// Wait for the live run to be ADMITTED and running (bounded: the hold is 10 s).
let atClick = null;
for (let i = 0; i < 40; i++) {
  atClick = await phaseNow();
  // The SUBSTANTIVE precondition is "a run is in flight while the owner clicks".
  // The id may legitimately be unchanged (a send while a run is active is
  // queued into that run by the product's own steer/queue path), so the id is
  // recorded rather than required.
  if (atClick && atClick.phase === "running") break;
  await sleep(200);
}
console.log(`newest execution at click time: ${JSON.stringify(atClick)}${atClick?.id === beforeLive ? " (same id as the last settled one — the send was queued into the in-flight run)" : ""}`);
if (atClick?.phase !== "running") {
  console.error(`REFUSING to report a running-open number: the newest execution is "${atClick?.phase}"`);
  Deno.exit(1);
}
// The sidebar must also show it running (what the owner clicks).
const rowState = await evl(ntp, `(() => { const items = [...document.querySelectorAll("#thread-sidebar .thread-item")];
  return { items: items.length, running: items.filter(it => it.querySelector(".t-dot.running")).length }; })()`);
console.log(`sidebar at click time: ${JSON.stringify(rowState)}\n`);

/** Time one open: measure from the real click to the first transcript repaint. */
async function measureOpen(label: string, rowExpr: string) {
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
  return {
    label,
    firstPaintMs: Math.round(result?.firstBubble ?? -1),
    viewVisibleMs: Math.round(result?.viewVisible ?? -1),
    spans: spanDelta(before, after).slice(0, 14),
    rawSpans: spanDeltaRaw(beforeRaw, afterRaw).slice(0, 12),
    painted,
    afterLive,
  };
}

await evl(ntp, `document.getElementById("home")?.click?.(); true`);
await sleep(500);
const runningMeasure = await measureOpen("RUNNING task with history", TASK_ROW);

// The diagnostics run AFTER the measured open: their own multi-second work
// would otherwise consume the run's 10 s live window and turn this measurement
// into "a task that just settled" (which is exactly what happened once).
// DIAGNOSTIC: call the view builder itself, in the live window, with listLogs
// wrapped — this shows exactly which executions the view reads.
const viewProbe = await evl(ntp, `(async () => {
  const { durableRuns } = await import("/lib/durable-runs.js");
  const { buildThreadRunView } = await import("/lib/thread-run-view.js");
  const { getThread } = await import("/lib/threads.js");
  const threads = await chrome.runtime.sendMessage({ type: "thread.list" });
  const list = Array.isArray(threads?.threads) ? threads.threads : [];
  const target = list.find(t => String(t.name || "").toLowerCase().includes("h638")) ?? list[0];
  const thread = await getThread(target.id);
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
  const threads = await chrome.runtime.sendMessage({ type: "thread.list" });
  const list = Array.isArray(threads?.threads) ? threads.threads : [];
  const target = list.find(t => String(t.name || "").toLowerCase().includes("h638")) ?? list[0];
  if (!target) return { error: "no thread" };
  await chrome.runtime.sendMessage({ type: "observability.clearTrace" });
  const t0 = performance.now();
  const r = await chrome.runtime.sendMessage({ type: "thread.get", id: target.id });
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

try { chrome.proc.kill("SIGKILL"); } catch { /* already gone */ }
const failed = [runningMeasure, settledMeasure].some((r) => (r as any).error || (r as any).firstPaintMs < 0);
Deno.exit(failed ? 1 : 0);
