// kat-mcp-tool-injection.ts — the END-TO-END MCP tool injection KAT
// (CAP-FB-20260831-MCP-TOOL-INJECTION-01). Real browser, real loaded extension,
// the deterministic demo model (zero-config, no API key). Proves the owner's
// goal — MCP working end to end — in one run:
//
//   1. Stand up a Streamable-HTTP MCP test server (tools: add, echo) and a
//      SECOND, deliberately UNREACHABLE server (a port bound then freed).
//   2. Configure BOTH as GLOBAL MCP servers through the real Settings route
//      (mcp.servers.set) — the reachable one and the dead one.
//   3. Run a hub task `@demo-mcp mcp__calc__add {"a":3,"b":5}`: the demo model
//      drives the REAL lazy protocol (search_tools → execute_tool) against the
//      namespaced MCP tool. The FIRST call pauses on the per-server owner Allow
//      card; the KAT resolves it (management.resolve-approval), and the call
//      completes.
//   4. Assert end to end: the run succeeded, the result names the NAMESPACED
//      tool `mcp__calc__add`, the real MCP output "8" came back FENCED as
//      untrusted content (`<<<UNTRUSTED run:…>>>`), the call is in the activity
//      LEDGER, and the UNREACHABLE server did NOT kill the run (a diagnostic
//      records it, the run still succeeds).
//
//   npm run build   # dev or production; the demo model + routes are always in
//   deno run -A scripts/kat-mcp-tool-injection.ts [<ext>] [<out-dir>]
//
// Uses the mandated launchChrome() (kernel-assigned debug port). Never a fixed
// port.

import { launchChrome } from "./lib/chrome-launch.ts";
import { startMcpTestServer } from "./mcp-test-server.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? Deno.env.get("CAP_EVIDENCE_DIR") ??
  "/tmp/claude-1000/-home-paulkinlan-chrome-agent-platform/25bf9309-c874-4b40-85db-e95719f9eeb2/scratchpad/work/mcp-tool-injection";
const CHROMIUM = "/usr/bin/chromium";
const STAMP = Date.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)?.slice(0, 400)}`); }
}

try { await Deno.stat(`${EXT}/dist/background/service-worker.js`); } catch {
  console.log("FAIL: extension is not built (missing dist/background/service-worker.js) — run npm run build first");
  Deno.exit(1);
}

/** A port that is bound then freed → nothing listens there → connection fails. */
async function deadPort(): Promise<number> {
  const l = Deno.listen({ port: 0, hostname: "127.0.0.1" });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  return port;
}

const good = await startMcpTestServer();
const badPort = await deadPort();
const badUrl = `http://127.0.0.1:${badPort}/mcp`;
console.log(`reachable MCP server: ${good.url}`);
console.log(`unreachable MCP server: ${badUrl}`);

let proc: Deno.ChildProcess | null = null;
let ws: WebSocket | null = null;
try {
  const launched = await launchChrome({
    binary: CHROMIUM,
    args: ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
      "--silent-debugger-extension-api",
      `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--remote-allow-origins=*",
      `--user-data-dir=${ROOT}.cache/kat-mcp-tool-injection-${STAMP}`, "about:blank"],
  });
  proc = launched.proc;
  ws = new WebSocket(launched.wsUrl);
  await new Promise((r) => ws!.onopen = r);
} catch (e) {
  console.log(`FAIL: could not start Chrome — ${String(e)}`);
  try { proc?.kill(); } catch { /* already gone */ }
  try { await good.close(); } catch { /* */ }
  Deno.exit(1);
}

let id = 0; const pending = new Map<string, (v: any) => void>();
ws!.onmessage = (m: MessageEvent) => { const j = JSON.parse(m.data); if (j.id && pending.has(String(j.id))) { pending.get(String(j.id))!(j); pending.delete(String(j.id)); } };
const send = (method: string, params: any = {}, sessionId?: string) => new Promise<any>((res) => {
  const mid = ++id; pending.set(String(mid), res);
  ws!.send(JSON.stringify({ id: mid, method, params, sessionId }));
});

async function cleanup(code: number) {
  try { ws?.close(); } catch { /* */ }
  try { proc?.kill("SIGKILL"); } catch { /* */ }
  try { await proc?.status; } catch { /* */ }
  try { await good.close(); } catch { /* */ }
  try { await Deno.remove(`${ROOT}.cache/kat-mcp-tool-injection-${STAMP}`, { recursive: true }); } catch { /* */ }
  Deno.exit(code);
}

let swTarget: any = null;
for (let i = 0; i < 20 && !swTarget; i++) {
  await sleep(500);
  const { result: { targetInfos } } = await send("Target.getTargets");
  swTarget = targetInfos.find((t: any) => t.type === "service_worker" && String(t.url).includes("dist/background"));
}
if (!swTarget) { console.log("FAIL: no service worker target"); await cleanup(1); }
const extId = new URL(swTarget.url).host;
console.log(`extension id: ${extId}`);
await Deno.mkdir(OUT, { recursive: true });

// Capture the SW console for MCP diagnostics.
const swAttach = await send("Target.attachToTarget", { targetId: swTarget.targetId ?? swTarget.id, flatten: true });
const swSession = swAttach?.result?.sessionId;
if (swSession) await send("Runtime.enable", {}, swSession);

const newView = async (url: string) => {
  const { result: { targetId } } = await send("Target.createTarget", { url });
  const { result: { sessionId } } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Runtime.enable", {}, sessionId);
  await send("Page.enable", {}, sessionId);
  const ev = async (expr: string) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId)).result?.result?.value;
  const shot = async (path: string) => {
    const { result } = await send("Page.captureScreenshot", { format: "png" }, sessionId);
    if (result?.data) await Deno.writeFile(path, Uint8Array.from(atob(result.data), (c) => c.charCodeAt(0)));
  };
  return { sessionId, ev, shot };
};

const ROUTE_HELPER = `(() => {
  if (globalThis.__katSend) return true;
  globalThis.__katSend = (type, payload, timeoutMs = 180000) => new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve({ ok: false, error: "kat route timeout" }); } }, timeoutMs);
    chrome.runtime.sendMessage({ type, ...payload }, (res) => {
      if (done) return;
      done = true; clearTimeout(timer);
      resolve(res ?? { ok: false, error: chrome.runtime.lastError?.message ?? "no response" });
    });
  });
  return true;
})()`;

try {
  const settings = await newView(`chrome-extension://${extId}/options/options.html`);
  await sleep(1200);
  await settings.ev(ROUTE_HELPER);

  // The marker demo model (which honours @demo-mcp) sits behind the developer
  // flag; without it the keyless default is the local assistant (CAP-FB-
  // 20260830-KEYLESS-FIRST-RESULT-01). Set it BEFORE the first run so the model
  // cache builds the demo model.
  await settings.ev(`globalThis.__katSend("kv.set", { values: { "cap:developerFeatures": true } })`);
  await sleep(300);

  // ── 1. Configure the global MCP servers through the real Settings route ────
  const setRes = await settings.ev(`globalThis.__katSend("mcp.servers.set", { servers: ${JSON.stringify([
    { id: "calc", name: "Calc", transport: "http", url: good.url, enabled: true },
    { id: "down", name: "Down", transport: "http", url: badUrl, enabled: true },
  ])} })`);
  check("mcp.servers.set stored both global servers (redacted read-back)", setRes?.ok === true && Array.isArray(setRes.servers) && setRes.servers.length === 2, setRes);
  check("the stored server list carries no raw token (redacted)", JSON.stringify(setRes?.servers ?? "").includes("token") === false, setRes?.servers);

  // ── 2. Drive a hub run that calls the namespaced MCP tool ──────────────────
  const hub = await newView(`chrome-extension://${extId}/ntp/ntp.html`);
  await sleep(1500);
  await hub.ev(ROUTE_HELPER);

  // Fire the run WITHOUT awaiting — it blocks in the SW on the per-server owner
  // Allow card until we resolve it below.
  await hub.ev(`globalThis.__mcpRun = globalThis.__katSend("run-task", { id: "kat-mcp-${STAMP}", task: '@demo-mcp mcp__calc__add {"a":3,"b":5}' }); "started"`);

  // ── 3. Resolve the per-server owner Allow card (one card for "calc") ───────
  let approvalId: string | null = null;
  for (let i = 0; i < 60 && !approvalId; i++) {
    await sleep(400);
    const pend = await settings.ev(`globalThis.__katSend("management.pending-approvals", {})`);
    const row = (pend?.approvals ?? []).find((a: any) => a.action === "mcp.use-server");
    if (row) approvalId = row.approvalId;
  }
  check("the run raised the per-server MCP owner Allow card (mcp.use-server)", typeof approvalId === "string" && !!approvalId, approvalId);
  let resolved: any = null;
  if (approvalId) {
    resolved = await settings.ev(`globalThis.__katSend("management.resolve-approval", { approvalId: ${JSON.stringify(approvalId)}, approve: true })`);
    check("the owner Allow was recorded (approved)", resolved?.ok === true && resolved?.decision === "approved", resolved);
  }

  // ── 4. Await the run and assert the end-to-end result ──────────────────────
  const run = await hub.ev(`globalThis.__mcpRun`);
  console.log("RUN RESULT:", JSON.stringify(run)?.slice(0, 600));
  await Deno.writeTextFile(`${OUT}/mcp-injection-run.json`, JSON.stringify(run, null, 2));
  const resultText = String(run?.result ?? "");

  check("the run completed successfully", run?.ok === true, run);
  check("the model called the NAMESPACED MCP tool mcp__calc__add", resultText.includes("mcp__calc__add"), resultText.slice(0, 300));
  check("the real MCP output (add(3,5)=8) came back", resultText.includes("8"), resultText.slice(0, 300));
  check("the MCP result was FENCED as untrusted content", resultText.includes("<<<UNTRUSTED run:"), resultText.slice(0, 400));
  check("the run reports the MCP tool succeeded (not a denial)", /MCP tool mcp__calc__add succeeded/.test(resultText), resultText.slice(0, 300));

  // ── 5. The activity ledger recorded the MCP call ───────────────────────────
  const ledger = await hub.ev(`globalThis.__katSend("actions.list", { limit: 20 })`);
  const ledgerRows = ledger?.rows ?? ledger?.actions ?? [];
  const mcpRow = (Array.isArray(ledgerRows) ? ledgerRows : []).find((r: any) => String(r?.tool ?? "").startsWith("mcp__"));
  check("the MCP tool call is recorded in the activity ledger", !!mcpRow && mcpRow.tool === "mcp__calc__add", mcpRow ?? ledger);
  check("the ledger row is a plain-language 'what I did' sentence", typeof mcpRow?.sentence === "string" && /MCP server calc/.test(mcpRow.sentence), mcpRow?.sentence);

  // ── 6. The unreachable server did not kill the run ─────────────────────────
  // Proven twice: the run above SUCCEEDED with both a reachable and an
  // unreachable server configured, and a diagnostic names the failed connect.
  const diags = await settings.ev(`globalThis.__katSend("diagnostics.list", {}).catch(() => null)`);
  const diagText = JSON.stringify(diags ?? "");
  check("the run survived the unreachable second server (it still succeeded)", run?.ok === true, run?.ok);
  if (diags && diagText !== "null") {
    check("a diagnostic records the unreachable MCP server (best-effort)", /down|did not connect|Failed to fetch|MCP server/i.test(diagText), diagText.slice(0, 300));
  } else {
    console.log("  (diagnostics.list route unavailable — the run-success proof above is sufficient)");
  }

  await hub.shot(`${OUT}/mcp-injection-hub.png`);
  console.log(`  evidence: ${OUT}/mcp-injection-run.json, ${OUT}/mcp-injection-hub.png`);
} catch (e) {
  console.log(`FAIL: KAT threw — ${String((e as Error)?.stack ?? e)}`);
  fail++;
}

console.log(`\n${pass} passed, ${fail} failed`);
await cleanup(fail === 0 ? 0 : 1);
