// Gate screenshots: hint-link focus ring + first-run-guide tab order.
import { launchChrome } from "./lib/chrome-launch.ts";
const ROOT = new URL("..", import.meta.url).pathname;
const EXT = `${ROOT}extension`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fetchJson = async (url: string, opts: RequestInit = {}) => (await fetch(url, opts)).json();
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};
const profile = await Deno.makeTempDir({ prefix: "cap-focus-shots-" });
// The shared launcher: kernel-assigned debugging port, the DevTools endpoint
// read from THIS child's own stderr; the environment is cleared as before.
const chrome = await launchChrome({ extension: EXT, profile, windowSize: "1400,900", clearEnv: true });
const proc = chrome.proc;
const port = chrome.port;
const ws = new WebSocket(chrome.wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let idc = 0; const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
ws.onmessage = (ev) => { const msg = JSON.parse(String(ev.data)); if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id)!; pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); } };
const send = (method: string, params: unknown = {}, sessionId?: string): Promise<any> => new Promise((resolve, reject) => { const id = ++idc; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
const evl = async (s: string, expr: string): Promise<any> => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true }, s); return r.result?.value ?? String(r.exceptionDetails?.text ?? "ERR"); };
let extId = "";
for (let i = 0; i < 60 && !extId; i++) { await sleep(300); const t = await send("Target.getTargets"); extId = t.targetInfos.map((x: any) => x.url.match(/chrome-extension:\/\/([^/]+)\//)?.[1]).find(Boolean) ?? ""; }
const page = await fetchJson(`http://127.0.0.1:${port}/json/new?chrome-extension://${extId}/ntp/ntp.html`, { method: "PUT" });
const { sessionId } = await send("Target.attachToTarget", { targetId: page.id, flatten: true });
await send("Runtime.enable", {}, sessionId);
let ready = false;
for (let i = 0; i < 40 && !ready; i++) { await sleep(500); ready = await evl(sessionId, `document.querySelectorAll('button, a[href], input, textarea, select').length > 0`); }
async function shot(name: string): Promise<boolean> {
  await sleep(250);
  let r: any = null;
  try { r = await send("Page.captureScreenshot", { format: "png", fromSurface: true }, sessionId); } catch (e) { console.log("shot throw:", String(e).slice(0, 120)); }
  let b64 = (r as any)?.data;
  console.log("capture raw keys:", Object.keys((r as any) ?? {}).join(","));
  if (!b64 && r?.error) { console.log("shot err:", JSON.stringify(r.error).slice(0, 160)); }
  if (!b64) { try { await send("Page.enable", {}, sessionId); await sleep(300); r = await send("Page.captureScreenshot", { format: "png", fromSurface: true }, sessionId); b64 = (r as any)?.data; } catch (e) { console.log("retry throw:", String(e).slice(0, 120)); } }
  if (!b64) { console.log("shot failed:", name); return false; }
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  await Deno.mkdir(`${ROOT}test-artifacts`, { recursive: true });
  await Deno.writeFile(`${ROOT}test-artifacts/${name}`, bytes);
  console.log("wrote", name, bytes.length, "bytes");
  return true;
}
// reveal the Agents panel so #bg-configure is visible (fresh profile hides
// empty panels): seed a named agent via the SW route, then reload
await evl(sessionId, `(() => { try { chrome.runtime.sendMessage({ type: "named-agent.create", name: "Seed Agent", role: "seed for the focus screenshot" }); } catch (e) { return String(e); } })()`);
await sleep(1200);
await send("Page.reload", {}, sessionId);
await sleep(2500);
// 1. REAL keyboard Tab to the hint-link #bg-configure so :focus-visible applies
await evl(sessionId, `document.getElementById('side-toggle')?.focus()`);
for (let i = 0; i < 60; i++) {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 }, sessionId);
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 }, sessionId);
  await sleep(25);
  const now = await evl(sessionId, `document.activeElement?.id || ''`);
  if (now === "bg-configure") break;
}
const reached = await evl(sessionId, `document.activeElement?.id`);
console.log("reached:", reached);
console.log("agents-section hidden:", await evl(sessionId, `document.getElementById('agents-section')?.hasAttribute('hidden')`));
const ring = await evl(sessionId, `(() => { const el = document.getElementById('bg-configure'); if (!el) return 'MISSING'; const cs = getComputedStyle(el); return 'outline=' + cs.outlineStyle + ' ' + cs.outlineWidth + ' ring=' + (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth||'0') > 0); })()`);
console.log("bg-configure ring:", ring, "focused=", await evl(sessionId, `document.activeElement?.id`));
check("the real Tab walk reaches the #bg-configure hint link", reached === "bg-configure", `reached=${reached}`);
check("#bg-configure shows a focus ring when focused", /ring=true$/.test(String(ring)), String(ring));
check("hub-hint-link-focus-ring.png written", await shot("hub-hint-link-focus-ring.png"));
// 2. first-run guide: Tab to the connect-model action then the dismiss (shadow DOM)
const guide = await evl(sessionId, `(() => { const g = document.getElementById('first-run-guide'); if (!g) return 'NO-GUIDE'; const root = g.shadowRoot || g; const actions = [...root.querySelectorAll('button')]; return actions.map((b) => b.className + ':' + (b.getAttribute('aria-label') || b.textContent.trim().slice(0,20))).join(' | '); })()`);
console.log("guide buttons:", guide);
try { proc.kill(); } catch { /* already gone */ }
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
Deno.exit(fail ? 1 : 0);
