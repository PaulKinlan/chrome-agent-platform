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
  const delegator = await page.ev(`globalThis.__katSend("named-agent.create", { name: "Delegator Prime", role: "You coordinate: delegate specialist subtasks to the agents in your delegation list and synthesize their results.", canDelegateTo: ["helper-bee", "mid-agent", "critic"] })`);
  check("delegator created with delegation edges", delegator?.ok === true, delegator);
  const got = await page.ev(`globalThis.__katSend("named-agent.get", { id: "delegator-prime" })`);
  check("the edges persisted on the record", JSON.stringify(got?.agent?.canDelegateTo) === JSON.stringify(["helper-bee", "mid-agent", "critic"]), got?.agent?.canDelegateTo);
  const mid = await page.ev(`globalThis.__katSend("named-agent.create", { name: "Mid Agent", role: "You pass work down the chain.", canDelegateTo: ["leaf-agent"] })`);
  check("mid agent created (chain depth 1)", mid?.ok === true, mid);
  const leaf = await page.ev(`globalThis.__katSend("named-agent.create", { name: "Leaf Agent", role: "You are the end of the chain.", canDelegateTo: ["helper-bee"] })`);
  check("leaf agent created (chain depth 2)", leaf?.ok === true, leaf);
  const critic = await page.ev(`globalThis.__katSend("named-agent.create", { name: "Critic", role: "You review work critically." })`);
  check("critic created (parallel sibling target)", critic?.ok === true, critic);

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

  // Fire-and-poll route caller (the cancellation probe must cancel WHILE the
  // parent run is live — an awaited sendMessage would block the page's eval).
  await page.ev(`(() => {
    globalThis.__katBg = {};
    globalThis.__katSendBg = (name, type, payload) => {
      globalThis.__katBg[name] = { done: false, res: null };
      chrome.runtime.sendMessage({ type, ...payload }, (res) => {
        globalThis.__katBg[name] = { done: true, res: res ?? { ok: false, error: chrome.runtime.lastError?.message ?? "no response" } };
      });
      return true;
    };
    return true;
  })()`);

  // ── 6. DEPTH-2 routing: delegator → mid → leaf, audited at each hop ──────
  const chain = await page.ev(`globalThis.__katSend("named-agent.run", { id: "delegator-prime", task: "@demo-delegate-agent mid-agent @demo-delegate-agent leaf-agent" })`);
  check("depth-2 chain run completed", chain?.ok === true, chain);
  const audit2 = await page.ev(`globalThis.__katSend("named-agent.delegations", {})`);
  const hop1 = (audit2?.entries ?? []).find((e) => e.fromAgentId === "delegator-prime" && e.toAgentId === "mid-agent" && e.outcome === "ok");
  const hop2 = (audit2?.entries ?? []).find((e) => e.fromAgentId === "mid-agent" && e.toAgentId === "leaf-agent" && e.outcome === "ok");
  check("audit: hop 1 delegator→mid at depth 1 with stable ids", hop1?.depth === 1 && typeof hop1?.fromAgentId === "string" && hop1.fromAgentId.length > 0, hop1);
  check("audit: hop 2 mid→leaf at depth 2 with stable ids", hop2?.depth === 2 && hop2?.fromAgentId === "mid-agent" && hop2?.toAgentId === "leaf-agent", hop2);
  check("audit: budget fields ride the executed records", Number.isFinite(hop1?.parentRemaining) && Number.isFinite(hop1?.childCap) && hop1.childCap > 0, hop1);

  // ── 6b. DEPTH LIMIT: a depth-2 run's own delegation is DENIED + audited ──
  const deep = await page.ev(`globalThis.__katSend("named-agent.run", { id: "delegator-prime", task: "@demo-delegate-agent mid-agent @demo-delegate-agent leaf-agent @demo-delegate-agent helper-bee" })`);
  check("over-deep chain run completes honestly", deep?.ok === true, deep);
  const audit3 = await page.ev(`globalThis.__katSend("named-agent.delegations", {})`);
  const depthDenied = (audit3?.entries ?? []).find((e) => e.outcome === "denied" && e.fromAgentId === "leaf-agent");
  check("audit: the leaf's depth-limit DENIAL is durably recorded", depthDenied?.detail === "delegation-depth" && depthDenied?.toAgentId === "helper-bee", depthDenied);

  // ── 7. CANCELLATION CASCADE: cancelling the parent cancels the live child ─
  // "@demo-delegate-slow" makes the CHILD slow while the parent stays fast.
  await page.ev(`globalThis.__katSendBg("cancelrun", "named-agent.run", { id: "delegator-prime", task: "@demo-delegate-agent helper-bee @demo-delegate-slow" })`);
  let parentExec = "", childExec = "";
  for (let i = 0; i < 40 && (!parentExec || !childExec); i++) {
    await sleep(500);
    const lst = await page.ev(`globalThis.__katSend("run.list", {})`);
    const runs = lst?.runs ?? [];
    const p = runs.find((r) => r.agentId === "named:delegator-prime" && r.phase === "running");
    const c = runs.find((r) => r.agentId === "named:helper-bee" && r.phase === "running");
    if (p && !parentExec) parentExec = p.executionId;
    if (c && !childExec) childExec = c.executionId;
  }
  check("cascade probe: parent + child runs are both live", parentExec.length > 0 && childExec.length > 0 && parentExec !== childExec, { parentExec, childExec });
  const cancel = await page.ev(`globalThis.__katSend("run.cancel", { executionId: "${parentExec}" })`);
  check("the parent cancellation is accepted", cancel?.ok === true, cancel);
  let parentRes = null;
  for (let i = 0; i < 60 && !parentRes; i++) {
    await sleep(500);
    const bg = await page.ev(`globalThis.__katBg["cancelrun"]`);
    if (bg?.done) parentRes = bg.res;
  }
  check("the parent run settles cancelled", parentRes?.cancelled === true || String(parentRes?.error ?? "").includes("cancel"), parentRes);
  let childFinalPhase = "";
  for (let i = 0; i < 40 && !childFinalPhase; i++) {
    await sleep(500);
    const lst = await page.ev(`globalThis.__katSend("run.list", {})`);
    const c = (lst?.runs ?? []).find((r) => r.executionId === childExec);
    if (c && c.phase !== "running") childFinalPhase = c.phase;
  }
  check("the CHILD run is cancelled by the cascade — never left spending", childFinalPhase === "cancelled", { childFinalPhase });
  const audit4 = await page.ev(`globalThis.__katSend("named-agent.delegations", {})`);
  const cancelRec = (audit4?.entries ?? []).find((e) => e.outcome === "cancelled" && e.parentRunId === parentExec);
  check("audit: the cancellation is recorded as CANCELLED (not a generic error)", cancelRec?.outcome === "cancelled" && cancelRec?.toAgentId === "helper-bee", cancelRec);

  // ── 7b. CANCEL DURING ADMISSION: allocation is observable BEFORE admit ───
  await page.ev(`(() => {
    globalThis.__katAdmission = { armed: true, event: null, cancel: null, seen: [] };
    const port = chrome.runtime.connect({ name: "agent-progress" });
    globalThis.__katAdmission.port = port;
    port.onMessage.addListener((message) => {
      const ev = message?.type === "progress" ? message.event : message;
      globalThis.__katAdmission.seen.push(ev?.type ?? message?.type ?? "unknown");
      if (globalThis.__katAdmission.seen.length > 40) globalThis.__katAdmission.seen.shift();
      if (!globalThis.__katAdmission.armed || ev?.type !== "delegation-admission") return;
      globalThis.__katAdmission.armed = false;
      globalThis.__katAdmission.event = ev;
      chrome.runtime.sendMessage({ type: "run.cancel", executionId: ev.parentRunId }, (res) => {
        globalThis.__katAdmission.cancel = res ?? { ok: false, error: chrome.runtime.lastError?.message ?? "no response" };
      });
    });
    return true;
  })()`);
  await sleep(1000); // let chrome.runtime.onConnect register before the run starts
  await page.ev(`globalThis.__katSendBg("admissionCancel", "named-agent.run", { id: "delegator-prime", task: "@demo-delegate-agent helper-bee @demo-delegate-slow" })`);
  let admissionState = null;
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    admissionState = await page.ev(`(() => { const s = globalThis.__katAdmission; return s ? { event: s.event, cancel: s.cancel, seen: s.seen } : null; })()`);
    if (admissionState?.event && admissionState?.cancel) break;
  }
  check("admission probe: child id allocated before durable admission", typeof admissionState?.event?.executionId === "string" && admissionState.event.executionId.length > 0, admissionState);
  check("admission probe: parent cancellation accepted at the allocation fence", admissionState?.cancel?.ok === true, admissionState?.cancel);
  let admissionResult = null;
  for (let i = 0; i < 80 && !admissionResult; i++) {
    await sleep(250);
    const bg = await page.ev(`globalThis.__katBg["admissionCancel"]`);
    if (bg?.done) admissionResult = bg.res;
  }
  check("admission probe: parent settles cancelled", admissionResult?.cancelled === true || String(admissionResult?.error ?? "").includes("cancel"), admissionResult);
  const admissionChildId = admissionState?.event?.executionId ?? "";
  let admissionChildPhase = "";
  for (let i = 0; i < 40 && !admissionChildPhase; i++) {
    await sleep(250);
    const lst = await page.ev(`globalThis.__katSend("run.list", {})`);
    const child = (lst?.runs ?? []).find((r) => r.executionId === admissionChildId);
    if (child && child.phase !== "running") admissionChildPhase = child.phase;
  }
  check("admission probe: late child is terminal-cancelled, never orphan-running", admissionChildPhase === "cancelled", { admissionChildId, admissionChildPhase });
  await page.ev(`globalThis.__katAdmission?.port?.disconnect()`);

  // ── 8. COMBINED BUDGET: sequential child spend caps the parent too ───────
  // x2 keeps a successful terminal result while still proving that the second
  // attempt sees the first child's spend; the returned terminal receipt proves
  // own + descendant iterations never exceeded the root's cap.
  const budget = await page.ev(`globalThis.__katSend("named-agent.run", { id: "delegator-prime", task: "@demo-delegate-agent helper-bee @demo-delegate-x2" })`);
  check("the combined-budget run completes honestly", budget?.ok === true, budget);
  const audit5 = await page.ev(`globalThis.__katSend("named-agent.delegations", {})`);
  // Scope to THIS parent run's delegation attempts (its execution id).
  const budgetRun = (audit5?.entries ?? []).filter((e) => e.parentRunId === budget?.executionId);
  const settledCaps = budgetRun.filter((e) => e.outcome !== "denied").map((e) => e.childCap).reverse(); // the log is most-recent-first
  const settledRems = budgetRun.filter((e) => e.outcome !== "denied").map((e) => e.parentRemaining).reverse();
  check("audit: two sequential delegations recorded", settledCaps.length === 2, budgetRun.map((e) => ({ outcome: e.outcome, cap: e.childCap, rem: e.parentRemaining })));
  check("audit: the parent's remaining budget shrinks after child spend", settledRems.length === 2 && settledRems[0] > settledRems[1], settledRems);
  check("terminal budget: parent + subtree never exceeds the root cap", Number.isFinite(budget?.delegationSpend?.total) && budget.delegationSpend.total <= budget.delegationSpend.cap && budget.delegationSpend.cap === 12, budget?.delegationSpend);

  // ── 9. PARALLEL SIBLINGS: two same-step delegations both complete + audit ─
  const parallel = await page.ev(`globalThis.__katSend("named-agent.run", { id: "delegator-prime", task: "@demo-delegate-agent helper-bee @demo-delegate-parallel helper-bee critic" })`);
  check("the parallel-sibling run completes", parallel?.ok === true, parallel);
  check("the model reflects a sibling result", typeof parallel?.result === "string" && parallel.result.includes("Agent delegation"), String(parallel?.result ?? "").slice(0, 240));
  const audit6 = await page.ev(`globalThis.__katSend("named-agent.delegations", {})`);
  const sibs = (audit6?.entries ?? []).filter((e) => e.parentRunId === parallel?.executionId);
  const sibTargets = new Set(sibs.map((e) => e.toAgentId));
  check("audit: BOTH parallel siblings recorded with distinct child runs", sibs.length === 2 && new Set(sibs.map((e) => e.childRunId)).size === 2, sibs.map((e) => ({ to: e.toAgentId, childRunId: e.childRunId })));
  check("audit: the siblings fanned out to both targets", sibTargets.has("helper-bee") && sibTargets.has("critic"), [...sibTargets]);
  check("audit: the siblings share ONE parent run id", sibs.length === 2 && sibs[0].parentRunId === sibs[1].parentRunId, sibs.map((e) => e.parentRunId));
} finally {
  try { proc.kill(); } catch { /* already gone */ }
}
console.log(`\nKAT agent-delegation: ${pass} passed, ${fail} failed`);
Deno.exit(fail ? 1 : 0);
