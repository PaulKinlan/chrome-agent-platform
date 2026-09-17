// cap-evidence/acp-browser-acceptance.ts — REAL-BROWSER acceptance for the ACP
// surfaces (repo hard rule: "never accept 'it serves' as 'it works'").
//
// Drives the BUILT extension in headless Chrome with GENUINE CDP input, against
// a real ACP bridge on the default loopback endpoint (which spawns real pi-acp):
//   1. the hub composer's @ mention lists the pi harness agent (acp kind)
//   2. selecting it commits the acp:pi routing chip
//   3. a real send streams pi's answer into the conversation and settles
// Screenshots before/after + console-error gate. Run:
//   deno run -A cap-evidence/acp-browser-acceptance.ts
// @ts-nocheck — untyped CDP scripting in the house pattern.

import { launchChrome } from "../scripts/lib/chrome-launch.ts";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import { createAcpServer } from "../scripts/acp-bridge.ts";

const ROOT = new URL("..", import.meta.url).pathname;
// CAP_ACCEPTANCE_EXT lets this run against another checkout's built extension
// (e.g. the primary checkout Chrome actually loads).
const EXT = Deno.env.get("CAP_ACCEPTANCE_EXT") || `${ROOT}extension`;
const EVIDENCE_DIR = durableDir(`cap-acp-browser-${Date.now()}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail: unknown = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name} ${JSON.stringify(detail).slice(0, 400)}`); }
}
const sha256Hex = async (bytes: Uint8Array) => {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

// The real bridge on the extension's default endpoint (ws://127.0.0.1:3210/acp).
// CAP_ACCEPTANCE_NO_BRIDGE=1 skips it: the acceptance then drives an EXISTING
// bridge (e.g. one bound to a LAN address) configured through kv below.
const NO_LOCAL_BRIDGE = Deno.env.get("CAP_ACCEPTANCE_NO_BRIDGE") === "1";
const LAN_ENDPOINT = Deno.env.get("CAP_ACCEPTANCE_ENDPOINT") ?? "";
const LAN_TOKEN = Deno.env.get("CAP_ACCEPTANCE_TOKEN") ?? "";
const EXPECT_RE = new RegExp(Deno.env.get("CAP_ACCEPTANCE_EXPECT") ?? "ACP browser OK");
const bridge = NO_LOCAL_BRIDGE ? null : createAcpServer(3210);

await Deno.mkdir(EVIDENCE_DIR, { recursive: true });
const profile = durableDir(`cap-acp-browser-profile-${Date.now()}`);
// CAP_ACCEPTANCE_CHROME_ENV=K=V,K2=V2 passes extra variables to the browser (the
// native host inherits them), e.g. CAP_ACP_ADAPTER to point the host at a fixture.
const extraEnv = Object.fromEntries(
  String(Deno.env.get("CAP_ACCEPTANCE_CHROME_ENV") ?? "").split(",").filter(Boolean)
    .map((kv) => { const i = kv.indexOf("="); return [kv.slice(0, i), kv.slice(i + 1)]; }),
);
const chrome = await launchChrome({
  extension: EXT,
  profile,
  windowSize: "1400,2000",
  clearEnv: true,
  ...(Object.keys(extraEnv).length ? { env: { PATH: Deno.env.get("PATH") ?? "", HOME: Deno.env.get("HOME") ?? "", ...extraEnv } } : {}),
});
const port = chrome.port;

const ws = new WebSocket(chrome.wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let idc = 0;
const pend = new Map();
const consoleErrors = new Map();
ws.onmessage = (ev: MessageEvent) => {
  const m = JSON.parse(String(ev.data));
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown" ||
      (m.method === "Runtime.consoleAPICalled" && m.params?.type === "error")) {
    const detail = m.params?.exceptionDetails?.exception?.description ??
      m.params?.args?.map((a: any) => a?.value ?? a?.description).join(" ") ?? "?";
    const arr = consoleErrors.get(m.sessionId) ?? [];
    arr.push(String(detail).slice(0, 300));
    consoleErrors.set(m.sessionId, arr);
  }
};
const send = (method: string, params: any = {}, sessionId?: string) =>
  new Promise<any>((resolve, reject) => {
    const mid = ++idc;
    // 60s, not 20s: the page is streaming a live harness turn, and a busy
    // renderer must not turn into a false product red (the repo's CDP-timeout
    // class is load, not product).
    const timer = setTimeout(() => { pend.delete(mid); reject(new Error(`cdp timeout: ${method}`)); }, 60000);
    pend.set(mid, (m: any) => { clearTimeout(timer); m.error ? reject(new Error(m.error.message)) : resolve(m.result); });
    ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
  });

const results: any[] = [];
try {
  async function evl(session: string, expression: string) {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, session);
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r?.result?.value;
  }
  async function openPage(url: string) {
    const t = await (await fetch(`http://127.0.0.1:${port}/json/new?${url}`, { method: "PUT" })).json();
    const a = await send("Target.attachToTarget", { targetId: t.id, flatten: true });
    await send("Runtime.enable", {}, a.sessionId);
    await send("Page.enable", {}, a.sessionId);
    consoleErrors.set(a.sessionId, []);
    return a.sessionId;
  }
  async function shot(session: string, name: string) {
    const r = await send("Page.captureScreenshot", { format: "png" }, session);
    if (!r?.data) return false;
    const bytes = Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0));
    await Deno.writeFile(`${EVIDENCE_DIR}/${name}.png`, bytes);
    results.push({ name: `${name}.png`, sha256: await sha256Hex(bytes), bytes: bytes.length });
    return true;
  }
  const boxOf = async (session: string, expr: string) => {
    const v = await evl(session, `(() => { const el = ${expr}; if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`);
    return v && typeof v.x === "number" ? v : null;
  };
  const clickExpr = async (session: string, expr: string) => {
    const b = await boxOf(session, expr);
    if (!b) return false;
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: b.x, y: b.y, button: "left", buttons: 1, clickCount: 1 }, session);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: b.x, y: b.y, button: "left", buttons: 0, clickCount: 1 }, session);
    return true;
  };
  const typeText = (session: string, text: string) => send("Input.insertText", { text }, session);
  const KEYS: Record<string, { code: string, vk: number }> = {
    Enter: { code: "Enter", vk: 13 },
    Escape: { code: "Escape", vk: 27 },
    ArrowDown: { code: "ArrowDown", vk: 40 },
  };
  const pressKey = async (session: string, key: string) => {
    const k = KEYS[key];
    await send("Input.dispatchKeyEvent", { type: "keyDown", key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk }, session);
    await send("Input.dispatchKeyEvent", { type: "keyUp", key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk }, session);
  };
  const COMPOSER = `document.getElementById('composer')`;
  const NTP_INPUT = `${COMPOSER}.querySelector('#task-input')`;
  // AgentComposer is LIGHT-DOM (static shadow() returns false): its popup and
  // chips are direct children, not shadow content.
  const POPUP = `${COMPOSER}.querySelector('.popup')`;
  const AGENT_CHIP = `${COMPOSER}.querySelector('.chips .chip.agent-chip')`;

  // ── boot ───────────────────────────────────────────────────────────────
  let sw: any = null;
  for (let i = 0; i < 60 && !sw; i++) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    sw = targets.find((t: any) => t.type === "service_worker");
    if (!sw) await sleep(200);
  }
  check("extension loaded (service worker registered)", !!sw);
  const extId = sw.url.split("/")[2];
  const ntp = await openPage(`chrome-extension://${extId}/ntp/ntp.html`);
  await sleep(2000);

  check("hub composer rendered", (await evl(ntp, `!!${NTP_INPUT}`)) === true);
  await shot(ntp, "01-hub-composer");

  // ── 0. the + menu's "Choose agent" lists the pi harness agent ──────────
  await clickExpr(ntp, `${COMPOSER}.querySelector('#attach').shadowRoot.querySelector('.plus')`);
  await sleep(400);
  const plusItems = await evl(ntp, `(() => { const m = document.getElementById('composer'); const b = m.querySelector('#attach').shadowRoot;
    return [...b.querySelectorAll('button, [role=menuitem]')].map(x => x.textContent?.trim()).filter(Boolean).slice(0, 12); })()`);
  await shot(ntp, "00-plus-menu");
  check("the + menu exposes an agent-choosing entry", Array.isArray(plusItems) && plusItems.some((x) => /agent/i.test(x)), plusItems);
  const chooseAgent = `${COMPOSER}.querySelector('#attach').shadowRoot.querySelector('button[data-kind="choose-agent"]')`;
  const opened = await clickExpr(ntp, chooseAgent);
  await sleep(600);
  const pickGroups = await evl(ntp, `(() => { const p = ${COMPOSER}.querySelector('#agent-pick'); if (!p) return null;
    return [...p.shadowRoot.querySelectorAll('.group-h, .opt .name')].map(x => x.textContent?.trim()).filter(Boolean); })()`);
  await shot(ntp, "00-agent-picker");
  check(
    "the agent picker lists pi under a Harness Agents (ACP) group",
    Array.isArray(pickGroups) && pickGroups.some((x) => /ACP/i.test(x)) && pickGroups.some((x) => /^pi$/i.test(x)),
    { opened, pickGroups },
  );
  await evl(ntp, `document.body.click()`);
  await pressKey(ntp, "Escape");
  await sleep(200);

  // ── 0a. no bridge at all: is the loopback endpoint silent? ─────────────
  if (NO_LOCAL_BRIDGE) {
    const bridgeProbe = await evl(ntp, `fetch("http://127.0.0.1:3210/health").then(() => "up").catch(() => "down")`);
    check("no WebSocket bridge is running (native-messaging run)", bridgeProbe === "down", bridgeProbe);
  }

  // ── 0a2. the native host, straight from the page (its own error text) ──
  // Gated: a HEADLESS browser reports "native messaging host not found" even
  // with a correct manifest (unverified whether that is headless itself or this
  // install), so this assertion runs only when explicitly asked for
  // (CAP_ACCEPTANCE_EXPECT_NATIVE=1, i.e. a headed run).
  if (NO_LOCAL_BRIDGE && Deno.env.get("CAP_ACCEPTANCE_EXPECT_NATIVE") === "1") {
    const nativeProbe = await evl(ntp, `new Promise((resolve) => {
      try {
        const port = chrome.runtime.connectNative("com.chrome_agent_platform.acp");
        let settled = false; const done = (r) => { if (!settled) { settled = true; resolve(r); } };
        port.onMessage.addListener((m) => done(["message", m]));
        port.onDisconnect.addListener(() => done(["disconnect", (chrome.runtime.lastError && chrome.runtime.lastError.message) || "(no lastError)"]));
        port.postMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
        setTimeout(() => done(["timeout", ""]), 6000);
      } catch (e) { resolve(["throw", String((e && e.message) || e)]); }
    })`);
    console.log(`  native port: ${JSON.stringify(nativeProbe).slice(0, 300)}`);
    check("native host replies to initialize from the extension", Array.isArray(nativeProbe) && nativeProbe[0] === "message", nativeProbe);
  }

  // ── 0b. can the EXTENSION open a plaintext ws:// to a LAN address? ─────
  if (LAN_ENDPOINT) {
    const probeUrl = `${LAN_ENDPOINT}${LAN_TOKEN ? (LAN_ENDPOINT.includes("?") ? "&" : "?") + `token=${LAN_TOKEN}` : ""}`;
    const wsResult = await evl(ntp, `new Promise((resolve) => {
      let done = false; const finish = (r) => { if (!done) { done = true; resolve(r); } };
      try {
        const ws = new WebSocket(${JSON.stringify(probeUrl)});
        ws.onopen = () => { finish("open"); ws.close(); };
        ws.onerror = () => finish("error");
        ws.onclose = (e) => finish("close:" + e.code + (e.reason ? ":" + e.reason : ""));
      } catch (e) { finish("throw:" + String(e && e.message || e)); }
      setTimeout(() => finish("timeout"), 8000);
    })`);
    check(`extension can open ${LAN_ENDPOINT} (mixed-content / PNA test)`, wsResult === "open", wsResult);
    const configured = await evl(ntp, `chrome.runtime.sendMessage({ type: "kv.set", values: { "acp.endpoint": ${JSON.stringify(LAN_ENDPOINT)}, "acp.token": ${JSON.stringify(LAN_TOKEN)} } }).then(r => r, e => ({ err: String(e) }))`);
    console.log(`  kv acp.endpoint/acp.token set: ${JSON.stringify(configured).slice(0, 120)}`);
  }

  // ── 1. the @ mention lists the pi harness agent ────────────────────────
  await clickExpr(ntp, NTP_INPUT);
  await typeText(ntp, "@pi");
  await sleep(700);
  const mentionItems = await evl(ntp, `(() => { const p = ${POPUP}; if (!p) return null;
    return [...p.querySelectorAll('.item, [role=option]')].map(i => ({ text: i.textContent?.trim().slice(0, 120), id: i.id })); })()`);
  await shot(ntp, "02-mention-popup");
  const piRow = Array.isArray(mentionItems) ? mentionItems.find((i: any) => /pi/i.test(i.text ?? "")) : null;
  check("@pi offers the pi harness agent in the mention popup", !!piRow, mentionItems);

  // ── 2. selecting it commits the acp:pi routing chip ────────────────────
  if (piRow) { await pressKey(ntp, "Enter"); }
  await sleep(500);
  const chip = await evl(ntp, `(() => { const chip = ${AGENT_CHIP};
    return chip ? { text: chip.textContent?.trim(), aria: chip.getAttribute('aria-label') } : null; })()`);
  await shot(ntp, "03-selected-agent");
  check("the composer committed a routing chip after selecting pi", !!chip, chip);

  // ── 3. a real send streams pi's answer into the conversation ───────────
  await clickExpr(ntp, NTP_INPUT);
  await typeText(ntp, "Reply with exactly: ACP browser OK");
  await sleep(200);
  await shot(ntp, "04-before-send");
  await pressKey(ntp, "Enter");

  const readTurn = async () => await evl(ntp, `(() => {
    const c = document.getElementById('thread-conversation');
    const status = document.getElementById('status');
    const text = c ? c.textContent ?? '' : '';
    // message-bubble is a custom element (its copy lives in attributes).
    const contents = c ? [...c.querySelectorAll('message-bubble')].map(b => ({ role: b.getAttribute('role'), content: b.getAttribute('content') ?? '' })) : [];
    const bubbles = contents.filter(b => b.role === 'agent').map(b => b.content.trim()).filter(Boolean);
    return { status: status?.textContent ?? '', textLen: text.length, bubbles: bubbles.slice(-3), roles: contents.map(b => b.role), statusHidden: !!status?.hidden };
  })()`);

  let turn: any = null;
  for (let i = 0; i < 90; i++) { // up to ~180s: a real pi turn
    await sleep(2000);
    turn = await readTurn();
    const settled = turn && (turn.status === "ready" || /^error/i.test(turn.status ?? ""));
    const streamed = (turn?.bubbles ?? []).some((b: string) => /ACP browser OK/i.test(b));
    if (streamed && settled) break;
  }
  await sleep(500);
  await shot(ntp, "05-after-turn");
  const finalTurn = await readTurn();
  const transcript = await evl(ntp, `(() => { const c = document.getElementById('thread-conversation');
    return c ? [...c.querySelectorAll('message-bubble')].map(b => ({ role: b.getAttribute('role'), text: (b.getAttribute('content') || '').slice(0, 160) })) : null; })()`);
  console.log(`  transcript: ${JSON.stringify(transcript).slice(0, 600)}`);
  const agentText = (finalTurn?.bubbles ?? []).join(" | ");
  check("a real pi turn produced agent text in the conversation", EXPECT_RE.test(agentText), { agentText: agentText.slice(0, 300), expected: String(EXPECT_RE) });
  check("the run settled (no orphaned running status)", !/running/i.test(finalTurn?.status ?? ""), finalTurn?.status);
  check("no console errors during the acceptance", (consoleErrors.get(ntp) ?? []).length === 0, consoleErrors.get(ntp));

  // ── the side panel's Agents section lists the harness agent ────────────
  const panel = await openPage(`chrome-extension://${extId}/sidepanel/sidepanel.html`);
  await sleep(2000);
  const panelRows = await evl(panel, `(() => {
    const p = document.getElementById('agents-picker');
    if (!p) return null;
    const rows = [...p.shadowRoot.querySelectorAll('.group-h, .opt .name, .opt .sub')].map(x => x.textContent?.trim()).filter(Boolean);
    return { rows, tabHidden: document.getElementById('agents-view')?.hidden ?? null };
  })()`);
  await shot(panel, "06-sidepanel-agents");
  const panelHasAcpGroup = Array.isArray(panelRows?.rows) && panelRows.rows.some((r) => /ACP/i.test(r));
  const panelHasPi = Array.isArray(panelRows?.rows) && panelRows.rows.some((r) => /^pi$/i.test(r));
  check("side panel · Agents section shows the ACP harness group", panelHasAcpGroup, panelRows);
  check("side panel · Agents section lists pi", panelHasPi, panelRows);
  // The owner's ask: harness agents reachable in ONE click from the side panel.
  // Select the Agents tab FIRST: the pane is hidden until then, and a click at
  // the coordinates of a hidden element lands on whatever is behind it.
  const tabClicked = await clickExpr(panel, `document.getElementById('tab-agents')`);
  await sleep(400);
  const quickRows = await evl(panel, `(() => { const q = document.getElementById('harness-quick');
    return q ? [...q.querySelectorAll('button.hq')].map(b => b.textContent.trim()) : null; })()`);
  check("side panel · the Agents tab is reachable", tabClicked === true);
  check("side panel · one-click harness rows exist", Array.isArray(quickRows) && quickRows.length >= 1, quickRows);
  // Click the FIRST row with real input and confirm the conversation opens.
  const firstRow = await boxOf(panel, `document.querySelector('#harness-quick button.hq')`);
  if (firstRow) {
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: firstRow.x, y: firstRow.y, button: "left", buttons: 1, clickCount: 1 }, panel);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: firstRow.x, y: firstRow.y, button: "left", buttons: 0, clickCount: 1 }, panel);
  }
  await sleep(1200);
  const quickOpen = await evl(panel, `(() => ({
    detailHidden: document.getElementById('agent-detail-pane')?.hidden ?? null,
    name: document.getElementById('agent-detail-name')?.textContent ?? null,
    kind: document.getElementById('agent-detail-kind')?.textContent ?? null,
    ledgerCollapsed: document.getElementById('activity-ledger-section')?.tagName ?? null,
    ledgerOpen: document.getElementById('activity-ledger-section')?.open ?? null,
  }))()`);
  await shot(panel, "07-sidepanel-quick-open");
  check("side panel · one click opens that harness conversation", quickOpen?.detailHidden === false && !!quickOpen?.name, quickOpen);
  check("side panel · the activity ledger no longer expands the pane by default", quickOpen?.ledgerCollapsed === "DETAILS" && quickOpen?.ledgerOpen === false, quickOpen);

  const panelErrors = consoleErrors.get(panel) ?? [];
  check("side panel: no console errors", panelErrors.length === 0, panelErrors);

  await Deno.writeFile(`${EVIDENCE_DIR}/acceptance.json`, new TextEncoder().encode(JSON.stringify({
    ranAt: new Date().toISOString(),
    extensionId: extId,
    gitHead: (await new Deno.Command("/usr/bin/git", { args: ["-C", ROOT, "rev-parse", "HEAD"], stdout: "piped" }).output()).stdout.toString().trim(),
    results, pass, fail, failures,
  }, null, 2)));
} catch (err) {
  fail++;
  failures.push(`driver error: ${String(err)}`);
  console.log(`  FAIL  driver error: ${String(err)}`);
} finally {
  try { ws.close(); } catch { /* closing */ }
  try { chrome.proc.kill("SIGTERM"); } catch { /* already gone */ }
  await bridge?.shutdown();
}

console.log(`\nACP browser acceptance: ${pass} passed, ${fail} failed`);
console.log(`evidence: ${EVIDENCE_DIR}`);
if (fail > 0) { console.log(`failures: ${failures.join("; ")}`); Deno.exit(1); }
