// kat-mcp-global-ui.ts — CAP-FB-20260831-MCP-GLOBAL-UI-01 KAT.
//
// Drives the REAL Settings "MCP servers" section in a loaded extension:
//   1. Stand up a Streamable-HTTP MCP test server (tools: add, echo).
//   2. Load the extension (fresh profile), open options#mcp-servers.
//   3. Add a reachable server (name + url + an auth token) in the form, click
//      "Test connection" → assert it CONNECTS and lists the tools.
//   4. Save it → assert it appears in the list AND that mcp.servers.get returns
//      the server REDACTED (auth.hasToken present, the raw token absent) — the
//      token is never shown to the page after save (provider-key parity).
//   5. Add a server with a BAD url → Test connection → assert an HONEST error.
//   Screenshots at each stage.
//
//   npm run build:production            # or `npm run build`
//   deno run -A scripts/kat-mcp-global-ui.ts
//
// Uses the mandated launchChrome() (kernel-assigned debug port from stderr).

import { launchChrome, waitForServiceWorker } from "./lib/chrome-launch.ts";
import { startMcpTestServer } from "./mcp-test-server.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = `${ROOT}extension`;
const CHROMIUM = "/usr/bin/chromium";
const EVIDENCE = Deno.env.get("CAP_EVIDENCE_DIR") ??
  "/tmp/claude-1000/-home-paulkinlan-chrome-agent-platform/25bf9309-c874-4b40-85db-e95719f9eeb2/scratchpad/work/mcp-global-ui";

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

async function main() {
  await Deno.mkdir(EVIDENCE, { recursive: true });

  // Require the mount to be in the SW bundle (the build inject).
  try {
    const sw = await Deno.readTextFile(`${EXT}/dist/background/service-worker.js`);
    if (!sw.includes("registerMcpMount")) {
      console.log("FAIL: SW bundle lacks the MCP mount inject — run `npm run build:production` first");
      Deno.exit(1);
    }
  } catch {
    console.log("FAIL: dist/background/service-worker.js missing — run a build first");
    Deno.exit(1);
  }

  const good = await startMcpTestServer();
  // A port bound then freed → nothing listens → connection refused.
  const l = Deno.listen({ port: 0, hostname: "127.0.0.1" });
  const badPort = (l.addr as Deno.NetAddr).port; l.close();
  const badUrl = `http://127.0.0.1:${badPort}/mcp`;
  console.log(`good MCP server: ${good.url}`);
  console.log(`bad  MCP server: ${badUrl}`);

  const profile = await Deno.makeTempDir({ prefix: "cap-mcp-global-ui-kat-" });
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
    const sw = await waitForServiceWorker(cdp.send.bind(cdp), { timeoutMs: 20000 });
    if (!sw) { console.log("FAIL: service worker never registered"); Deno.exit(1); }
    const extId = sw.url.split("/")[2];
    console.log(`extension id: ${extId}`);

    // Open the options page at the MCP servers section.
    const optUrl = `chrome-extension://${extId}/options/options.html#mcp-servers`;
    const res = await fetch(`http://127.0.0.1:${new URL(wsUrl).port}/json/new?${encodeURIComponent(optUrl)}`, { method: "PUT" });
    const target = await res.json();
    const pa = await cdp.send("Target.attachToTarget", { targetId: target.id, flatten: true });
    const ps = pa.result.sessionId as string;
    await cdp.send("Page.enable", {}, ps);
    await cdp.send("Runtime.enable", {}, ps);
    await sleep(1500);

    // The section + nav render.
    const sectionOk = await evalIn(cdp, ps, `(() => {
      const nav = document.querySelector('[data-section="mcp-servers"]');
      const panel = document.getElementById('mcp-servers');
      const addBtn = document.getElementById('mcp-add-btn');
      return Boolean(nav && panel && addBtn);
    })()`);
    check("Settings shows an MCP servers section with an Add button", sectionOk === true, sectionOk);
    await shot(cdp, ps, "01-mcp-section.png");

    // Open the editor and fill the reachable server (with an auth token).
    const opened = await evalIn(cdp, ps, `(() => {
      document.getElementById('mcp-add-btn').click();
      const ed = document.getElementById('mcp-editor');
      if (!ed || ed.hidden) return { ok:false };
      const inputs = ed.querySelectorAll('input');
      const select = ed.querySelector('select');
      // grid order: name, transport(select), url, header, token
      inputs[0].value = 'calc';           // name
      select.value = 'http';              // transport
      inputs[1].value = ${JSON.stringify(good.url)}; // url
      inputs[2].value = 'Authorization';  // auth header
      inputs[3].value = 'Bearer sekret-kat-token'; // auth token
      return { ok:true, count: inputs.length };
    })()`);
    check("the Add-server editor opens with the credential fields", opened?.ok === true, opened);

    // Test connection → wait for the status to settle.
    await evalIn(cdp, ps, `(() => {
      const btns = [...document.querySelectorAll('#mcp-editor button')];
      btns.find(b => b.textContent.trim() === 'Test connection').click();
      return true;
    })()`);
    let status = "";
    for (let i = 0; i < 40; i++) {
      status = await evalIn(cdp, ps, `(document.querySelector('#mcp-editor .test-status')?.textContent || '')`);
      if (status && !/testing/i.test(status)) break;
      await sleep(300);
    }
    console.log("test-connection status:", status);
    check("Test connection CONNECTS to the reachable server", /connected/i.test(status), status);
    check("Test connection lists the server's tools (add, echo)", /add/.test(status) && /echo/.test(status), status);
    await shot(cdp, ps, "02-test-connected.png");

    // Save the server.
    await evalIn(cdp, ps, `(() => {
      const btns = [...document.querySelectorAll('#mcp-editor button')];
      btns.find(b => /add server|save changes/i.test(b.textContent.trim())).click();
      return true;
    })()`);
    let listed = false;
    for (let i = 0; i < 20; i++) {
      listed = await evalIn(cdp, ps, `Boolean(document.querySelector('#mcp-server-list .mcp-server-card[data-id="calc"]'))`);
      if (listed) break;
      await sleep(200);
    }
    check("the saved server appears in the list", listed === true, listed);
    await shot(cdp, ps, "03-server-saved.png");

    // Redaction: mcp.servers.get returns the token REDACTED (hasToken, no token).
    const redacted = await evalIn(cdp, ps, `(async () => {
      const r = await chrome.runtime.sendMessage({ type: 'mcp.servers.get' });
      const s = (r?.servers || []).find(x => x.id === 'calc');
      return {
        found: Boolean(s),
        hasTokenBit: s?.auth?.hasToken === true,
        rawTokenAbsent: typeof s?.auth?.token === 'undefined',
        header: s?.auth?.headerName,
      };
    })()`);
    check("the saved credential is stored (hasToken bit set)", redacted?.hasTokenBit === true, redacted);
    check("the raw token is NEVER returned to the page (redacted read)", redacted?.rawTokenAbsent === true, redacted);

    // Re-open the editor on the saved server: the token field is EMPTY (never
    // pre-filled), with a "leave blank to keep" hint.
    const editHint = await evalIn(cdp, ps, `(() => {
      const card = document.querySelector('#mcp-server-list .mcp-server-card[data-id="calc"]');
      [...card.querySelectorAll('button')].find(b => b.textContent.trim() === 'Edit').click();
      const ed = document.getElementById('mcp-editor');
      const inputs = ed.querySelectorAll('input');
      const token = inputs[3];
      return { tokenValue: token.value, placeholder: token.placeholder };
    })()`);
    check("editing never pre-fills the stored token", editHint?.tokenValue === "", editHint);
    check("the token field shows a 'leave blank to keep' hint", /leave blank to keep/i.test(editHint?.placeholder || ""), editHint);
    // Close the editor.
    await evalIn(cdp, ps, `[...document.querySelectorAll('#mcp-editor button')].find(b=>b.textContent.trim()==='Cancel').click()`);

    // Bad URL → Test connection → honest error.
    await evalIn(cdp, ps, `(() => {
      document.getElementById('mcp-add-btn').click();
      const ed = document.getElementById('mcp-editor');
      const inputs = ed.querySelectorAll('input');
      inputs[0].value = 'down';
      inputs[1].value = ${JSON.stringify(badUrl)};
      [...ed.querySelectorAll('button')].find(b => b.textContent.trim() === 'Test connection').click();
      return true;
    })()`);
    let badStatus = "";
    for (let i = 0; i < 40; i++) {
      badStatus = await evalIn(cdp, ps, `(document.querySelector('#mcp-editor .test-status')?.textContent || '')`);
      if (badStatus && !/testing/i.test(badStatus)) break;
      await sleep(300);
    }
    console.log("bad-url status:", badStatus);
    check("a bad url shows an HONEST failure (not a silent pass)", /failed/i.test(badStatus), badStatus);
    await shot(cdp, ps, "04-bad-url-error.png");
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
