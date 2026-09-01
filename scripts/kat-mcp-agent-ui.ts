// kat-mcp-agent-ui.ts — CAP-FB-20260831-MCP-AGENT-UI-01 KAT.
//
// Drives the REAL per-agent "MCP servers" section in the agent create dialog of
// a loaded extension:
//   1. Stand up a Streamable-HTTP MCP test server (tools: add, echo).
//   2. Configure ONE GLOBAL server ("calc") from the Settings page.
//   3. Open the hub, open "Create an agent". Assert the dialog INHERITS the
//      global "calc" server (shown in the MCP section).
//   4. Toggle "calc" OFF for this agent, ADD an own server ("mine"), name the
//      agent, and Create it.
//   5. Read the new agent back (named-agent.get, REDACTED): assert its per-agent
//      list carries calc DISABLED + the own "mine" server, and that the resolved
//      effective set (global ∪ agent, minus disabled) is exactly {mine} — the
//      inherited "calc" is gone, "mine" is present. The own server's token is
//      never returned (redacted; hasToken only).
//   Screenshots at each stage.
//
//   npm run build:production
//   deno run -A scripts/kat-mcp-agent-ui.ts
//
// Uses the mandated launchChrome() (kernel-assigned debug port from stderr).

import { launchChrome, waitForServiceWorker } from "./lib/chrome-launch.ts";
import { startMcpTestServer } from "./mcp-test-server.ts";
import { resolveEffectiveMcpServers } from "../extension/lib/mcp-config.js";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = `${ROOT}extension`;
const CHROMIUM = "/usr/bin/chromium";
const EVIDENCE = Deno.env.get("CAP_EVIDENCE_DIR") ??
  "/tmp/claude-1000/-home-paulkinlan-chrome-agent-platform/25bf9309-c874-4b40-85db-e95719f9eeb2/scratchpad/work/mcp-agent-ui";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`); }
}

class Cdp {
  ws: WebSocket;
  id = 0;
  pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void; timer: number }>();
  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (e) => {
      const d = JSON.parse(e.data as string);
      if (d.id && this.pending.has(d.id)) {
        const { resolve, reject, timer } = this.pending.get(d.id)!;
        clearTimeout(timer);
        this.pending.delete(d.id);
        d.error ? reject(new Error(`cdp ${d.error.code}: ${d.error.message}`)) : resolve(d);
      }
    };
  }
  send(method: string, params: any = {}, sessionId?: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`cdp timeout: ${method}`)); }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
}

async function evalIn(cdp: Cdp, session: string, expression: string) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, session);
  if (r.result?.exceptionDetails) {
    throw new Error(`eval threw: ${JSON.stringify(r.result.exceptionDetails).slice(0, 600)}`);
  }
  return r.result?.result?.value;
}

async function shot(cdp: Cdp, session: string, file: string) {
  try {
    const s = await cdp.send("Page.captureScreenshot", { format: "png" }, session);
    if (s.result?.data) {
      await Deno.writeFile(`${EVIDENCE}/${file}`, Uint8Array.from(atob(s.result.data), (c) => c.charCodeAt(0)));
      console.log(`  evidence: ${EVIDENCE}/${file}`);
    }
  } catch (e) { console.log(`  (screenshot ${file} skipped: ${String((e as Error)?.message ?? e)})`); }
}

async function openPage(cdp: Cdp, wsUrl: string, url: string) {
  const res = await fetch(`http://127.0.0.1:${new URL(wsUrl).port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  const target = await res.json();
  const pa = await cdp.send("Target.attachToTarget", { targetId: target.id, flatten: true });
  const ps = pa.result.sessionId as string;
  await cdp.send("Page.enable", {}, ps);
  await cdp.send("Runtime.enable", {}, ps);
  return { ps, targetId: target.id };
}

async function main() {
  await Deno.mkdir(EVIDENCE, { recursive: true });

  try {
    const sw = await Deno.readTextFile(`${EXT}/dist/background/service-worker.js`);
    if (!sw.includes("StreamableHTTPClientTransport")) {
      console.log("FAIL: SW bundle lacks the MCP remote client — run `npm run build:production` first");
      Deno.exit(1);
    }
  } catch {
    console.log("FAIL: dist/background/service-worker.js missing — run a build first");
    Deno.exit(1);
  }

  const good = await startMcpTestServer();
  console.log(`global MCP server (calc): ${good.url}`);
  const ownUrl = good.url; // any reachable http(s) url; connection isn't tested here

  const profile = await Deno.makeTempDir({ prefix: "cap-mcp-agent-ui-kat-" });
  const { proc, wsUrl } = await launchChrome({
    binary: CHROMIUM,
    args: [
      "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
      "--silent-debugger-extension-api",
      `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
      "--window-size=1200,900", `--user-data-dir=${profile}`, "about:blank",
    ],
    stdout: "null",
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = () => res(null); ws.onerror = (e) => rej(e); });
  const cdp = new Cdp(ws);

  try {
    const swt = await waitForServiceWorker(cdp.send.bind(cdp), { timeoutMs: 20000 });
    if (!swt) { console.log("FAIL: service worker never registered"); Deno.exit(1); }
    const extId = swt.url.split("/")[2];
    console.log(`extension id: ${extId}`);

    // 1) Configure the GLOBAL server from the Settings page (owner-options).
    const optUrl = `chrome-extension://${extId}/options/options.html#mcp-servers`;
    const { ps: opt } = await openPage(cdp, wsUrl, optUrl);
    await sleep(1200);
    const setGlobal = await evalIn(cdp, opt, `(async () => {
      const r = await chrome.runtime.sendMessage({ type: 'mcp.servers.set', servers: [
        { name: 'Calc', transport: 'http', url: ${JSON.stringify(good.url)}, enabled: true,
          auth: { headerName: 'Authorization', token: 'global-kat-token' } },
      ]});
      return { ok: !!r && !r.error, ids: (r?.servers||[]).map(s=>s.id) };
    })()`);
    check("a global MCP server is configured in Settings", setGlobal?.ok === true && (setGlobal?.ids||[]).includes("calc"), setGlobal);

    // 2) Open the hub and the Create-agent dialog.
    const { ps } = await openPage(cdp, wsUrl, `chrome-extension://${extId}/ntp/ntp.html`);
    await sleep(1800);
    await evalIn(cdp, ps, `document.getElementById('new-agent')?.click()`);
    let dialogUp = false;
    for (let i = 0; i < 30; i++) {
      dialogUp = await evalIn(cdp, ps, `Boolean(document.querySelector('agent-dialog .agent-mcp-box'))`);
      if (dialogUp) break;
      await sleep(200);
    }
    check("the create-agent dialog shows an MCP servers section", dialogUp === true, dialogUp);
    // Expand the Advanced disclosure and bring the MCP section into view (for the
    // visual evidence; the section is functional regardless of scroll state).
    await evalIn(cdp, ps, `(() => {
      const det = document.querySelector('agent-dialog details.agent-config-advanced');
      if (det) det.open = true;
      document.querySelector('agent-dialog .agent-mcp-box')?.scrollIntoView({ block: 'center' });
      return true;
    })()`);
    await sleep(400);

    // 3) The dialog INHERITS the global 'calc' server.
    const inherited = await evalIn(cdp, ps, `(() => {
      const box = document.querySelector('agent-dialog .agent-mcp-box');
      const card = box?.querySelector('.mcp-server-card[data-id="calc"]');
      const tagged = card?.querySelector('.mcp-server-tag')?.textContent || '';
      return { present: Boolean(card), tag: tagged };
    })()`);
    check("the agent inherits the global 'calc' server (shown as Inherited)", inherited?.present === true && /inherit/i.test(inherited?.tag||""), inherited);
    await shot(cdp, ps, "01-dialog-inherits-global.png");

    // 4) Toggle 'calc' OFF for this agent, name the agent, add an own server.
    await evalIn(cdp, ps, `(() => {
      const box = document.querySelector('agent-dialog .agent-mcp-box');
      const card = box.querySelector('.mcp-server-card[data-id="calc"]');
      const tog = card.querySelector('switch-toggle');
      tog.dispatchEvent(new CustomEvent('toggle', { detail: { checked: false } }));
      // name the agent
      const labels = [...document.querySelectorAll('agent-dialog label')];
      const nameLabel = labels.find(l => (l.querySelector('span')?.textContent||'').trim() === 'Name');
      const nameInput = nameLabel?.querySelector('input');
      if (nameInput) { nameInput.value = 'Kat Mcp Agent'; nameInput.dispatchEvent(new Event('input', {bubbles:true})); }
      // open the own-server editor
      const addBtn = [...box.querySelectorAll('button')].find(b => b.textContent.trim() === 'Add a server');
      addBtn.click();
      return true;
    })()`);
    await sleep(200);
    const filled = await evalIn(cdp, ps, `(() => {
      const box = document.querySelector('agent-dialog .agent-mcp-box');
      const ed = box.querySelector('.mcp-editor');
      if (!ed) return { ok:false };
      const inputs = ed.querySelectorAll('input');
      const select = ed.querySelector('select');
      inputs[0].value = 'Mine';                 // name
      select.value = 'http';                    // transport
      inputs[1].value = ${JSON.stringify(ownUrl)}; // url
      inputs[2].value = 'Authorization';        // header
      inputs[3].value = 'own-kat-token';        // token
      const save = [...ed.querySelectorAll('button')].find(b => /add server/i.test(b.textContent.trim()));
      save.click();
      return { ok:true };
    })()`);
    check("the own-server editor accepts a private server", filled?.ok === true, filled);
    let ownListed = false;
    for (let i = 0; i < 20; i++) {
      ownListed = await evalIn(cdp, ps, `Boolean(document.querySelector('agent-dialog .agent-mcp-box .mcp-server-card[data-id="mine"]'))`);
      if (ownListed) break;
      await sleep(150);
    }
    check("the agent's own server appears in its list", ownListed === true, ownListed);
    await evalIn(cdp, ps, `(() => {
      const box = document.querySelector('agent-dialog .agent-mcp-box');
      const sc = box?.closest('[style*="overflow"]') || box?.parentElement;
      // Scroll the box to the top of the scroll body so the whole MCP section shows.
      if (box && box.offsetParent) { box.scrollIntoView({ block: 'start' }); }
      const scroller = document.querySelector('agent-dialog .agent-config-container > div');
      if (scroller && box) scroller.scrollTop = box.offsetTop - 60;
      return true;
    })()`);
    await sleep(500);
    await shot(cdp, ps, "02-toggled-off-and-own-added.png");

    // 5) Create the agent (owner-direct save — no separate approval card).
    await evalIn(cdp, ps, `(() => {
      const btns = [...document.querySelectorAll('agent-dialog button')];
      const create = btns.find(b => /create agent/i.test(b.textContent.trim()));
      create.click();
      return true;
    })()`);
    await sleep(2000);

    // 6) Read the new agent back (REDACTED) and assert the effective set.
    const result = await evalIn(cdp, ps, `(async () => {
      const list = await chrome.runtime.sendMessage({ type: 'named-agent.list' });
      const agent = (list?.agents||[]).find(a => a.id === 'kat-mcp-agent') || (list?.agents||[]).find(a => /kat mcp agent/i.test(a.name||''));
      if (!agent) return { found:false };
      const got = await chrome.runtime.sendMessage({ type: 'named-agent.get', id: agent.id });
      const mcp = got?.agent?.mcpServers || [];
      return {
        found: true,
        id: agent.id,
        perAgent: mcp.map(s => ({ id: s.id, enabled: s.enabled !== false, hasToken: s?.auth?.hasToken === true, tokenAbsent: typeof s?.auth?.token === 'undefined' })),
      };
    })()`);
    check("the new agent was created", result?.found === true, result);
    const calcEntry = (result?.perAgent||[]).find((s: any) => s.id === "calc");
    const mineEntry = (result?.perAgent||[]).find((s: any) => s.id === "mine");
    check("the inherited 'calc' is stored DISABLED for this agent", Boolean(calcEntry) && calcEntry.enabled === false, result?.perAgent);
    check("the agent's own 'mine' server is stored ENABLED", Boolean(mineEntry) && mineEntry.enabled === true, result?.perAgent);
    check("the own server's raw token is NEVER returned (redacted read)", Boolean(mineEntry) && mineEntry.tokenAbsent === true, mineEntry);

    // The literal effective set, composed by the same resolver the run uses.
    const globalSet = [{ id: "calc", name: "Calc", transport: "http", url: good.url, enabled: true }];
    const agentSet = (result?.perAgent || []).map((s: any) => ({
      id: s.id, name: s.id, transport: "http", url: s.id === "calc" ? good.url : ownUrl, enabled: s.enabled,
    }));
    const effIds = resolveEffectiveMcpServers(globalSet, agentSet).map((s: any) => s.id).sort();
    check("the resolved effective set is exactly {mine} — inherited calc gone, own present", JSON.stringify(effIds) === JSON.stringify(["mine"]), effIds);
    await shot(cdp, ps, "03-created.png");
  } finally {
    try { ws.close(); } catch { /* */ }
    try { proc.kill("SIGKILL"); } catch { /* */ }
    try { await proc.status; } catch { /* */ }
    try { await good.close(); } catch { /* */ }
    try { await Deno.remove(profile, { recursive: true }); } catch { /* */ }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  Deno.exit(fail === 0 ? 0 : 1);
}

await main();
