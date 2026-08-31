// kat-mcp-transport.ts — CAP-FB-20260831-MCP-TRANSPORT-SPIKE-01 KAT.
//
// Proves REMOTE MCP works from the REAL loaded extension's service-worker
// context, with per-server resilience:
//   1. Stand up a Streamable-HTTP MCP test server (tools: add, echo) and a
//      second, deliberately UNREACHABLE server (a port bound then freed).
//   2. Load the extension in headless Chromium (fresh profile), attach to its
//      service-worker target.
//   3. Inside the SW, dynamically import the developer-only probe bundle and
//      run mount → list → call → teardown against BOTH servers.
//   4. Assert: the reachable server lists its tools and `add(3,5)` returns "8";
//      the unreachable server is reported FAILED without throwing or killing
//      the working one; teardown is clean.
//
//   npm run build            # developer build → dist/dev/mcp-probe.bundle.js
//   deno run -A scripts/kat-mcp-transport.ts
//
// Uses the mandated launchChrome() (kernel-assigned debug port, read from
// stderr) — never a fixed port.

import { launchChrome, waitForServiceWorker } from "./lib/chrome-launch.ts";
import { startMcpTestServer } from "./mcp-test-server.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = `${ROOT}extension`;
const CHROMIUM = "/usr/bin/chromium";
const EVIDENCE = Deno.env.get("CAP_EVIDENCE_DIR") ??
  "/tmp/claude-1000/-home-paulkinlan-chrome-agent-platform/25bf9309-c874-4b40-85db-e95719f9eeb2/scratchpad/work/mcp-transport-spike";

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
    throw new Error(`eval threw: ${JSON.stringify(r.result.exceptionDetails).slice(0, 500)}`);
  }
  return r.result?.result?.value;
}

/** A port that is bound then freed → nothing listens there → ECONNREFUSED. */
async function deadPort(): Promise<number> {
  const l = Deno.listen({ port: 0, hostname: "127.0.0.1" });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  return port;
}

async function main() {
  await Deno.mkdir(EVIDENCE, { recursive: true });

  // Fail early + clearly if the developer SW bundle lacks the injected probe.
  try {
    const sw = await Deno.readTextFile(`${EXT}/dist/background/service-worker.js`);
    if (!sw.includes("__capMcpProbe")) {
      console.log("FAIL: SW bundle lacks __capMcpProbe — run `npm run build` (developer) first");
      Deno.exit(1);
    }
  } catch {
    console.log("FAIL: dist/background/service-worker.js missing — run `npm run build` first");
    Deno.exit(1);
  }

  const good = await startMcpTestServer();          // reachable
  const badPort = await deadPort();                 // unreachable
  const badUrl = `http://127.0.0.1:${badPort}/mcp`;
  console.log(`good MCP server: ${good.url}`);
  console.log(`unreachable MCP server: ${badUrl}`);

  const profile = await Deno.makeTempDir({ prefix: "cap-mcp-transport-kat-" });
  const { proc, wsUrl } = await launchChrome({
    binary: CHROMIUM,
    args: [
      "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
      "--silent-debugger-extension-api",
      `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
      "--window-size=1200,800", `--user-data-dir=${profile}`, "about:blank",
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

    const a = await cdp.send("Target.attachToTarget", { targetId: sw.targetId, flatten: true });
    const swSession = a.result.sessionId as string;
    await cdp.send("Runtime.enable", {}, swSession);

    const servers = [
      { name: "calc", transport: { type: "http", url: good.url } },
      { name: "down", transport: { type: "http", url: badUrl } },
    ];
    const probeArg = { servers, call: { tool: "mcp__calc__add", args: { a: 3, b: 5 } } };

    // The probe is injected directly into the developer SW bundle (SW globals
    // forbid dynamic import()), so it is already installed on globalThis.
    const expr = `(async () => {
      if (typeof globalThis.__capMcpProbe !== 'function') return { error: '__capMcpProbe not installed in SW' };
      return await globalThis.__capMcpProbe(${JSON.stringify(probeArg)});
    })()`;

    const summary = await evalIn(cdp, swSession, expr);
    console.log("probe summary:", JSON.stringify(summary, null, 2));
    await Deno.writeTextFile(`${EVIDENCE}/mcp-probe-summary.json`, JSON.stringify(summary, null, 2));

    const calc = summary?.servers?.find((s: any) => s.name === "calc");
    const down = summary?.servers?.find((s: any) => s.name === "down");

    check("SW connected to the reachable MCP server", calc?.ok === true, calc);
    check("the reachable server exposed both tools", calc?.toolCount === 2, calc);
    check("the namespaced add tool is mounted", (summary?.tools ?? []).includes("mcp__calc__add"), summary?.tools);
    check("calling mcp__calc__add(3,5) over Streamable-HTTP returns 8", summary?.call?.ok === true && summary?.call?.result === "8", summary?.call);

    // Per-server resilience: the unreachable server failed WITHOUT killing the run.
    check("the unreachable server is reported failed", down?.ok === false, down);
    check("the failure carries an error message", typeof down?.error === "string" && down.error.length > 0, down);
    check("the failing server did NOT throw / abort the whole mount", summary?.error === null, summary?.error);
    check("teardown was clean (all clients closed)", summary?.closedOk === true, summary);

    // Screenshot evidence: the SW has no page, so capture the options page as a
    // visual anchor and rely on mcp-probe-summary.json for the transport proof.
    try {
      const res = await fetch(`http://127.0.0.1:${new URL(wsUrl).port}/json/new?${encodeURI(`chrome-extension://${extId}/options/options.html`)}`, { method: "PUT" });
      const target = await res.json();
      const pa = await cdp.send("Target.attachToTarget", { targetId: target.id, flatten: true });
      const ps = pa.result.sessionId as string;
      await cdp.send("Page.enable", {}, ps);
      await sleep(1200);
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, ps);
      if (shot.result?.data) {
        await Deno.writeFile(`${EVIDENCE}/mcp-transport-options.png`, Uint8Array.from(atob(shot.result.data), (c) => c.charCodeAt(0)));
        console.log(`  evidence: ${EVIDENCE}/mcp-transport-options.png`);
      }
    } catch (e) {
      console.log(`  (options screenshot skipped: ${String((e as Error)?.message ?? e)})`);
    }
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
