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
const EXT = `${ROOT}extension`;
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
const bridge = createAcpServer(3210);

await Deno.mkdir(EVIDENCE_DIR, { recursive: true });
const profile = durableDir(`cap-acp-browser-profile-${Date.now()}`);
const chrome = await launchChrome({ extension: EXT, profile, windowSize: "1400,2000", clearEnv: true });
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
  const agentText = (finalTurn?.bubbles ?? []).join(" | ");
  check("a real pi turn produced agent text in the conversation", /ACP browser OK/i.test(agentText), { agentText: agentText.slice(0, 300) });
  check("the run settled (no orphaned running status)", !/running/i.test(finalTurn?.status ?? ""), finalTurn?.status);
  check("no console errors during the acceptance", (consoleErrors.get(ntp) ?? []).length === 0, consoleErrors.get(ntp));

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
  await bridge.shutdown();
}

console.log(`\nACP browser acceptance: ${pass} passed, ${fail} failed`);
console.log(`evidence: ${EVIDENCE_DIR}`);
if (fail > 0) { console.log(`failures: ${failures.join("; ")}`); Deno.exit(1); }
