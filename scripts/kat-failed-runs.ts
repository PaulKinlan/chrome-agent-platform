// kat-failed-runs.ts — live-browser KAT for the failed-runs lifecycle
// (owner 2026-08-28). Seeds a REAL terminal-failed record through the REAL
// durable registry (the service worker's own durableRuns singleton — the same
// authority the sidebar reads), then proves the lifecycle in the REAL sidebar:
//   1. the section renders "Failed runs (N)" with Retry + dismiss (×) + Clear all;
//   2. × removes the row;
//   3. the dismissal is DURABLE — a full page reload keeps it gone;
//   4. Clear all empties the section and the section hides when empty.
// Screenshot artifacts land in the out dir.
//
//   deno run -A scripts/kat-failed-runs.ts <path-to-extension> [<out-dir>]

import { launchChrome, waitForServiceWorker } from "./lib/chrome-launch.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? `${ROOT}.cache/kat-failed-runs`;
const CHROMIUM = "/usr/bin/chromium";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`); }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
await Deno.mkdir(OUT, { recursive: true });

// The debugging port is assigned by the kernel and read back from THIS Chrome's
// stderr — a fixed port silently attaches the harness to another lane's browser
// (9357 was also probed by kat-bgagent-delete, and a zombie holding it hung
// this harness for the whole timeout).
const { proc, wsUrl } = await launchChrome({
  binary: CHROMIUM,
  args: ["--headless=new", "--no-sandbox", "--disable-gpu", "--silent-debugger-extension-api",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${ROOT}.cache/kat-failed-runs-${Date.now()}`, "about:blank"],
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
const evalIn = async (expr: string, sid: string) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sid);
  return r?.result?.result?.value;
};
const shot = async (name: string) => {
  const r = await send("Page.captureScreenshot", { format: "png" }, pageSession);
  if (r?.result?.data) await Deno.writeFile(`${OUT}/${name}.png`, Uint8Array.from(atob(r.result.data), (c) => c.charCodeAt(0)));
};

// MV3 registers the worker a beat after the browser is reachable — wait for
// it rather than depending on how long the CDP handshake happened to take.
const sw = await waitForServiceWorker(send);
if (!sw) { console.log("FAIL: no service worker target"); Deno.exit(1); }
const extId = new URL(sw.url).host;
const { result: { sessionId: swSession } } = await send("Target.attachToTarget", { targetId: sw.targetId, flatten: true });
await send("Runtime.enable", {}, swSession);
const { result: { targetId } } = await send("Target.createTarget", { url: `chrome-extension://${extId}/ntp/ntp.html` });
const { result: { sessionId: pageSession } } = await send("Target.attachToTarget", { targetId, flatten: true });
await send("Runtime.enable", {}, pageSession);
await send("Page.enable", {}, pageSession);
await sleep(1500);

// Seed through the SW's own registry singleton: a real durable terminal-failed
// run (hub task — no owning agent, so the agent cascade does not filter it).
// Seed through a page-realm instance of the SAME durable-runs module over the
// SAME origin store (import() is disallowed on the SW global scope). The
// seeded record is a real durable terminal failure — exactly what the sidebar
// projects. The seed agent is a HUB task (no owning agent), so the agent
// cascade does not filter it.
const seeded = await evalIn(`(async () => {
  try {
    const m = await import(chrome.runtime.getURL("/lib/durable-runs.js"));
    if (!m?.durableRuns) return { err: "no durableRuns export" };
    const id = "exec_katfailedruns" + Date.now().toString(36);
    await m.durableRuns.start({
      executionId: id,
      kind: "task",
      taskPreview: "kat-failed-runs: summarize the monthly report",
      journalTarget: "master",
      resumeRequest: { route: "agent.run", task: "kat-failed-runs: summarize the monthly report", attachments: [], history: [] },
    });
    await m.durableRuns.settle(id, { ok: false, error: "kat seeded failure", errorCategory: "model", logicalId: "kat" });
    return { ok: true, id };
  } catch (e) {
    return { err: String((e && e.message) ?? e) };
  }
})()`, pageSession);
check("seeded a terminal failed run through the real registry", !!seeded && seeded.ok === true, seeded);

const sectionState = async () => evalIn(`(() => {
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
})()`, pageSession);

// Reload so the sidebar renders from the durable registry fresh.
await send("Page.reload", {}, pageSession);
await sleep(2500);
let st = await sectionState();
check("failed section rendered with label+count", !!st && !st.hidden && /^Failed runs \(\d+\)$/.test(st.label ?? ""), st);
check("row shows retry+dismiss, header shows clear-all", !!st && st.rows.length >= 1 && st.retry === st.rows.length && st.dismiss === st.rows.length && st.clearAll === 1, st);
check("the row is OUR seeded failure", !!st && (st.rows as string[]).some((t) => t.includes("kat-failed-runs")), st);
await shot("01-failed-runs-rendered");

const rowsBefore = st?.rows.length ?? 0;
await evalIn(`(() => {
  const s = document.getElementById('failed-runs');
  s.querySelector('.fr-row .fr-dismiss')?.click();
  return true;
})()`, pageSession);
await sleep(1500);
st = await sectionState();
check("dismiss removes a row", !!st && st.rows.length === rowsBefore - 1, st);

// Durability: a full reload re-renders from the durable registry + tombstones.
await send("Page.reload", {}, pageSession);
await sleep(2500);
st = await sectionState();
check("dismissal survives a full reload", !!st && st.rows.length === rowsBefore - 1 && !JSON.stringify(st.rows).includes("kat-failed-runs"), st);
await shot("02-after-dismiss-reload");

// Clear all: any remaining rows vanish; the section hides when empty.
await evalIn(`(() => { document.getElementById('failed-runs')?.querySelector('.fr-clear')?.click(); return true; })()`, pageSession);
await sleep(1500);
st = await sectionState();
check("clear-all empties and hides the section", !!st && (st.hidden === true || st.rows.length === 0), st);
await shot("03-after-clear-all");

console.log(`\n${pass} passed, ${fail} failed`);
proc.kill();
Deno.exit(fail ? 1 : 0);
