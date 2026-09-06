// scripts/kat-thinking-trace.ts — chrome-agent-platform-h0iy
// Drives real Chromium with the built extension: a @demo-think task streams
// the demo provider's reasoning parts; the conversation must mount a
// COLLAPSED "Thinking trace" under the live-status row, stream it live
// (the count grows between samples), expand on click, auto-collapse when the
// answer's first token lands, and vanish at settle. A plain task shows no
// trace at all. Evidence screenshots land in test-artifacts/.

import { launchChrome, waitForServiceWorker } from "./lib/chrome-launch.ts";
import { chromeProfileDir } from "./lib/chrome-profile-dir.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = `${ROOT}extension`;
const ARTIFACTS = `${ROOT}test-artifacts`;

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)?.slice(0, 800)}`); }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const profile = chromeProfileDir("kat-thinking-trace");
const { proc, wsUrl } = await launchChrome({
  binary: "/usr/bin/chromium",
  args: [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--silent-debugger-extension-api",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    "--remote-allow-origins=*", "--window-size=1400,1200",
    `--user-data-dir=${profile}`, "about:blank"
  ],
});

const ws = new WebSocket(wsUrl);
await new Promise((r, j) => { ws.onopen = () => r(null); ws.onerror = j; });
let id = 0; const pending = new Map<string, (v: any) => void>();
ws.onmessage = (m: MessageEvent) => {
  const j = JSON.parse(m.data as string);
  if (j.id && pending.has(String(j.id))) { pending.get(String(j.id))!(j); pending.delete(String(j.id)); }
};
const send = (method: string, params: any = {}, sessionId?: string) => new Promise<any>((res) => {
  const mid = ++id; pending.set(String(mid), res);
  ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
});
const ev = async (sessionId: string, expression: string) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  return r.result?.result?.value;
};

async function shot(sessionId: string, name: string) {
  const r = await send("Page.captureScreenshot", { format: "png" }, sessionId);
  if (r.result?.data) await Deno.writeFile(`${ARTIFACTS}/${name}`, Uint8Array.from(atob(r.result.data), (c) => c.charCodeAt(0)));
}

// The trace's observable state in the NTP conversation.
const TRACE_STATE = `(() => {
  const conv = document.querySelector('agent-conversation');
  const trace = conv?.querySelector('.thinking-trace');
  const body = conv?.querySelector('.thinking-trace-body');
  const label = conv?.querySelector('.thinking-trace-label');
  return JSON.stringify({
    present: !!trace,
    open: trace?.dataset?.open ?? null,
    label: label?.textContent ?? null,
    bodyLen: body?.textContent?.length ?? 0,
    status: conv?.querySelector('.live-status')?.getAttribute('activity') ?? null,
  });
})()`;

try {
  await Deno.mkdir(ARTIFACTS, { recursive: true });
  const sw = await waitForServiceWorker((m, p) => send(m, p), { timeoutMs: 20000 });
  const extId = new URL(sw.url).host;
  // The demo provider: keyless, local, and (with @demo-think) a paced
  // reasoning stream. The demo model resolves ONLY under the developer flag
  // (a fresh profile runs the local assistant instead) — the journeys set it
  // via kv.set; do the same, from the NTP page we're about to open.
  const preT = await send("Target.createTarget", { url: `chrome-extension://${extId}/ntp/ntp.html` });
  const preS = (await send("Target.attachToTarget", { targetId: preT.result.targetId, flatten: true })).result.sessionId;
  await send("Runtime.enable", {}, preS);
  await sleep(1200);
  await ev(preS, `chrome.runtime.sendMessage({ type: "kv.set", values: { "cap:developerFeatures": true } })`);
  await send("Target.closeTarget", { targetId: preT.result.targetId });
  // provider.set is Settings-sender-only, so set it from a real options page
  // (the house rule: never from the NTP or a bare message).
  const optT = await send("Target.createTarget", { url: `chrome-extension://${extId}/options/options.html` });
  const opts = (await send("Target.attachToTarget", { targetId: optT.result.targetId, flatten: true })).result.sessionId;
  await send("Runtime.enable", {}, opts);
  await sleep(1500);
  const setRes = await ev(opts, `chrome.runtime.sendMessage(${JSON.stringify({ type: "provider.set", config: { provider: "demo", apiKey: "", baseURL: "", model: "" } })}).then(v => v, e => ({ err: String(e?.message ?? e) }))`);
  check("demo provider set from Settings", !!(setRes && (setRes.provider === "demo" || setRes.ok !== false)), setRes);
  await send("Target.closeTarget", { targetId: optT.result.targetId });
  const target = await send("Target.createTarget", { url: `chrome-extension://${extId}/ntp/ntp.html` });
  const targetId = target.result.targetId;
  const attached = await send("Target.attachToTarget", { targetId, flatten: true });
  const sessionId = attached.result.sessionId;
  await send("Runtime.enable", {}, sessionId);
  await send("Page.enable", {}, sessionId);
  await sleep(2500);

  // ── Run 1: @demo-think — the thinking trace lifecycle ──
  await ev(sessionId, `(() => {
    const c = document.querySelector('#thread-conversation');
    window.__collapses = [];
    const orig = c.collapseThinkingTrace.bind(c);
    c.collapseThinkingTrace = () => { window.__collapses.push(Date.now()); return orig(); };
    return true;
  })()`);
  await ev(sessionId, `(() => {
    const input = document.querySelector('#composer #task-input');
    input.value = '@demo-think sum this up';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#composer #run-task').click();
    return true;
  })()`);

  // Poll fast (30 ms): the paced thinking window is ~800 ms before the answer
  // starts. On FIRST sighting the trace must be collapsed; expand it at once
  // (mid-thinking) and keep sampling so the answer-start auto-collapse lands
  // on an element the user had open.
  let firstSeen: any = null;
  let expandedMidThinking: any = null;
  let grewFrom = -1, grewTo = -1;
  let autoCollapsed = false;
  const samples: string[] = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 10000) {
    const s = JSON.parse(await ev(sessionId, TRACE_STATE) ?? "{}");
    samples.push(`${Date.now() - t0}:${s.status ?? "-"}|open=${s.open}|len=${s.bodyLen}`);
    if (s.present && !firstSeen) {
      firstSeen = s;
      grewFrom = s.bodyLen;
      // Expand immediately — still mid-thinking.
      expandedMidThinking = JSON.parse(await ev(sessionId, `(() => {
        const toggle = document.querySelector('agent-conversation .thinking-trace-toggle');
        if (!toggle) return null;
        toggle.click();
        return ${TRACE_STATE};
      })()`) ?? "null");
      await shot(sessionId, "h0iy-thinking-trace-expanded.png");
    } else if (firstSeen && s.present && grewTo < 0 && s.bodyLen > grewFrom) {
      grewTo = s.bodyLen;
    }
    // The lifecycle rule: the user-expanded trace auto-collapses the moment
    // the answer's first visible token lands.
    if (firstSeen && s.present && s.open === "false" && s.status && /Writing the answer/.test(s.status)) {
      autoCollapsed = true;
      break;
    }
    // Settled before the transition was sampled (shouldn't happen mid-window).
    if (firstSeen && s.status === null) break;
    await sleep(30);
  }

  check("the thinking trace mounts when the provider streams thinking", firstSeen?.present === true, firstSeen);
  check("the trace is COLLAPSED by default", firstSeen?.open === "false", firstSeen);
  check("the trace label carries a live character count", typeof firstSeen?.label === "string" && /Thinking · \d+ characters/.test(firstSeen.label), firstSeen);
  check("the trace streams LIVE (the count grows between samples)", grewFrom >= 0 && grewTo > grewFrom, { grewFrom, grewTo });
  check("clicking the toggle expands the trace mid-thinking", expandedMidThinking?.open === "true", expandedMidThinking);
  check("the expanded body holds the streamed thinking text", (expandedMidThinking?.bodyLen ?? 0) > 20, expandedMidThinking);
  check("the trace auto-collapses when the answer starts streaming", autoCollapsed, samples.slice(-30));

  // Settle: the live-status row and the trace both go (the trace is live-only).
  let settled = false;
  const t2 = Date.now();
  while (Date.now() - t2 < 12000) {
    const s = JSON.parse(await ev(sessionId, TRACE_STATE) ?? "{}");
    if (s.status === null) { settled = s.present === false; break; }
    await sleep(250);
  }
  check("the trace is dropped when the run settles (live-only, never persisted)", settled);

  // ── Run 2: a plain task — no thinking tokens, no trace surface ──
  await ev(sessionId, `(() => {
    const input = document.querySelector('#composer #task-input');
    input.value = 'just a plain question';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#composer #run-task').click();
    return true;
  })()`);
  let traceSeenOnPlainRun = false;
  const t3 = Date.now();
  while (Date.now() - t3 < 10000) {
    const s = JSON.parse(await ev(sessionId, TRACE_STATE) ?? "{}");
    if (s.present) { traceSeenOnPlainRun = true; break; }
    if (s.status === null && Date.now() - t3 > 1500) break; // settled without a trace
    await sleep(100);
  }
  check("a run without thinking tokens shows NO trace surface", traceSeenOnPlainRun === false);

  await send("Target.closeTarget", { targetId });
} finally {
  try { proc.kill("SIGKILL"); } catch { /* gone */ }
  try { await proc.status; } catch { /* reaped */ }
  await Deno.remove(profile, { recursive: true }).catch(() => {});
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
if (fail > 0) Deno.exit(1);
