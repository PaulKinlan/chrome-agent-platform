// scripts/kat-browser-grant-persistence.ts — CAP-FB-20260902-BROWSER-GRANT-PERSISTENCE-01 / zi9g
//
// Proves browser-control toggle and grant persistence across real page reloads in a loaded extension:
// 1. Initial state: toggle unchecked, active false.
// 2. Click toggle ON: toggle checked, active true (global grant).
// 3. Reload options page: toggle remains checked, active true.
// 4. Add origin: origin added to grant set, rows rendered.
// 5. Reload options page: toggle remains checked, origin rows preserved.
// 6. Click toggle OFF: toggle unchecked, active false.
// 7. Reload options page: toggle remains unchecked, active false.

import { launchChrome, waitForServiceWorker } from "./lib/chrome-launch.ts";
import { chromeProfileDir } from "./lib/chrome-profile-dir.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = `${ROOT}extension`;

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)?.slice(0, 800)}`); }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const profile = chromeProfileDir("kat-browser-grant-persistence");
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
  ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
});
const evalIn = async (sid: string, expr: string) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sid);
  if (r?.result?.exceptionDetails) return { __exception: r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text };
  return r?.result?.result?.value;
};
const until = async (fn: () => Promise<any>, ms: number, step = 400) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await sleep(step);
  }
  return null;
};
const clickSelector = async (sid: string, expr: string) => {
  const box = await evalIn(sid, `(() => { const el = ${expr}; if (!el) return null; el.scrollIntoView({block:"center"}); const r = el.getBoundingClientRect(); return {x:r.x+r.width/2, y:r.y+r.height/2}; })()`);
  if (!box || typeof box.x !== "number") return false;
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", buttons: 1, clickCount: 1 }, sid);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", buttons: 0, clickCount: 1 }, sid);
  return true;
};

try {
  const sw = await waitForServiceWorker((m, p) => send(m, p), { timeoutMs: 20000 });
  check("extension service worker present", !!sw);
  const extId = new URL(sw.url).host;

  // Open Settings
  const optT = await send("Target.createTarget", { url: `chrome-extension://${extId}/options/options.html#browser` });
  const opts = (await send("Target.attachToTarget", { targetId: optT.result.targetId, flatten: true })).result?.sessionId;
  await send("Runtime.enable", {}, opts);
  await send("Page.enable", {}, opts);
  await sleep(1600);

  // 1. Initial state
  const initGrant = await evalIn(opts, `chrome.runtime.sendMessage({ type: "browser-control.get" })`);
  const initToggle = await evalIn(opts, `document.querySelector("#browser-grant")?.checked`);
  check("initial state: toggle is off", initToggle === false, { initToggle, initGrant });

  // 2. Click toggle ON
  const clickedOn = await clickSelector(opts, `document.querySelector("#browser-grant")`);
  check("clicked toggle ON", clickedOn);
  await sleep(600);

  const onGrant = await evalIn(opts, `chrome.runtime.sendMessage({ type: "browser-control.get" })`);
  const onToggle = await evalIn(opts, `document.querySelector("#browser-grant")?.checked`);
  check("toggle ON: toggle is checked", onToggle === true, onToggle);
  check("toggle ON: browser-control is active (global scope)", onGrant?.active === true && onGrant?.scope === "global", onGrant);

  // 3. Reload options page
  await send("Page.reload", {}, opts);
  await sleep(1600);

  const reloadedGrant = await evalIn(opts, `chrome.runtime.sendMessage({ type: "browser-control.get" })`);
  const reloadedToggle = await evalIn(opts, `document.querySelector("#browser-grant")?.checked`);
  check("persistence: toggle remains checked across reload", reloadedToggle === true, reloadedToggle);
  check("persistence: grant remains active across reload", reloadedGrant?.active === true && reloadedGrant?.scope === "global", reloadedGrant);

  // 4. Add origin
  await evalIn(opts, `(() => {
    const ta = document.getElementById("grant-origin-list");
    ta.value = "https://example.com";
    ta.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await sleep(600);

  const originGrant = await evalIn(opts, `chrome.runtime.sendMessage({ type: "browser-control.get" })`);
  const originRows = await evalIn(opts, `[...document.querySelectorAll("#grant-origin-rows origin-grant-row")].map(r => r.getAttribute("origin"))`);
  check("origin added: scope is origins", originGrant?.scope === "origins" && originGrant?.origins?.includes("https://example.com"), originGrant);
  check("origin added: row rendered in DOM", Array.isArray(originRows) && originRows.includes("https://example.com"), originRows);

  // 5. Reload options page with origin grant
  await send("Page.reload", {}, opts);
  await sleep(1600);

  const reloadedOriginGrant = await evalIn(opts, `chrome.runtime.sendMessage({ type: "browser-control.get" })`);
  const reloadedOriginToggle = await evalIn(opts, `document.querySelector("#browser-grant")?.checked`);
  const reloadedOriginRows = await evalIn(opts, `[...document.querySelectorAll("#grant-origin-rows origin-grant-row")].map(r => r.getAttribute("origin"))`);
  check("origin persistence: toggle remains checked after reload", reloadedOriginToggle === true, reloadedOriginToggle);
  check("origin persistence: origins scope preserved after reload", reloadedOriginGrant?.scope === "origins" && reloadedOriginGrant?.origins?.includes("https://example.com"), reloadedOriginGrant);
  check("origin persistence: rows re-rendered after reload", Array.isArray(reloadedOriginRows) && reloadedOriginRows.includes("https://example.com"), reloadedOriginRows);

  // 6. Click toggle OFF
  const clickedOff = await clickSelector(opts, `document.querySelector("#browser-grant")`);
  check("clicked toggle OFF", clickedOff);
  await sleep(600);

  const offGrant = await evalIn(opts, `chrome.runtime.sendMessage({ type: "browser-control.get" })`);
  const offToggle = await evalIn(opts, `document.querySelector("#browser-grant")?.checked`);
  check("toggle OFF: toggle is unchecked", offToggle === false, offToggle);
  check("toggle OFF: grant is inactive", offGrant?.active === false, offGrant);

  // 7. Reload options page after revoke
  await send("Page.reload", {}, opts);
  await sleep(1600);

  const finalGrant = await evalIn(opts, `chrome.runtime.sendMessage({ type: "browser-control.get" })`);
  const finalToggle = await evalIn(opts, `document.querySelector("#browser-grant")?.checked`);
  check("revoke persistence: toggle remains unchecked after reload", finalToggle === false, finalToggle);
  check("revoke persistence: grant remains inactive after reload", finalGrant?.active === false, finalGrant);

} finally {
  try { proc.kill("SIGKILL"); } catch { /* already dead */ }
  try { await proc.status; } catch { /* reaped */ }
  await Deno.remove(profile, { recursive: true }).catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed`);
Deno.exit(fail ? 1 : 0);
