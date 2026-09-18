// cap-evidence/acp-journal-acceptance.ts — REAL-BROWSER acceptance for
// chrome-agent-platform-hg03: an ACP harness turn must land in CAP's own
// thread/task store, appear in the task list, and reopen WITH ITS TRANSCRIPT
// after a page reload.
//
// Driven in the loaded extension with genuine CDP input against a real bridge
// whose adapter is the deterministic fixture (no harness spend).
//   deno run -A cap-evidence/acp-journal-acceptance.ts
// @ts-nocheck — untyped CDP scripting in the house pattern.

import { launchChrome } from "../scripts/lib/chrome-launch.ts";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import { createAcpServer } from "../scripts/acp-bridge.ts";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXT = Deno.env.get("CAP_ACCEPTANCE_EXT") || `${ROOT}/extension`;
const FAKE_ADAPTER = fileURLToPath(new URL("../tests/fixtures/acp-fake-adapter.mjs", import.meta.url));
const EVIDENCE_DIR = durableDir(`cap-acp-journal-${Date.now()}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail: unknown = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL  ${name} ${JSON.stringify(detail).slice(0, 400)}`); }
}

// The bridge on the endpoint the extension defaults to, running the fixture
// adapter so this costs no harness tokens.
const bridge = createAcpServer(3210, FAKE_ADAPTER);

await Deno.mkdir(EVIDENCE_DIR, { recursive: true });
const profile = durableDir(`cap-acp-journal-profile-${Date.now()}`);
const chrome = await launchChrome({ extension: EXT, profile, windowSize: "1400,2000", clearEnv: true });
const port = chrome.port;

const ws = new WebSocket(chrome.wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let idc = 0;
const pend = new Map();
ws.onmessage = (ev: MessageEvent) => {
  const m = JSON.parse(String(ev.data));
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
};
const send = (method: string, params: any = {}, sessionId?: string) =>
  new Promise<any>((resolve, reject) => {
    const mid = ++idc;
    const timer = setTimeout(() => { pend.delete(mid); reject(new Error(`cdp timeout: ${method}`)); }, 60000);
    pend.set(mid, (m: any) => { clearTimeout(timer); m.error ? reject(new Error(m.error.message)) : resolve(m.result); });
    ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
  });

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
    return a.sessionId;
  }
  async function shot(session: string, name: string) {
    const r = await send("Page.captureScreenshot", { format: "png" }, session);
    if (!r?.data) return false;
    await Deno.writeFile(`${EVIDENCE_DIR}/${name}.png`, Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0)));
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
  const pressKey = async (session: string, key: string) => {
    const k = { Enter: { code: "Enter", vk: 13 }, Escape: { code: "Escape", vk: 27 } }[key];
    await send("Input.dispatchKeyEvent", { type: "keyDown", key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk }, session);
    await send("Input.dispatchKeyEvent", { type: "keyUp", key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk }, session);
  };
  const msg = (session: string, payload: any) =>
    evl(session, `chrome.runtime.sendMessage(${JSON.stringify(payload)}).then(v => ({ v }), e => ({ err: String(e && e.message || e) }))`)
      .then((r) => r?.v ?? { ok: false, error: r?.err ?? "no response" });

  const COMPOSER = `document.getElementById('composer')`;
  const NTP_INPUT = `${COMPOSER}.querySelector('[data-composer-input], textarea')`;

  // ── boot ────────────────────────────────────────────────────────────────
  let sw: any = null;
  for (let i = 0; i < 60 && !sw; i++) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    sw = targets.find((t: any) => t.type === "service_worker");
    if (!sw) await sleep(200);
  }
  check("extension loaded", !!sw);
  const extId = sw.url.split("/")[2];
  let ntp = await openPage(`chrome-extension://${extId}/ntp/ntp.html`);
  await sleep(2000);

  const threadsBefore = await msg(ntp, { type: "thread.list" });
  const beforeCount = Array.isArray(threadsBefore?.threads) ? threadsBefore.threads.length : -1;
  console.log(`  threads before: ${beforeCount}`);

  // ── the turn, driven through the real composer ──────────────────────────
  const TASK = "ACP journal probe: reply with the fixture text";
  await clickExpr(ntp, NTP_INPUT);
  await typeText(ntp, "@pi");
  await sleep(700);
  await pressKey(ntp, "Enter");      // commit the mention chip
  await sleep(300);
  await clickExpr(ntp, NTP_INPUT);
  await typeText(ntp, TASK);
  await sleep(200);
  await pressKey(ntp, "Enter");      // send
  console.log("  turn sent; waiting for it to settle…");

  let settled: any = null;
  for (let i = 0; i < 60; i++) {
    await sleep(1500);
    settled = await evl(ntp, `(() => { const c = document.getElementById('thread-conversation');
      const bubbles = c ? [...c.querySelectorAll('message-bubble')].map(b => ({ role: b.getAttribute('role'), text: (b.getAttribute('content')||'').slice(0,200) })) : [];
      return { status: document.getElementById('status')?.textContent ?? '', bubbles }; })()`);
    const hasAgent = (settled?.bubbles ?? []).some((b: any) => b.role === "agent" && b.text.trim());
    if (hasAgent && !/running/i.test(settled?.status ?? "")) break;
  }
  await shot(ntp, "01-turn-in-surface");
  const agentText = (settled?.bubbles ?? []).filter((b: any) => b.role === "agent").map((b: any) => b.text).join(" ");
  check("the harness turn produced an answer in the surface", /fake reply/i.test(agentText), { agentText, status: settled?.status });

  // ── the record: task list + transcript ─────────────────────────────────
  const threadsAfter = await msg(ntp, { type: "thread.list" });
  const threads = Array.isArray(threadsAfter?.threads) ? threadsAfter.threads : [];
  const task = threads.find((t: any) => String(t?.name ?? "").includes("ACP journal probe") || String(t?.preview ?? "").includes("ACP journal probe"));
  check("the ACP turn created a REAL task in the list", !!task, { before: beforeCount, after: threads.length, names: threads.slice(0, 3).map((t: any) => t?.name) });

  let transcript: any = null;
  if (task?.id) {
    const got = await msg(ntp, { type: "thread.get", id: task.id });
    transcript = got?.thread ?? null;
    const rows = Array.isArray(transcript?.messages) ? transcript.messages : [];
    console.log(`  transcript rows: ${JSON.stringify(rows.map((r: any) => ({ role: r.role, content: String(r.content ?? "").slice(0, 60), exec: String(r.executionId ?? "").slice(0, 28), tool: r.toolName ?? null, step: r.step ?? null })), null, 0)}`);
    console.log(`  thread status: ${transcript?.status} / list status: ${task?.status} / lastError: ${JSON.stringify(transcript?.lastError ?? null).slice(0, 200)}`);
    check("the task's transcript has the user turn", rows.some((r: any) => r.role === "user" && String(r.content).includes("ACP journal probe")), rows.map((r: any) => r.role));
    check("the task's transcript has the harness ANSWER", rows.some((r: any) => r.role === "assistant" && /fake reply/i.test(String(r.content))), rows.filter((r: any) => r.role !== "tool").map((r: any) => String(r.content).slice(0, 80)));
    check("the turn's tool call is journaled as a row", rows.some((r: any) => r.role === "tool" && String(r.toolName || "").length > 0), rows.filter((r: any) => r.role === "tool").map((r: any) => r.toolName));
    check("the task is SETTLED, not left running", ["done", "error"].includes(String(transcript?.status ?? task?.status)), { threadStatus: transcript?.status, listStatus: task?.status });
  } else {
    check("the task's transcript is readable", false, "no task row to read");
  }

  // ── the reload: does it survive with its transcript? ───────────────────
  await send("Page.reload", {}, ntp);
  await sleep(3000);
  const afterReload = await evl(ntp, `(() => { const nav = document.getElementById('thread-sidebar');
    return nav ? [...nav.querySelectorAll('*')].map(n => (n.textContent||'').trim()).filter(Boolean).slice(0, 12) : null; })()`);
  await shot(ntp, "02-after-reload");
  const listed = Array.isArray(afterReload) && afterReload.some((x: string) => x.includes("ACP journal probe"));
  check("after a RELOAD the task is still listed", listed, afterReload);

  if (task?.id) {
    // Open it the way the owner would: the sidebar row for that task.
    const opened = await clickExpr(ntp, `(() => { const nav = document.getElementById('thread-sidebar');
      if (!nav) return null;
      return [...nav.querySelectorAll('*')].find(n => n.children.length === 0 && (n.textContent||'').includes('ACP journal probe')) ?? null; })()`);
    await sleep(2500);
    const reopened = await evl(ntp, `(() => { const c = document.getElementById('thread-conversation');
      return c ? [...c.querySelectorAll('message-bubble')].map(b => ({ role: b.getAttribute('role'), text: (b.getAttribute('content')||'').slice(0,200) })) : null; })()`);
    await shot(ntp, "03-reopened-transcript");
    const text = (reopened ?? []).map((b: any) => b.text).join(" ");
    check("the reopened task shows the transcript", /ACP journal probe/i.test(text) && /fake reply/i.test(text), { opened, bubbles: (reopened ?? []).map((b: any) => b.role) });
  }

  await Deno.writeFile(`${EVIDENCE_DIR}/acceptance.json`, new TextEncoder().encode(JSON.stringify({
    ranAt: new Date().toISOString(), extensionId: extId, taskId: task?.id ?? null, pass, fail, failures,
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

console.log(`\nACP journal acceptance: ${pass} passed, ${fail} failed`);
console.log(`evidence: ${EVIDENCE_DIR}`);
if (fail > 0) { console.log(`failures: ${failures.join("; ")}`); Deno.exit(1); }
