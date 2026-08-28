// kat-agent-delegation.ts — agent→agent delegation (G5) contract KAT, real
// browser + real loaded extension + the deterministic demo model (zero-config
// provider). Proves the OWNER-FACING behaviour end to end:
//
//   1. Two real named agents are created through the REAL message bus — a
//      "Delegator Prime" whose record lists "helper-bee" in canDelegateTo, and
//      "Helper Bee" itself, plus a "Solo Agent" with NO delegation edges.
//   2. The delegator runs "@demo-delegate-agent helper-bee": the demo model
//      issues a REAL delegate_to_agent management call; the child runs in its
//      OWN sandbox (its @demo-tools sequence writes ITS memory), and the
//      result returns to the parent run as the tool result.
//   3. Assertions: parent run result reflects the child; the DURABLE audit
//      log records parent→child (run ids, agents, outcome); the child's own
//      journal carries its run; the parent's journal carries the
//      delegate_to_agent tool pair WITH the child run id (the run-view
//      linkage the tool card renders).
//   4. DENIAL: the edge-less solo agent's delegation attempt completes with
//      the structured "not allowed to delegate" denial text in its run output.
//   5. UI: the parent's agent-chat surface renders the delegation (screenshot).
//
//   deno run -A scripts/kat-agent-delegation.ts <path-to-extension> [<out-dir>]
const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? `${ROOT}.cache/kat-agent-delegation`;
const CHROMIUM = "/home/paulkinlan/.cache/puppeteer/chrome/linux-140.0.7339.82/chrome-linux64/chrome";
const PORT = 9377;
const STAMP = Date.now();
let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

try { await Deno.stat(`${EXT}/dist/background/service-worker.js`); } catch {
  console.log("FAIL: extension is not built (missing dist/background/service-worker.js) — run npm run build:production first");
  Deno.exit(1);
}

const proc = new Deno.Command(CHROMIUM, {
  args: ["--headless=new", "--no-sandbox", "--disable-gpu", "--silent-debugger-extension-api",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    `--remote-debugging-port=${PORT}`, "--remote-allow-origins=*",
    `--user-data-dir=${ROOT}.cache/kat-agent-delegation-${STAMP}`, "about:blank"],
  stdout: "null", stderr: "piped",
}).spawn();

let ws: WebSocket | null = null;
try {
  const wsUrl = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("no devtools url")), 15000);
    (async () => { for (;;) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); const j = await r.json(); clearTimeout(t); resolve(j.webSocketDebuggerUrl); return; } catch { await sleep(300); } } })();
  });
  ws = new WebSocket(wsUrl);
  await new Promise((r) => ws!.onopen = r);
} catch (e) {
  console.log(`FAIL: could not start Chrome for Testing — ${String(e)}`);
  proc.kill(); Deno.exit(1);
}
let id = 0; const pending = new Map<string, (v: any) => void>();
ws!.onmessage = (m: MessageEvent) => { const j = JSON.parse(m.data); if (j.id && pending.has(String(j.id))) { pending.get(String(j.id))!(j); pending.delete(String(j.id)); } };
const send = (method: string, params: any = {}, sessionId?: string) => new Promise<any>((res) => {
  const mid = ++id; pending.set(String(mid), res);
  ws!.send(JSON.stringify({ id: mid, method, params, sessionId }));
});

let swTarget: any = null;
for (let i = 0; i < 20 && !swTarget; i++) {
  await sleep(500);
  const { result: { targetInfos } } = await send("Target.getTargets");
  swTarget = targetInfos.find((t: any) => t.type === "service_worker" && String(t.url).includes("dist/background"));
}
if (!swTarget) { console.log("FAIL: no service worker target"); proc.kill(); Deno.exit(1); }
const extId = new URL(swTarget.url).host;
await Deno.mkdir(OUT, { recursive: true });

// Capture the SW console (the demo model's [demo-deleg] step probe).
const swAttach = await send("Target.attachToTarget", { targetId: swTarget.targetId ?? swTarget.id, flatten: true });
const swSession = swAttach?.result?.sessionId;
if (swSession) await send("Runtime.enable", {}, swSession);
const swLog = (m: MessageEvent) => {
  try {
    const j = JSON.parse(m.data);
    if (j.method === "Runtime.consoleAPICalled") {
      const text = (j.params?.args ?? []).map((a: any) => a?.value ?? a?.description ?? "").join(" ");
      if (String(text).includes("[demo-deleg]")) console.log("SW>", text);
    }
  } catch { /* ignore */ }
};
ws!.addEventListener("message", swLog);

const newView = async (url: string) => {
  const { result: { targetId } } = await send("Target.createTarget", { url });
  const { result: { sessionId } } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Runtime.enable", {}, sessionId);
  await send("Page.enable", {}, sessionId);
  const ev = async (expr: string) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId)).result?.result?.value;
  const shot = async (path: string) => {
    const { result } = await send("Page.captureScreenshot", { format: "png" }, sessionId);
    await Deno.writeFile(path, Uint8Array.from(atob(result.data), (c) => c.charCodeAt(0)));
  };
  return { targetId, sessionId, ev, shot };
};

// A long-timeout route caller inside the page (a delegation run spans two
// agent loops + OPFS writes — far past the UI's 12s default).
const ROUTE_HELPER = `(() => {
  if (globalThis.__katSend) return true;
  globalThis.__katSend = (type, payload, timeoutMs = 180000) => new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve({ ok: false, error: "kat route timeout" }); } }, timeoutMs);
    chrome.runtime.sendMessage({ type, ...payload }, (res) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(res ?? { ok: false, error: chrome.runtime.lastError?.message ?? "no response" });
    });
  });
  return true;
})()`;

try {
  const page = await newView(`chrome-extension://${extId}/ntp/ntp.html`);
  await sleep(2000);
  await page.ev(ROUTE_HELPER);

  // ── 1. Real agents through the real bus ──────────────────────────────────
  const helper = await page.ev(`globalThis.__katSend("named-agent.create", { name: "Helper Bee", role: "You help with small delegated subtasks and report concisely." })`);
  check("helper agent created", helper?.ok === true, helper);
  const solo = await page.ev(`globalThis.__katSend("named-agent.create", { name: "Solo Agent", role: "You work alone." })`);
  check("solo agent created (no delegation edges)", solo?.ok === true, solo);
  const delegator = await page.ev(`globalThis.__katSend("named-agent.create", { name: "Delegator Prime", role: "You coordinate: delegate specialist subtasks to the agents in your delegation list and synthesize their results.", canDelegateTo: ["helper-bee"] })`);
  check("delegator created with canDelegateTo=[helper-bee]", delegator?.ok === true, delegator);
  const got = await page.ev(`globalThis.__katSend("named-agent.get", { id: "delegator-prime" })`);
  check("the edge persisted on the record", JSON.stringify(got?.agent?.canDelegateTo) === JSON.stringify(["helper-bee"]), got?.agent?.canDelegateTo);

  // ── 2. The allowed delegation runs end to end ────────────────────────────
  const run = await page.ev(`globalThis.__katSend("named-agent.run", { id: "delegator-prime", task: "@demo-delegate-agent helper-bee" })`);
  check("parent run completed", run?.ok === true, run);
  check("parent result reflects the child delegation", typeof run?.result === "string" && run.result.includes("Agent delegation succeeded"), String(run?.result ?? "").slice(0, 200));

  // ── 3. Audit + journals ──────────────────────────────────────────────────
  const audit = await page.ev(`globalThis.__katSend("named-agent.delegations", {})`);
  check("the delegation audit log has the entry", audit?.ok === true && audit.count >= 1, audit);
  console.log("AUDIT-ENTRIES", JSON.stringify(audit?.entries?.map((e) => ({ from: e.from, to: e.to, outcome: e.outcome, childRunId: e.childRunId, detail: e.detail }))));
  const rec = audit?.entries?.find((e) => e.outcome === "ok") ?? audit?.entries?.[0];
  check("audit: delegator → helper, outcome ok", rec?.from === "Delegator Prime" && rec?.to === "Helper Bee" && rec?.outcome === "ok", rec);
  check("audit: parent + child run ids recorded", typeof rec?.parentRunId === "string" && typeof rec?.childRunId === "string" && rec.parentRunId.length > 0 && rec.childRunId.startsWith("delegate:"), rec);

  const parentHist = await page.ev(`globalThis.__katSend("named-agent.history", { id: "delegator-prime" })`);
  const parentRows = JSON.stringify(parentHist?.entries ?? []);
  console.log("PARENT-TOOLCALLS", JSON.stringify((parentHist?.entries ?? []).filter((e) => JSON.stringify(e).includes("delegate_to_agent")).map((e) => ({ type: e.type, tool: e.toolName ?? e.tool, callId: e.callId ?? null, args: JSON.stringify(e.args ?? e.input ?? "").slice(0, 120) }))));
  check("parent journal carries the delegate_to_agent tool pair", parentRows.includes("delegate_to_agent"), parentRows.slice(0, 300));
  check("parent journal links the child run id", rec?.childRunId && parentRows.includes(rec.childRunId), rec?.childRunId);

  const childHist = await page.ev(`globalThis.__katSend("named-agent.history", { id: "helper-bee" })`);
  const childRows = JSON.stringify(childHist?.entries ?? []);
  check("child journal carries its OWN run (its sandbox, its tools)", childRows.includes("@demo-tools") || childRows.includes("memory_set"), childRows.slice(0, 300));

  // ── 4. The edge-less agent is denied ─────────────────────────────────────
  const denied = await page.ev(`globalThis.__katSend("named-agent.run", { id: "solo-agent", task: "@demo-delegate-agent helper-bee" })`);
  check("the edge-less delegation completes honestly", denied?.ok === true, denied);
  check("the denial is the structured not-allowed text", typeof denied?.result === "string" && denied.result.includes("not allowed to delegate"), String(denied?.result ?? "").slice(0, 240));

  // ── 5. UI linkage: the parent's agent-chat renders the delegation ────────
  const chat = await newView(`chrome-extension://${extId}/ntp/ntp.html#agent=named:delegator-prime`);
  await sleep(2500);
  const chatText = await chat.ev(`document.body.innerText.slice(0, 4000)`);
  check("the agent-chat surface renders the delegation", typeof chatText === "string" && /delegate_to_agent|Helper Bee/i.test(chatText), String(chatText ?? "").slice(0, 200));
  await chat.shot(`${OUT}/delegation-parent-chat.png`);
} finally {
  try { proc.kill(); } catch { /* already gone */ }
}
console.log(`\nKAT agent-delegation: ${pass} passed, ${fail} failed`);
Deno.exit(fail ? 1 : 0);
