// scripts/kat-settings-server-tools.ts — cap-beads-wuvg
//
// Drives real Chromium with the loaded extension to prove the provider
// server-tools toggle survives reload → providers:
// 1. Fresh profile (developer flag OFF): boot shows the dev-gated card closed
//    and never opens the paid server-tools sub-panel.
// 2. Persist cap:developerFeatures=true + cap:providerServerTools.enabled=true,
//    then RELOAD (fresh options boot) → the toggle must come back CHECKED with
//    the sub-panel + hub row visible (this was the bug: init lived in
//    renderAgents(), so reload → providers left it unchecked).
// 3. Toggling the switch persists through the service worker (off → on).
// 4. Deep link to #agents (agents renders first), then navigate to providers →
//    toggle still checked; the agents section still renders.

import { launchChrome, waitForServiceWorker } from "./lib/chrome-launch.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = `${ROOT}extension`;

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)?.slice(0, 800)}`); }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const profile = `${ROOT}.cache/kat-settings-server-tools-${Date.now()}`;
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
const clickSelector = async (sid: string, expr: string) => {
  const box = await evalIn(sid, `(() => { const el = ${expr}; if (!el) return null; el.scrollIntoView({block:"center"}); const r = el.getBoundingClientRect(); return {x:r.x+r.width/2, y:r.y+r.height/2}; })()`);
  if (!box || typeof box.x !== "number") return false;
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", buttons: 1, clickCount: 1 }, sid);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", buttons: 0, clickCount: 1 }, sid);
  return true;
};
const kvSet = async (sid: string, values: string) =>
  evalIn(sid, `chrome.runtime.sendMessage({ type: "kv.set", values: ${values} }).catch(() => ({ error: "kv.set failed" }))`);
const kvGet = async (sid: string, keys: string) =>
  evalIn(sid, `chrome.runtime.sendMessage({ type: "kv.get", keys: ${keys} }).then(r => JSON.stringify(r)).catch(() => "kv.get failed")`);

try {
  const sw = await waitForServiceWorker((m, p) => send(m, p), { timeoutMs: 20000 });
  check("extension service worker present", !!sw);
  const extId = new URL(sw.url).host;

  // 1. Dev flag OFF but provider server tools persisted ENABLED: the card is
  //    dev-gated, so it must stay hidden AND the paid sub-panel must stay
  //    closed even though initProviderServerTools runs at the providers render
  //    (reload path carries the hash, e.g. #providers).
  const t0 = await send("Target.createTarget", { url: `chrome-extension://${extId}/options/options.html#providers` });
  const s0 = (await send("Target.attachToTarget", { targetId: t0.result.targetId, flatten: true })).result?.sessionId;
  await send("Runtime.enable", {}, s0);
  await sleep(1600);
  check("dev-off boot: providers panel is the visible one",
    (await evalIn(s0, `document.getElementById("providers").classList.contains("active")`)) === true);
  // rfca: visibility alone passed for the whole life of the hy91 blank-boot
  // P0 (the panel is statically active; its renderer may never have run).
  // Assert the rendered CONTENT: provider tabs + panels (renderProviders()).
  const bootContent = await evalIn(s0, `(() => ({ tabs: document.querySelectorAll("#provider-tabs > *").length, panels: document.getElementById("provider-panels")?.children.length ?? 0 }))()`);
  check("dev-off boot: providers panel shows rendered content (tabs + panels), not a blank shell",
    (bootContent?.tabs ?? 0) > 0 && (bootContent?.panels ?? 0) > 0, bootContent);
  const seeded = await kvSet(s0, `{ "cap:developerFeatures": false, "cap:providerServerTools": { enabled: true, agents: {} } }`);
  check("seeded persisted state (dev off, server tools enabled)", !String(seeded).includes("error"), seeded);
  const t1 = await send("Target.createTarget", { url: `chrome-extension://${extId}/options/options.html#providers` });
  const s1 = (await send("Target.attachToTarget", { targetId: t1.result.targetId, flatten: true })).result?.sessionId;
  await send("Runtime.enable", {}, s1);
  await sleep(1800);
  check("dev-off reload: server-tools card hidden (dev gate)",
    (await evalIn(s1, `document.getElementById("server-tools-card").hidden`)) === true);
  check("dev-off reload: server-tools sub-panel stays closed (paid opt-ins not reachable)",
    (await evalIn(s1, `document.getElementById("server-tools-agents").hidden`)) === true);
  check("dev-off reload: toggle element exists with state bound",
    (await evalIn(s1, `document.getElementById("server-tools-enabled").hasAttribute("checked")`)) === true);

  // 2. Flip the developer flag on, then RELOAD (#providers) — the persisted
  //    enabled=true must come back CHECKED (this was the cap-beads-wuvg bug:
  //    reload → providers left the toggle unchecked because the init lived in
  //    renderAgents()).
  await kvSet(s1, `{ "cap:developerFeatures": true }`);
  const t2 = await send("Target.createTarget", { url: `chrome-extension://${extId}/options/options.html#providers` });
  const s2 = (await send("Target.attachToTarget", { targetId: t2.result.targetId, flatten: true })).result?.sessionId;
  await send("Runtime.enable", {}, s2);
  await sleep(1800);
  check("dev-on reload: server-tools card visible",
    (await evalIn(s2, `document.getElementById("server-tools-card").hidden`)) === false);
  check("dev-on reload: server-tools toggle is CHECKED (the cap-beads-wuvg bug)",
    (await evalIn(s2, `document.getElementById("server-tools-enabled").hasAttribute("checked")`)) === true);
  check("dev-on reload: sub-panel visible under the global toggle",
    (await evalIn(s2, `document.getElementById("server-tools-agents").hidden`)) === false);
  const hubRow = await evalIn(s2, `[...document.querySelectorAll("#server-tools-agent-list .toggle-field .toggle-name")].map(e => e.textContent).join(",")`);
  check("dev-on reload: hub per-agent row rendered", String(hubRow).includes("Hub"), hubRow);

  // 3. Toggling off then on persists through the service worker.
  const clickedOff = await clickSelector(s2, `document.getElementById("server-tools-enabled")`);
  check("clicked the server-tools toggle off", clickedOff);
  await sleep(700);
  const kvOff = await kvGet(s2, `["cap:providerServerTools"]`);
  check("toggle off persisted (kv enabled=false)", String(kvOff).includes('"enabled":false'), kvOff);
  const clickedOn = await clickSelector(s2, `document.getElementById("server-tools-enabled")`);
  check("clicked the server-tools toggle back on", clickedOn);
  await sleep(700);
  const kvOn = await kvGet(s2, `["cap:providerServerTools"]`);
  check("toggle on persisted (kv enabled=true)", String(kvOn).includes('"enabled":true'), kvOn);

  // 4. Deep link to #agents first (agents renderer runs, providers not yet),
  //    then navigate to providers → toggle restored, agents still rendered.
  const t3 = await send("Target.createTarget", { url: `chrome-extension://${extId}/options/options.html#agents` });
  const s3 = (await send("Target.attachToTarget", { targetId: t3.result.targetId, flatten: true })).result?.sessionId;
  await send("Runtime.enable", {}, s3);
  await sleep(1800);
  // rfca: #multi-agent is STATIC HTML — its existence proves nothing about
  // the agents renderer. Assert the rendered CONTENT: #unified-agent-list is
  // populated by renderAgents() (empty in the static markup).
  const agentsContent = await evalIn(s3, `(() => ({ toggle: !!document.getElementById("multi-agent"), rows: document.getElementById("unified-agent-list")?.children.length ?? 0 }))()`);
  check("agents deep link renders the multi-agent toggle AND the rendered agent list",
    agentsContent?.toggle === true && agentsContent?.rows > 0, agentsContent);
  const clickedNav = await clickSelector(s3, `document.querySelector('.nav-item[data-section="providers"]')`);
  check("clicked the Providers nav link", clickedNav);
  await sleep(900);
  check("providers after agents: server-tools toggle is CHECKED",
    (await evalIn(s3, `document.getElementById("server-tools-enabled").hasAttribute("checked")`)) === true);
  check("providers after agents: sub-panel visible",
    (await evalIn(s3, `document.getElementById("server-tools-agents").hidden`)) === false);

} finally {
  try { proc.kill("SIGKILL"); } catch { /* already dead */ }
  try { await proc.status; } catch { /* reaped */ }
  await Deno.remove(profile, { recursive: true }).catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed`);
Deno.exit(fail ? 1 : 0);
