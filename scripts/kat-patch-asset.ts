// kat-patch-asset.ts — live-browser KAT for the patch_asset search/replace tool
// (CAP-FB-20260830-PATCH-ASSET-TOOL-01), proven against the LOADED extension.
//
// Drives a REAL run through the REAL composer → service-worker pipeline with the
// scripted demo provider ("@demo-patch-artifact"): create crumb.html, then change
// ONE brand colour with patch_asset (a few bytes of args, not the whole body),
// approve the owner card with a real click, then a SECOND patch with a stale
// expectVersion that must be refused as version_conflict WITHOUT mutating. Proves:
//   1. the patch turn completes (the honest final text lands);
//   2. the patch_asset arguments the model sent are UNDER 400 bytes (the whole
//      point: an edit is not a whole-file rewrite) — measured from the thread's
//      own tool card;
//   3. the applied patch reports +1 -1 (one line changed);
//   4. a stale expectVersion is refused as version_conflict, and the stored body
//      changed EXACTLY once: it carries the new colour (#2563eb), never the stale
//      re-edit's colour (#16a34a) nor the original (#b91c1c), and the head
//      version advanced to 2 (only the first patch landed).
// Falsification: check 2 fails if the flow rewrote the whole body (update_asset);
// check 4 fails if the stale patch mutated the artifact or advanced the version.
//
//   deno run -A scripts/kat-patch-asset.ts [<path-to-extension>] [<out-dir>]

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? `${ROOT}.cache/kat-patch-asset`;
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

try { await Deno.stat(`${EXT}/dist/background/service-worker.js`); } catch {
  console.log("FAIL: extension is not built (missing dist/background/service-worker.js) — run npm run build first");
  Deno.exit(1);
}

// Kernel-assigned debugging port, read back from THIS Chrome by the shared
// launcher (CAP-FB-20260829-FIXED-DEBUG-PORTS-01).
const { proc, wsUrl, port } = await launchChrome({
  binary: CHROMIUM,
  args: ["--headless=new", "--no-sandbox", "--disable-gpu", "--silent-debugger-extension-api",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${chromeProfileDir("kat-patch-asset")}`, "about:blank"],
});
const ws = new WebSocket(wsUrl);
await new Promise((r) => { ws.onopen = () => r(null); });
let id = 0; const pending = new Map<string, (v: any) => void>();
const send = (method: string, params: any = {}, sessionId?: string) => new Promise<any>((res) => {
  const mid = ++id; pending.set(String(mid), res);
  ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
  setTimeout(() => {
    if (pending.has(String(mid))) { pending.delete(String(mid)); res({ error: { message: `timeout awaiting ${method}` } }); }
  }, 15000);
});
const swLog: string[] = [];
ws.onmessage = (m: MessageEvent) => {
  const j = JSON.parse(m.data as string);
  if (j.id && pending.has(String(j.id))) { pending.get(String(j.id))!(j); pending.delete(String(j.id)); }
  else if (j.method === "Runtime.consoleAPICalled") {
    const line = (j.params?.args ?? []).map((a: any) => a?.value ?? a?.description ?? "").join(" ");
    if (/selection|approval|patch|expired|expectVersion|version_conflict/i.test(line)) swLog.push(line.slice(0, 200));
  }
};
const ev = async (expr: string, sid: string) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sid);
  if (r?.error) console.log(`EV-ERROR: ${r.error.message}`);
  if (r?.result?.exceptionDetails) console.log(`EV-EXCEPTION: ${JSON.stringify(r.result.exceptionDetails).slice(0, 200)}`);
  return r?.result?.result?.value;
};

let sw = null;
for (let i = 0; i < 100 && !sw; i++) {
  try { sw = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t: any) => t.type === "service_worker"); }
  catch { /* not up yet */ }
  if (!sw) await sleep(200);
}
if (!sw) { console.log("FAIL: no service worker target"); proc.kill(); Deno.exit(1); }
const extId = new URL(sw.url).host;
// Attach the debugger to the MV3 service worker so it is NOT suspended during
// the owner-approval pause — a suspended worker drops its in-memory tool
// selections and pending approvals, and the approved tool then fails with
// "selection-missing-or-expired" (the journey suite keeps the SW alive the same
// way). CAP-FB-20260830-PATCH-ASSET-TOOL-01.
try {
  const swAttach = await send("Target.attachToTarget", { targetId: sw.id ?? sw.targetId, flatten: true });
  const swSession = swAttach?.result?.sessionId;
  if (swSession) { await send("Runtime.enable", {}, swSession); await send("Runtime.runIfWaitingForDebugger", {}, swSession); }
} catch { /* best-effort keepalive */ }
const { result: { targetId } } = await send("Target.createTarget", { url: `chrome-extension://${extId}/ntp/ntp.html` });
const { result: { sessionId: page } } = await send("Target.attachToTarget", { targetId, flatten: true });
await send("Runtime.enable", {}, page);
await send("Page.enable", {}, page);
// A headless page is not "focused", so navigator.userActivation.isActive stays
// false and the approval handler (which requires a live activation, not just a
// trusted event) bails. Force focus emulation + bring the tab to front so a real
// CDP click carries genuine user activation.
await send("Emulation.setFocusEmulationEnabled", { enabled: true }, page);
// A TALL viewport (matching chrome-journeys' --window-size=1400,2400) so the
// bottom-pinned live-status row does not overlap the approval card's approve
// button — a small default viewport stacks them and the click lands on the
// status overlay instead of the button.
await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 2400, deviceScaleFactor: 1, mobile: false }, page);
await send("Target.activateTarget", { targetId }).catch(() => {});
await send("Page.bringToFront", {}, page).catch(() => {});
await sleep(1800);

const shot = async (name: string) => {
  const r = await send("Page.captureScreenshot", { format: "png" }, page);
  if (r?.result?.data) await Deno.writeFile(`${OUT}/${name}.png`, Uint8Array.from(atob(r.result.data), (c) => c.charCodeAt(0)));
};

// A REAL element-centre mouse click (a trusted gesture — the owner activation
// the approval path checks); a synthetic .click() or a dispatched CustomEvent
// send leaves the run un-attributed and its approval never resolves.
const clickSel = async (selector: string) => {
  const b = await ev(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'center', inline: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`, page);
  if (!b || typeof b.x !== "number") return false;
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: b.x, y: b.y, button: "left", buttons: 1, clickCount: 1 }, page);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: b.x, y: b.y, button: "left", buttons: 0, clickCount: 1 }, page);
  return true;
};
const typeText = async (text: string) => {
  for (const ch of text) await send("Input.dispatchKeyEvent", { type: "char", text: ch, unmodifiedText: ch }, page);
};

// The marker demo model sits behind the developer flag
// (CAP-FB-20260830-KEYLESS-FIRST-RESULT-01).
await ev(`chrome.runtime.sendMessage({ type: 'kv.set', values: { 'cap:developerFeatures': true } })`, page);
await sleep(400);
// Drive the REAL hub composer with genuine input (the same path driveHubTask
// uses in chrome-journeys.ts) so the run is owner-activated for approval.
await clickSel("#home");
await sleep(500);
await clickSel("#task-input");
await typeText("@demo-patch-artifact change the bakery brand colour");
await sleep(150);
await clickSel("#run-task");

// Approve the single owner card (the first patch); the stale re-edit is refused
// before the gate so it never raises a card. A real click on the card's approve
// button is the same path the UI takes.
const THREAD_STATE = `(() => {
  const conv = document.getElementById('thread-conversation');
  if (!conv) return JSON.stringify({ ready: false });
  const cards = [...conv.querySelectorAll('approval-card')].map((c) => (c.getAttribute('state') || 'pending'));
  const agent = [...conv.querySelectorAll('message-bubble[role="agent"]')]
    .map((b) => (b.getAttribute('content') || '').trim()).filter((t) => t.length);
  const patchCards = [...conv.querySelectorAll('message-bubble[role="tool"]')]
    .filter((b) => (b.getAttribute('tool-name') || '') === 'patch_asset');
  const patchArgs = patchCards.map((b) => b.getAttribute('tool-args') || '');
  const patchResults = patchCards.map((b) => ({ status: b.getAttribute('tool-status'), result: b.getAttribute('tool-result'), detail: b.getAttribute('tool-detail') }));
  const finalText = agent.find((t) => /\\[demo model\\] Artifact patch/.test(t)) || '';
  return JSON.stringify({ ready: true, cards, patchArgs, patchResults, finalText, agentCount: agent.length });
})()`;
const readThread = async () => { try { return JSON.parse(await ev(THREAD_STATE, page) ?? "{}"); } catch { return {}; } };
// A GENUINE CDP mouse click on the approve button (a trusted gesture — a
// synthetic .click() causes the run to retry the tool, which then fails with a
// consumed selection). Mirrors the chrome-journeys clickShadow path.
const clickApprove = async () => {
  const b = await ev(`(() => {
    const card = [...document.querySelectorAll('#thread-conversation approval-card')].find((x) => (x.getAttribute('state') || 'pending') === 'pending');
    const el = card && (card.shadowRoot || card).querySelector('.approve');
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`, page);
  if (!b || typeof b.x !== "number") return false;
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: b.x, y: b.y }, page);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: b.x, y: b.y, button: "left", buttons: 1, clickCount: 1 }, page);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: b.x, y: b.y, button: "left", buttons: 0, clickCount: 1 }, page);
  await sleep(200);
  const state = await ev(`(() => { const c = [...document.querySelectorAll('#thread-conversation approval-card')].pop(); return c ? (c.getAttribute('state')||'pending') : 'none'; })()`, page);
  console.log(`patch KAT: approval card state after click = ${state}`);
  return true;
};

let approved = false;
let finalText = "";
let patchArgs: string[] = [];
const deadline = Date.now() + 90_000;
let midShot = false;
while (Date.now() < deadline) {
  const st = await readThread();
  if (!midShot && Array.isArray(st.cards) && st.cards.length) { midShot = true; await shot("01-approval-card"); }
  if (!approved && Array.isArray(st.cards) && st.cards.some((s: string) => s === "pending")) {
    approved = await clickApprove();
    console.log(`patch KAT: approval clicked = ${approved}`);
  }
  if (st.finalText) {
    finalText = st.finalText; patchArgs = st.patchArgs || [];
    console.log(`patch KAT: patch results = ${JSON.stringify(st.patchResults)}`);
    const allCards = await ev(`JSON.stringify([...document.querySelectorAll('#thread-conversation message-bubble[role="tool"]')].map((b)=>({name:b.getAttribute('tool-name'),status:b.getAttribute('tool-status'),args:(b.getAttribute('tool-args')||'').slice(0,120),result:(b.getAttribute('tool-result')||'').slice(0,160)})))`, page);
    console.log(`patch KAT: all tool cards = ${allCards}`);
    break;
  }
  await sleep(400);
}
await shot("02-patch-complete");

// Read the durable store through the page's own messaging (the SAME routes the
// UI uses); asset.list/get/versions are ungated reads.
const storeState = await ev(`(async () => {
  const call = (type, payload) => new Promise((res) => chrome.runtime.sendMessage({ type, ...payload }, (r) => res(r)));
  const list = await call('asset.list', { origin: 'master' });
  const crumb = (list.assets || []).find((a) => a.name === 'crumb.html');
  if (!crumb) return { found: false };
  const got = await call('asset.get', { origin: 'master', id: crumb.id });
  const versions = await call('asset.versions', { origin: 'master', id: crumb.id });
  return { found: true, id: crumb.id, content: got.asset?.content || '', head: versions.head };
})()`, page);

const argsBytes = patchArgs.map((a) => new TextEncoder().encode(a).byteLength);
const maxArgs = argsBytes.length ? Math.max(...argsBytes) : Infinity;

check("patch turn completed with the honest final text", /Artifact patch complete/.test(finalText), finalText);
check("owner approval card was approved with a real click", approved);
check("patch_asset arguments are under 400 bytes (an edit, not a whole-file rewrite)", maxArgs < 400, { argsBytes, patchArgs });
check("the applied patch reports +1 -1", /\(\+1 -1\)/.test(finalText), finalText);
check("a stale expectVersion was refused as version_conflict", /version_conflict/.test(finalText), finalText);
check("the stored body carries the NEW colour (#2563eb)", storeState.found === true && String(storeState.content).includes("#2563eb"), storeState);
check("the stale re-edit did NOT mutate (no #16a34a) and the original colour is gone (no #b91c1c)",
  storeState.found === true && !String(storeState.content).includes("#16a34a") && !String(storeState.content).includes("#b91c1c"), storeState);
check("only the first patch landed — the head version is 2", storeState.head === 2, storeState);

if (swLog.length) console.log(`SW log (filtered):\n  ${swLog.join("\n  ")}`);
console.log(`\nkat-patch-asset: ${pass} passed, ${fail} failed`);
try { ws.close(); } catch { /* ignore */ }
try { proc.kill(); } catch { /* ignore */ }
Deno.exit(fail === 0 ? 0 : 1);
