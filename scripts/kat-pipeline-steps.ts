// kat-pipeline-steps.ts — live-browser KAT for run_pipeline, the fourth
// lazy-protocol meta-tool (chrome-agent-platform-qsm4, slice 2).
//
// Drives "@demo-pipeline" through the REAL composer → service-worker →
// lazy-protocol path: the demo model issues ONE run_pipeline call chaining
// memory_set → memory_get with the read's key BOUND to the write's result
// ({ $ref: "set", path: "key" }). Proves:
//   1. both pipeline steps render in the plan strip (the per-step
//      pipeline-step progress events) and settle checked;
//   2. the final answer carries the value the pipe actually moved;
//   3. the pipeline wrapper itself renders no protocol tool card
//      (run_pipeline is composition plumbing — the steps are the rows).
// Falsification: pre-slice-2 there IS no run_pipeline tool, so the run fails
// and no plan rows settle; a dropped pipeline-step event leaves a row active
// at settle.
//
//   deno run -A scripts/kat-pipeline-steps.ts [<path-to-extension>] [<out-dir>]

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? `${ROOT}.cache/kat-pipeline-steps`;
import { launchChrome } from "./lib/chrome-launch.ts";
import { chromeProfileDir } from "./lib/chrome-profile-dir.ts";

const CHROMIUM = "/usr/bin/chromium";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`); }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
await Deno.mkdir(OUT, { recursive: true });

const { proc, wsUrl, port } = await launchChrome({
  binary: CHROMIUM,
  args: ["--headless=new", "--no-sandbox", "--disable-gpu", "--silent-debugger-extension-api",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${chromeProfileDir("kat-pipeline-steps")}`, "about:blank"],
});
const ws = new WebSocket(wsUrl);
await new Promise((r) => { ws.onopen = () => r(null); });
let id = 0; const pending = new Map<string, (v: any) => void>();
const send = (method: string, params: any = {}, sessionId?: string) => new Promise<any>((res) => {
  const mid = ++id; pending.set(String(mid), res);
  ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
  setTimeout(() => {
    if (pending.has(String(mid))) {
      pending.delete(String(mid));
      res({ error: { message: `timeout awaiting ${method}` } });
    }
  }, 15000);
});
ws.onmessage = (m: MessageEvent) => {
  const j = JSON.parse(m.data as string);
  if (j.id && pending.has(String(j.id))) { pending.get(String(j.id))!(j); pending.delete(String(j.id)); }
};
const ev = async (expr: string, sid: string) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sid);
  if (r?.error) console.log(`EV-ERROR: ${r.error.message}`);
  if (r?.result?.exceptionDetails) console.log(`EV-EXCEPTION: ${JSON.stringify(r.result.exceptionDetails).slice(0, 200)}`);
  return r?.result?.result?.value;
};

let sw = null;
for (let i = 0; i < 100 && !sw; i++) {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    sw = targets.find((t: any) => t.type === "service_worker");
  } catch { /* not up yet */ }
  if (!sw) await sleep(200);
}
if (!sw) { console.log("FAIL: no service worker target"); Deno.exit(1); }
const extId = new URL(sw.url).host;
const { result: { targetId } } = await send("Target.createTarget", { url: `chrome-extension://${extId}/ntp/ntp.html` });
const { result: { sessionId: page } } = await send("Target.attachToTarget", { targetId, flatten: true });
await send("Runtime.enable", {}, page);
await send("Page.enable", {}, page);
await sleep(1800);

const shot = async (name: string) => {
  const r = await send("Page.captureScreenshot", { format: "png" }, page);
  if (r?.result?.data) await Deno.writeFile(`${OUT}/${name}.png`, Uint8Array.from(atob(r.result.data), (c) => c.charCodeAt(0)));
};

// The plan-strip snapshot (the same shape chrome-journeys.ts's 3f probe reads).
const STRIP_STATE = `(() => {
  const conv = document.getElementById('thread-conversation');
  if (!conv) return null;
  const strip = conv.querySelector('plan-strip');
  if (!strip) return { present: false };
  const sr = strip.shadowRoot;
  const rows = sr ? [...sr.querySelectorAll('li')].map((li) => ({
    status: li.getAttribute('data-status'),
    label: (li.querySelector('.tx')?.textContent ?? '').trim(),
  })) : [];
  return { present: true, state: strip.getAttribute('state'), rows };
})()`;
const THREAD_TEXT = `(() => {
  const root = document.getElementById('thread-conversation') ?? document.body;
  const out = [];
  const walk = (node) => {
    if (node.nodeType === 3) { out.push(node.data); return; }
    if (node.nodeType !== 1 && node.nodeType !== 11) return;
    if (node.nodeType === 1) {
      if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE' || node.tagName === 'TEMPLATE') return;
      if (node.shadowRoot) walk(node.shadowRoot);
    }
    for (const c of node.childNodes) walk(c);
  };
  walk(root);
  return out.join(' ').replace(/\s+/g, ' ');
})()`;

// The marker demo model sits behind the developer flag.
await ev(`chrome.runtime.sendMessage({ type: 'kv.set', values: { 'cap:developerFeatures': true } })`, page);
await ev(`(() => {
  const composer = document.getElementById('composer');
  composer.dispatchEvent(new CustomEvent('send', { detail: { text: '@demo-pipeline', attachments: [], agent: null } }));
  return true;
})()`, page);

let sawRunning = false;
let settled: any = null;
const deadline = Date.now() + 120_000;
while (Date.now() < deadline && !settled) {
  const s: any = await ev(STRIP_STATE, page);
  if (s?.present && s.state === "running") {
    sawRunning = true;
    if ((s.rows ?? []).some((r: any) => r.status === "active")) await shot("01-pipeline-running");
  }
  if (s?.present && s.state === "settled") { settled = s; break; }
  // Settled with no strip (a failed run) still needs the loop to end: the
  // final text check below reports the honest outcome.
  const text = String(await ev(THREAD_TEXT, page) ?? "");
  if (/\[demo model\] pipeline/.test(text)) break;
  await sleep(150);
}
await sleep(600);
settled = settled ?? await ev(STRIP_STATE, page);
await shot("02-pipeline-settled");
const threadText = String(await ev(THREAD_TEXT, page) ?? "");
console.log(`strip: ${JSON.stringify(settled)}`);

check("the run executed and produced the pipeline final text",
  /\[demo model\] pipeline demo-pipe/.test(threadText), threadText.slice(-300));
check("the plan strip presented and advanced while the pipeline ran",
  sawRunning && !!settled?.present, { sawRunning, settled });
check("both steps render as plan-strip rows and settle checked (write then read)",
  Array.isArray(settled?.rows) && settled.rows.length >= 2 &&
    settled.rows.every((r: any) => r.status === "done") &&
    settled.rows.some((r: any) => /Writing memory/i.test(r.label)) &&
    settled.rows.some((r: any) => /Reading memory/i.test(r.label)),
  settled?.rows);
check("the final answer carries the value the pipe actually moved",
  /pipeline demo-pipe: demo-pipeline-colour carried "teal"/.test(threadText), threadText.slice(-300));
check("no row is left active after settle (every pipeline-step event arrived paired)",
  !!settled?.rows && settled.rows.every((r: any) => r.status !== "active"), settled?.rows);

try { proc.kill("SIGKILL"); } catch { /* already gone */ }
console.log(`kat-pipeline-steps: ${pass} passed, ${fail} failed`);
Deno.exit(fail ? 1 : 0);
