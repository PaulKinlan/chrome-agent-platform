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
import { launchChrome } from "./lib/chrome-launch.ts";
// The pure delegation guard's own constants — the over-cap checks pin the
// production floor and child cap, never a copied number.
import { CHILD_ITERATION_CAP, MIN_REMAINING_ITERATIONS } from "../extension/lib/agent-delegation.js";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? `${ROOT}.cache/kat-agent-delegation`;
const CHROMIUM = "/home/paulkinlan/.cache/puppeteer/chrome/linux-140.0.7339.82/chrome-linux64/chrome";
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

// Kernel-assigned CDP port; the endpoint comes from THIS Chrome process.
let proc: Deno.ChildProcess | null = null;
let ws: WebSocket | null = null;
try {
  const launched = await launchChrome({
    binary: CHROMIUM,
    args: ["--headless=new", "--no-sandbox", "--disable-gpu", "--silent-debugger-extension-api",
      `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--remote-allow-origins=*",
      `--user-data-dir=${ROOT}.cache/kat-agent-delegation-${STAMP}`, "about:blank"],
  });
  proc = launched.proc;
  ws = new WebSocket(launched.wsUrl);
  await new Promise((r) => ws!.onopen = r);
} catch (e) {
  console.log(`FAIL: could not start Chrome for Testing — ${String(e)}`);
  try { proc?.kill(); } catch { /* already gone */ }
  Deno.exit(1);
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
if (!swTarget) { console.log("FAIL: no service worker target"); proc?.kill(); Deno.exit(1); }
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
  const permissionChild = await page.ev(`globalThis.__katSend("named-agent.create", { name: "Permission Child", role: "You use a provider whose host permission is intentionally absent." })`);
  check("permission-denial child created", permissionChild?.ok === true, permissionChild);
  const delegator = await page.ev(`globalThis.__katSend("named-agent.create", { name: "Delegator Prime", role: "You coordinate: delegate specialist subtasks to the agents in your delegation list and synthesize their results.", canDelegateTo: ["helper-bee", "mid-agent", "critic", "permission-child"] })`);
  check("delegator created with delegation edges", delegator?.ok === true, delegator);
  const got = await page.ev(`globalThis.__katSend("named-agent.get", { id: "delegator-prime" })`);
  check("the edges persisted on the record", JSON.stringify(got?.agent?.canDelegateTo) === JSON.stringify(["helper-bee", "mid-agent", "critic", "permission-child"]), got?.agent?.canDelegateTo);
  const mid = await page.ev(`globalThis.__katSend("named-agent.create", { name: "Mid Agent", role: "You pass work down the chain.", canDelegateTo: ["leaf-agent"] })`);
  check("mid agent created (chain depth 1)", mid?.ok === true, mid);
  const leaf = await page.ev(`globalThis.__katSend("named-agent.create", { name: "Leaf Agent", role: "You are the end of the chain.", canDelegateTo: ["helper-bee"] })`);
  check("leaf agent created (chain depth 2)", leaf?.ok === true, leaf);
  const critic = await page.ev(`globalThis.__katSend("named-agent.create", { name: "Critic", role: "You review work critically." })`);
  check("critic created (parallel sibling target)", critic?.ok === true, critic);

  // ── 2. The allowed delegation runs end to end ────────────────────────────
  // the marker demo model sits behind the developer flag (CAP-FB-20260830-KEYLESS-FIRST-RESULT-01)
  await page.ev(`globalThis.__katSend("kv.set", { values: { "cap:developerFeatures": true } })`);
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

  // ── 4b. PROVIDER PERMISSION: delegated child terminal-fails honestly ─────
  // Provider mutation and approval routes are intentionally Settings-only.
  const settings = await newView(`chrome-extension://${extId}/options/options.html`);
  await sleep(1000);
  await settings.ev(ROUTE_HELPER);
  const providerSet = await settings.ev(`(async () => {
    const message = { type: "named-agent.set-provider", id: "permission-child", config: { provider: "openai", baseURL: "https://permission-denied.invalid/v1", model: "gpt-test", apiKey: "test-key" } };
    const first = await globalThis.__katSend(message.type, message);
    if (first?.ok === true) return { first, retry: first };
    const pending = await globalThis.__katSend("management.pending-approvals", {});
    const approval = (pending?.approvals ?? []).find((a) => a.action === "named-agent.set-provider");
    if (!approval) return { first, pending, error: "no provider approval" };
    const resolved = await globalThis.__katSend("management.resolve-approval", { approvalId: approval.approvalId, approve: true });
    const retry = await globalThis.__katSend(message.type, message);
    return { first, resolved, retry };
  })()`);
  check("permission child remote provider configured through owner approval", providerSet?.retry?.ok === true && providerSet?.resolved?.decision === "approved", providerSet);
  const providerHostMissing = await page.ev(`chrome.permissions.contains({ origins: ["https://permission-denied.invalid/*"] })`);
  // P0 web-unpacked reality: host permissions are install-granted (<all_urls>),
  // so contains() is always true now — the honest denial below surfaces from the
  // unreachable host (the network path), never from a missing permission.
  check("provider host access is install-granted under web-unpacked (P0 permanent <all_urls>)", providerHostMissing === true, providerHostMissing);
  const permissionRun = await page.ev(`globalThis.__katSend("named-agent.run", { id: "delegator-prime", task: "@demo-delegate-agent permission-child" })`);
  check("permission-denied delegation completes parent honestly", permissionRun?.ok === true, permissionRun);
  check("parent result reports provider permission denial", /permission|network access/i.test(String(permissionRun?.result ?? "")), permissionRun?.result);
  const permissionRuns = await page.ev(`globalThis.__katSend("run.list", {})`);
  const permissionChildRun = (permissionRuns?.runs ?? []).find((r) => r.agentId === "named:permission-child" && r.phase === "terminal" && r.terminal?.ok === false && String(r.clientCorrelationId ?? "").startsWith("delegate:permission-child:"));
  check("permission-denied child is terminal failed, never paused", permissionChildRun?.phase === "terminal" && permissionChildRun?.terminal?.ok === false, permissionChildRun ?? permissionRuns);

  // ── 5. UI linkage: target the VISIBLE delegation result card itself ─────
  // Open a fresh hub, wait for its real agent list to hydrate, then drive the
  // same capability-row `open` event as an owner click. Direct hash navigation
  // can beat registry hydration and render an empty fallback.
  const chat = await newView(`chrome-extension://${extId}/ntp/ntp.html`);
  let agentRowReady = false;
  for (let i = 0; i < 60 && !agentRowReady; i++) {
    await sleep(250);
    agentRowReady = await chat.ev(`(() => [...document.querySelectorAll("#named-agents capability-row")].some((row) => row.getAttribute("name") === "Delegator Prime"))()`);
  }
  check("delegation UI probe: Delegator Prime row is visible", agentRowReady === true, agentRowReady);
  const openedAgentChat = await chat.ev(`(() => {
    const row = [...document.querySelectorAll("#named-agents capability-row")].find((item) => item.getAttribute("name") === "Delegator Prime");
    if (!row) return false;
    row.dispatchEvent(new CustomEvent("open"));
    return true;
  })()`);
  check("delegation UI probe: owner open action dispatched", openedAgentChat === true, openedAgentChat);
  const scrollDelegationResultIntoView = `(() => {
    const roots = [document];
    for (let i = 0; i < roots.length; i++) {
      for (const el of roots[i].querySelectorAll("*")) if (el.shadowRoot) roots.push(el.shadowRoot);
    }
    const bubbles = roots.flatMap((root) => [...root.querySelectorAll("message-bubble")]);
    // Pick the SUCCESSFUL delegation's bubble, never merely the last one — a later
    // permission-denied delegation also renders a delegate_to_agent tool card.
    const toolBubble = bubbles.filter((el) => {
      if (el.getAttribute("tool-name") !== "delegate_to_agent") return false;
      const text = el.shadowRoot?.querySelector(".tool-result, .tool-plain, .tt-tree")?.textContent ?? "";
      return /Agent delegation succeeded|Helper Bee/i.test(text);
    }).at(-1);
    const agentBubble = bubbles.filter((el) => {
      if (el.getAttribute("role") !== "agent") return false;
      const text = el.shadowRoot?.querySelector(".msg.agent .body")?.textContent ?? el.getAttribute("content") ?? "";
      return /Agent delegation succeeded|Helper Bee/i.test(text);
    }).at(-1);
    const bubble = toolBubble ?? agentBubble;
    const result = toolBubble
      ? toolBubble.shadowRoot?.querySelector(".tool-result, .tool-plain, .tt-tree")
      : agentBubble?.shadowRoot?.querySelector(".msg.agent .body");
    if (!bubble || !result) return {
      found: false,
      title: document.getElementById("thread-title")?.textContent ?? "",
      messages: bubbles.map((el) => ({
        role: el.getAttribute("role"),
        tool: el.getAttribute("tool-name"),
        content: (el.getAttribute("content") ?? "").slice(0, 100),
      })).slice(-12),
    };
    bubble.scrollIntoView({ block: "center", inline: "nearest" });
    const rect = result.getBoundingClientRect();
    return {
      found: true,
      kind: toolBubble ? "tool-result" : "agent-result",
      resultText: result.textContent?.trim() ?? "",
      top: rect.top,
      bottom: rect.bottom,
      viewportHeight: innerHeight,
      visible: rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight,
    };
  })()`;
  let delegationResult = null;
  for (let i = 0; i < 60 && !delegationResult?.found; i++) {
    await sleep(250);
    delegationResult = await chat.ev(scrollDelegationResultIntoView);
  }
  await sleep(300);
  delegationResult = await chat.ev(scrollDelegationResultIntoView);
  check(
    "the agent-chat surface renders the visible delegation result card",
    delegationResult?.found === true && delegationResult?.visible === true && /Helper Bee|Agent delegation succeeded/i.test(delegationResult?.resultText ?? ""),
    delegationResult,
  );
  // The viewport is centred on the asserted result element — the screenshot is
  // evidence of the rendered delegation, not merely the initiating prompt.
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
    globalThis.__katAdmission = { armed: true, event: null, fenceEvent: null, cancel: null, seen: [] };
    const port = chrome.runtime.connect({ name: "agent-progress" });
    globalThis.__katAdmission.port = port;
    port.onMessage.addListener((message) => {
      const ev = message?.type === "progress" ? message.event : message;
      globalThis.__katAdmission.seen.push(ev?.type ?? message?.type ?? "unknown");
      if (globalThis.__katAdmission.seen.length > 40) globalThis.__katAdmission.seen.shift();
      if (ev?.type === "delegation-admission-cancelled") globalThis.__katAdmission.fenceEvent = ev;
      if (!globalThis.__katAdmission.armed || ev?.type !== "delegation-admission") return;
      globalThis.__katAdmission.armed = false;
      globalThis.__katAdmission.event = ev;
      chrome.runtime.sendMessage({ type: "run.cancel", executionId: ev.executionId }, (res) => {
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
    admissionState = await page.ev(`(() => { const s = globalThis.__katAdmission; return s ? { event: s.event, fenceEvent: s.fenceEvent, cancel: s.cancel, seen: s.seen } : null; })()`);
    if (admissionState?.event && admissionState?.fenceEvent && admissionState?.cancel) break;
  }
  check("admission probe: child id allocated before durable admission", typeof admissionState?.event?.executionId === "string" && admissionState.event.executionId.length > 0, admissionState);
  check("admission probe: child cancellation accepted at the allocation fence", admissionState?.cancel?.ok === true, admissionState?.cancel);
  check("admission probe: cancellation traversed the pending-admission fence", admissionState?.fenceEvent?.pendingAdmission === true && admissionState?.fenceEvent?.admissionPhase === "pending" && admissionState.fenceEvent.executionId === admissionState.event.executionId, admissionState?.fenceEvent);
  let admissionResult = null;
  for (let i = 0; i < 80 && !admissionResult; i++) {
    await sleep(250);
    const bg = await page.ev(`globalThis.__katBg["admissionCancel"]`);
    if (bg?.done) admissionResult = bg.res;
  }
  check("admission probe: parent completes honestly after fenced-child cancellation", admissionResult?.ok === true || /cancel/i.test(String(admissionResult?.error ?? "")), admissionResult);
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

  // ── 8b. OVER-CAP: the budget refusal lands at ADMISSION ─────────────────
  // x4 asks for four sequential delegations, each child running the doubled
  // tools plan so it consumes its whole child cap. Once the charged child
  // spend leaves fewer than MIN_REMAINING_ITERATIONS of the root's cap,
  // evaluateDelegation DENIES the next delegation (delegation-budget), the
  // denial is audited with the parent's remaining, and the parent finishes
  // honestly with the structured denial as its answer. The subtree never
  // spends past the cap, so the terminal fence (assertDelegationSpendWithinCap)
  // has nothing left to reject. Before the run budget was raised (48×24 model
  // steps, reusable selection refs) the parent restarted its plan every outer
  // iteration and its own steps overshot the cap AFTER the children were
  // charged, so the terminal fence failed the whole run instead — an
  // accounting artefact, not the contract (CAP-FB-20260902-KAT-AGENT-DELEGATION-RED-01).
  const overCap = await page.ev(`globalThis.__katSend("named-agent.run", { id: "delegator-prime", task: "@demo-delegate-agent helper-bee @demo-delegate-x4" })`);
  check("over-cap: the parent finishes honestly with the structured budget denial, never a fake success", overCap?.ok === true && /not enough of this run's iteration budget remains/i.test(String(overCap?.result ?? "")), overCap);
  check("over-cap: parent + subtree never spend past the root cap", Number.isFinite(overCap?.delegationSpend?.total) && overCap.delegationSpend.total <= overCap.delegationSpend.cap, overCap?.delegationSpend);
  const audit5b = await page.ev(`globalThis.__katSend("named-agent.delegations", {})`);
  const overCapAttempts = (audit5b?.entries ?? []).filter((e: any) => e.parentRunId === overCap?.executionId);
  const overCapAttemptSummary = overCapAttempts.map((e: any) => ({ to: e.toAgentId, outcome: e.outcome, detail: e.detail, cap: e.childCap, rem: e.parentRemaining })).reverse();
  console.log("OVER-CAP-ATTEMPTS", JSON.stringify(overCapAttemptSummary));
  const overCapDenied = overCapAttempts.find((e: any) => e.outcome === "denied" && e.detail === "delegation-budget");
  check("over-cap: the refused delegation is audited as a budget denial with the parent's remaining below the floor", overCapDenied?.toAgentId === "helper-bee" && Number.isFinite(overCapDenied?.parentRemaining) && overCapDenied.parentRemaining < MIN_REMAINING_ITERATIONS, overCapAttemptSummary);
  const overCapExecuted = overCapAttempts.filter((e: any) => e.outcome !== "denied");
  check("over-cap: every executed child was capped inside the parent's remaining (never above CHILD_ITERATION_CAP)", overCapExecuted.length >= 1 && overCapExecuted.every((e: any) => Number.isFinite(e.childCap) && e.childCap <= e.parentRemaining && e.childCap <= CHILD_ITERATION_CAP), overCapAttemptSummary);
  const overCapRuns = await page.ev(`globalThis.__katSend("run.list", {})`);
  const overCapRecord = (overCapRuns?.runs ?? []).find((r: any) => r.executionId === overCap?.executionId);
  check("over-cap: the durable terminal record settled with the denial, never left running", overCapRecord?.phase === "terminal" && /iteration budget/i.test(String(overCapRecord?.terminal?.summary ?? "")), overCapRecord ? { phase: overCapRecord.phase, terminal: overCapRecord.terminal } : { runs: (overCapRuns?.runs ?? []).length });

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

  // ── 10. QUEUED-SIBLING CANCELLATION: second sibling never registers ─────
  await page.ev(`(() => {
    globalThis.__katQueued = { admissions: [] };
    const port = chrome.runtime.connect({ name: "agent-progress" });
    globalThis.__katQueued.port = port;
    port.onMessage.addListener((message) => {
      const ev = message?.type === "progress" ? message.event : message;
      if (ev?.type === "delegation-admission") globalThis.__katQueued.admissions.push(ev);
    });
    return true;
  })()`);
  await page.ev(`globalThis.__katSendBg("queuedCancel", "named-agent.run", { id: "delegator-prime", task: "@demo-delegate-agent helper-bee @demo-delegate-parallel-slow helper-bee critic" })`);
  let queuedParent = "", queuedChild = "";
  for (let i = 0; i < 80 && (!queuedParent || !queuedChild); i++) {
    await sleep(250);
    const admissions = await page.ev(`globalThis.__katQueued?.admissions ?? []`);
    const first = admissions?.[0];
    if (first?.parentRunId) { queuedParent = first.parentRunId; queuedChild = first.executionId; }
    if (queuedParent && queuedChild) {
      const lst = await page.ev(`globalThis.__katSend("run.list", {})`);
      const child = (lst?.runs ?? []).find((r) => r.executionId === queuedChild);
      if (child?.phase === "running") break;
    }
  }
  check("queued-sibling probe: first child holds the lock live", queuedParent.length > 0 && queuedChild.length > 0, { queuedParent, queuedChild });
  const queuedCancel = await page.ev(`globalThis.__katSend("run.cancel", { executionId: "${queuedParent}" })`);
  check("queued-sibling probe: parent cancellation accepted", queuedCancel?.ok === true, queuedCancel);
  let queuedResult = null;
  for (let i = 0; i < 100 && !queuedResult; i++) {
    await sleep(250);
    const bg = await page.ev(`globalThis.__katBg["queuedCancel"]`);
    if (bg?.done) queuedResult = bg.res;
  }
  check("queued-sibling probe: parent settles cancelled", queuedResult?.cancelled === true || /cancel/i.test(String(queuedResult?.error ?? "")), queuedResult);
  await sleep(500);
  const queuedAdmissions = await page.ev(`globalThis.__katQueued?.admissions ?? []`);
  const thisParentAdmissions = (queuedAdmissions ?? []).filter((ev) => ev.parentRunId === queuedParent);
  check("queued sibling never allocates/registers after the cancellation snapshot", thisParentAdmissions.length === 1 && thisParentAdmissions[0].executionId === queuedChild, thisParentAdmissions);
  const queuedAudit = await page.ev(`globalThis.__katSend("named-agent.delegations", {})`);
  const queuedDenial = (queuedAudit?.entries ?? []).find((e) => e.parentRunId === queuedParent && e.outcome === "denied" && e.detail === "delegation-context");
  check("queued sibling is denied by durable parent revalidation", queuedDenial?.outcome === "denied", queuedDenial);
  await page.ev(`globalThis.__katQueued?.port?.disconnect()`);
} finally {
  try { proc?.kill(); } catch { /* already gone */ }
}
console.log(`\nKAT agent-delegation: ${pass} passed, ${fail} failed`);
Deno.exit(fail ? 1 : 0);
