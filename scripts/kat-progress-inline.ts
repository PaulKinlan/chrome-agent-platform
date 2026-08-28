// kat-progress-inline.ts — live-browser KAT for the inline conversation
// live-status row (owner 2026-08-28: the run/step label belongs INLINE, pinned
// at the bottom of the chat; the separate banner that duplicated the running
// conversation entry is gone).
//
// Drives a REAL multi-step run through the REAL composer → service-worker
// pipeline (demo provider "@demo-slow @demo-tools": delayed first step, then
// memory_set → memory_get × 2 → final text — ≥2 observable status
// transitions), and proves:
//   1. while running, EXACTLY ONE conversation-run-status exists in the whole
//      document and it is a CHILD of the conversation (inline), sticky-pinned
//      to the bottom of the chat viewport;
//   2. the row's label UPDATES across ≥2 step transitions;
//   3. NO separate #run-status banner element exists;
//   4. no duplicate step/status text anywhere else in the conversation;
//   5. on completion the row RESOLVES (removed — the final conversation entry
//      is the resolution; no orphan chrome) and the final answer bubble exists;
//   6. axe: no violations on the live surface.
// Falsification: checks 1/3 fail on the old banner design (the banner is a
// sibling BELOW the conversation with id="run-status"); check 5 fails if the
// completed state leaves the row rendered.
//
//   deno run -A scripts/kat-progress-inline.ts [<path-to-extension>] [<out-dir>]

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? `${ROOT}.cache/kat-progress-inline`;
const CHROMIUM = "/usr/bin/chromium";
// Unique port per run: a killed KAT leaves its chromium holding the port, and
// a stale instance answers /json/* with the WRONG (extension-less) browser.
const PORT = 9300 + (Date.now() % 600);

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
    `--user-data-dir=${ROOT}.cache/kat-progress-inline-${Date.now()}`, "about:blank"],
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
  // Never let a lost response hang the harness: resolve with an error marker.
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
  else if (j.method === "Inspector.targetCrashed") console.log("RENDERER CRASHED (Inspector.targetCrashed)");
  else if (j.method === "Inspector.detached") console.log(`SESSION DETACHED: ${JSON.stringify(j.params).slice(0, 120)}`);
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
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
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

// The row reader: everything about the live-status surface in one snapshot.
const ROW_SNAPSHOT = `(() => {
  const rows = [...document.querySelectorAll('conversation-run-status')];
  const row = rows.find(r => r.classList.contains('live-status')) ?? null;
  const conv = document.getElementById('thread-conversation');
  const oldBanner = document.getElementById('run-status');
  return {
    totalStatusEls: rows.length,
    rowPresent: !!row,
    rowInsideConversation: !!(row && conv && conv.contains(row)),
    rowSticky: row ? getComputedStyle(row).position === 'sticky' : false,
    rowIsLastChild: !!(row && conv && conv.lastElementChild === row),
    rowState: row?.getAttribute('state') ?? null,
    rowLabel: row?.getAttribute('activity') ?? row?.textContent?.trim()?.slice(0, 80) ?? null,
    oldBannerExists: !!oldBanner,
  };
})()`;

// Idle baseline: nothing renders.
const idle = await ev(ROW_SNAPSHOT, page);
check("idle: no status row and no banner when nothing runs", idle?.rowPresent === false && idle?.oldBannerExists === false, idle);

// Drive a REAL run through the REAL composer (the demo provider's
// deterministic tool-calling mode gives ≥2 step transitions; @demo-slow opens
// a mid-run observation window on the first step).
await ev(`(() => {
  const composer = document.getElementById('composer');
  composer.dispatchEvent(new CustomEvent('send', { detail: { text: '@demo-slow @demo-tools pack the archive', attachments: [], agent: null } }));
  return true;
})()`, page);

// Poll through the run: collect the row's observable label at each tick and,
// while the row is live, count duplicate carriers of its text (folded into the
// same run — a second dispatched run would race the first).
const labels: string[] = [];
let sawInline = false, sawSticky = false, sawLastChild = false, sawOldBanner = false, sawMultiRows = false, sawRowOutside = false;
let dupDetail: unknown = null;
let dupOk = false;
let done = false;
let midShot = false;
const deadline = Date.now() + 360_000;
while (Date.now() < deadline && !done) {
  const s = await ev(ROW_SNAPSHOT, page);
  if (s) {
    if (s.rowPresent && !midShot) { midShot = true; await shot("00-during-run"); }
    if (s.totalStatusEls > 1) sawMultiRows = true;
    if (s.oldBannerExists) sawOldBanner = true;
    if (s.rowPresent) {
      if (s.rowInsideConversation) sawInline = true; else sawRowOutside = true;
      if (s.rowSticky) sawSticky = true;
      if (s.rowIsLastChild) sawLastChild = true;
      if (s.rowLabel && labels[labels.length - 1] !== s.rowLabel) labels.push(s.rowLabel);
      if (!dupOk && s.rowLabel && String(s.rowLabel).length >= 4) {
        const d = await ev(`(() => {
          const row = document.querySelector('#thread-conversation conversation-run-status.live-status');
          const label = row?.getAttribute('activity') ?? '';
          if (!label) return null;
          const carriers = [...document.querySelectorAll('#thread-conversation message-bubble, #thread-conversation [class*="status"]')]
            .filter(el => el !== row && (el.textContent ?? '').includes(label));
          return { label, carriers: carriers.length };
        })()`, page);
        if (d) { dupDetail = d; dupOk = d.carriers === 0; if (!dupOk) { dupDetail = d; } }
      }
    }
    // Completion: the final agent answer bubble exists and the row resolved.
    const finished = await ev(`(() => {
      const conv = document.getElementById('thread-conversation');
      const bubbles = [...conv.querySelectorAll('message-bubble')];
      return bubbles.some(b => b.getAttribute('role') === 'agent' && (b.getAttribute('content') ?? '').length > 0);
    })()`, page);
    if (finished) { await sleep(600); done = true; }
  }
  await sleep(150);
}
check("a run actually completed (final agent bubble rendered)", done);
await shot("01-after-completion");
check("running: exactly ONE status surface at every tick (never 2+ rows)", done && !sawMultiRows);
check("running: the status row is INLINE (a child of the conversation)", sawInline && !sawRowOutside);
check("running: the row is sticky-pinned at the conversation bottom", sawSticky);
check("running: the row is the conversation's LAST child (bottom of the flow)", sawLastChild);
check("the old separate #run-status banner NEVER appears", !sawOldBanner);
check("the label UPDATES across >=2 step transitions", labels.length >= 2, { labels });
check("no duplicate step/status text anywhere else in the conversation", dupOk, dupDetail);

// The row must RESOLVE on completion (removed — no orphan chrome).
const settled = await ev(ROW_SNAPSHOT, page);
check("completion: the inline row RESOLVES (removed, nothing renders when idle)", settled?.rowPresent === false, settled);

// axe on the settled thread surface.
try {
  const axeRes = await fetch("https://cdn.jsdelivr.net/npm/axe-core@4.10.2/axe.min.js");
  const axeSrc = await axeRes.text();
  await send("Runtime.evaluate", { expression: axeSrc }, page);
  const axeOut = await ev(`axe.run(document, { resultTypes: ['violations'] }).then(r => r.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => (n.target || []).join(' ')) })))`, page);
  const relevant = (axeOut ?? []).filter((v: any) => (v.nodes ?? []).some((n: string) => n.includes("live-status") || n.includes("thread-conversation")));
  check("axe: no violations on the conversation/status surface", relevant.length === 0, relevant);
} catch (e) {
  console.log(`NOTE: axe injection unavailable (${String(e).slice(0, 80)}) — structural checks stand.`);
}

console.log(`\nkat-progress-inline: ${pass} passed, ${fail} failed`);
try { proc.kill(); } catch { /* already exited */ }
// Never leave the chromium child holding the port (killed runs strand it).
try { proc.kill("SIGKILL"); } catch { /* already exited */ }
Deno.exit(fail === 0 ? 0 : 1);
