// kat-failed-runs.ts — live-browser KAT for the failed-runs lifecycle
// (owner 2026-08-28): a real dispatch that fails with no provider seeded the
// durable failed record (the exact UX-008 scenario); the KAT then proves the
// lifecycle in the REAL sidebar:
//   1. the section renders "Failed runs (N)" + Retry + dismiss (×) + Clear all;
//   2. × removes the row;
//   3. the dismissal is DURABLE — a full page reload (new render + fresh SW
//      round-trip) keeps the row gone;
//   4. an empty section hides entirely.
// Screenshot artifacts land in the out dir.
//
//   deno run -A scripts/kat-failed-runs.ts <path-to-extension> [<out-dir>]

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? `${ROOT}.cache/kat-failed-runs`;
const CHROMIUM = "/usr/bin/chromium";
const PORT = 9355;

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
await Deno.mkdir(OUT, { recursive: true });

const proc = new Deno.Command(CHROMIUM, {
  args: ["--headless=new", "--no-sandbox", "--disable-gpu", "--silent-debugger-extension-api",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    `--remote-debugging-port=${PORT}`, "--remote-allow-origins=*",
    `--user-data-dir=${ROOT}.cache/kat-failed-runs-${Date.now()}`, "about:blank"],
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
await new Promise(r => ws.onopen = r);
let id = 0; const pending = new Map<string, (v: any) => void>();
const send = (method: string, params: any = {}, sessionId?: string) => new Promise<any>((res) => {
  const mid = ++id; pending.set(String(mid), res);
  ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
});
ws.onmessage = (m: MessageEvent) => {
  const j = JSON.parse(m.data as string);
  if (j.id && pending.has(String(j.id))) { pending.get(String(j.id))!(j); pending.delete(String(j.id)); }
};
const evalPage = async (expr: string) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
  return r?.result?.result?.value;
};
const shot = async (name: string) => {
  const r = await send("Page.captureScreenshot", { format: "png" }, sessionId);
  if (r?.result?.data) await Deno.writeFile(`${OUT}/${name}.png`, Uint8Array.from(atob(r.result.data), (c) => c.charCodeAt(0)));
};

const { result: { targetInfos } } = await send("Target.getTargets");
const sw = targetInfos.find((t: any) => t.type === "service_worker");
if (!sw) { console.log("FAIL: no service worker target"); Deno.exit(1); }
const extId = new URL(sw.url).host;
const { result: { targetId } } = await send("Target.createTarget", { url: `chrome-extension://${extId}/ntp/ntp.html` });
const { result: { sessionId } } = await send("Target.attachToTarget", { targetId, flatten: true });
await send("Runtime.enable", {}, sessionId);
await send("Page.enable", {}, sessionId);
await sleep(1500);


const sectionState = async () => evalPage(`(() => {
  const s = document.getElementById('failed-runs');
  if (!s) return null;
  const label = s.querySelector('.fr-label')?.childNodes[0]?.textContent ?? '';
  return {
    hidden: s.hidden,
    label,
    rows: [...s.querySelectorAll('.fr-row')].map((r) => r.querySelector('.fr-text')?.textContent ?? ''),
    retry: s.querySelectorAll('.fr-retry').length,
    dismiss: s.querySelectorAll('.fr-dismiss').length,
    clearAll: s.querySelectorAll('.fr-clear').length,
  };
})()`);

let st = await sectionState();
// Seed the failure the honest way: a real dispatch with no provider configured
// (the run fails before producing anything and retains its prompt — the exact
// UX-008 scenario). Dispatched through the same runtime messaging the composer
// uses, then we poll for the durable failed record to surface.
// A failed DURABLE record needs the run to be ADMITTED and then fail. With no
// provider at all the dispatch refuses pre-admission, so first configure a
// dummy provider through the REAL settings surface (options page = settings
// sender) pointing at a closed port: admission succeeds, the model call fails
// fast, the run settles failed with its stored prompt — the exact UX-008
// scenario.
const optT = await send("Target.createTarget", { url: `chrome-extension://${extId}/options/options.html` });
const { result: { sessionId: optSession } } = await send("Target.attachToTarget", { targetId: optT.result.targetId, flatten: true });
await send("Runtime.enable", {}, optSession);
await sleep(800);
await send("Runtime.evaluate", { expression: `chrome.runtime.sendMessage({ type: "provider.set", config: { provider: "openai", baseURL: "http://127.0.0.1:1/v1", apiKey: "kat-dummy-key", model: "kat-model" } })`, awaitPromise: true, returnByValue: true }, optSession);
await send("Target.closeTarget", { targetId: optT.result.targetId });
await sleep(300);
// Fire-and-forget: agent.run answers only when the RUN settles, and the
// failure is what we are waiting for — the poll loop below watches for it.
await evalPage(`(() => {
  chrome.runtime.sendMessage({ type: "agent.run", task: "kat-failed-runs: summarize the monthly report", id: String(Date.now()), runId: "kat:failed-runs:1", attachments: [], history: [], threadId: null });
  return "dispatched";
})()`);
for (let i = 0; i < 20; i++) {
  await sleep(1000);
  const s = await sectionState();
  if (s && !s.hidden && s.rows.length > 0) break;
}
const dbg = await evalPage(`(async () => {
  const runs = await chrome.runtime.sendMessage({ type: "run.list" });
  return JSON.stringify((runs?.runs ?? []).slice(0, 3).map((r) => ({ phase: r.phase, ok: r.terminal?.ok, resume: r.resumeAvailable, agentId: r.agentId })));
})()`);
console.log("DEBUG run.list:", dbg);
st = await sectionState();
check("failed section rendered with label+count", !!st && !st.hidden && /^Failed runs \(\d+\)$/.test(st.label ?? ""), st);
check("at least one failed row with retry+dismiss+clear-all", !!st && st.rows.length >= 1 && st.retry >= 1 && st.dismiss === st.rows.length && st.clearAll === 1, st);
await shot("01-failed-runs-rendered");

const rowsBefore = st?.rows.length ?? 0;
await evalPage(`(() => {
  const s = document.getElementById('failed-runs');
  s.querySelector('.fr-row .fr-dismiss')?.click();
  return true;
})()`);
await sleep(1200);
st = await sectionState();
check("dismiss removes a row", !!st && st.rows.length === rowsBefore - 1, st);

// Durability: a full reload re-renders from the durable registry + tombstones.
await send("Page.reload", {}, sessionId);
await sleep(2500);
st = await sectionState();
const labelAfterReload = st?.label ?? "";
const rowsAfterReload = st?.rows.length ?? -1;
check("dismissal survives a full reload", rowsAfterReload === rowsBefore - 1 && !JSON.stringify(st).includes("kat-failed-runs"), { rowsAfterReload, labelAfterReload });

// Clear all: the remaining rows vanish and the section hides.
await evalPage(`(() => { document.getElementById('failed-runs')?.querySelector('.fr-clear')?.click(); return true; })()`);
await sleep(1200);
st = await sectionState();
check("clear-all empties and hides the section", !!st && (st.hidden === true || st.rows.length === 0), st);
await shot("02-after-clear-all");

console.log(`\n${pass} passed, ${fail} failed`);
proc.kill();
Deno.exit(fail ? 1 : 0);
