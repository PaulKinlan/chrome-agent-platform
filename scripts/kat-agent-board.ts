// kat-agent-board.ts — shared jobs board KAT (real browser, loaded extension).
//
// Drives the REAL seams end to end:
//   1. The board.* routes through the extension's own message chokepoint from
//      the REAL new-tab page (post job → board shows it; claim by the hub
//      refuses self-claim; message posts; second job claims via the SW route
//      context as hub on a job posted... by the hub — so claim is exercised
//      through the store path covered by unit tests, and the route's guard
//      denial is exercised live).
//   2. The Tasks-sidebar "Board" grouping renders open jobs + the messages
//      feed (screenshot evidence).
//
//   deno run -A scripts/kat-agent-board.ts <path-to-extension> [<out-dir>]

import { launchChrome } from "./lib/chrome-launch.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? `${ROOT}.cache/kat-agent-board`;
const CHROMIUM = "/usr/bin/chromium";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)?.slice(0, 260)}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.mkdir(OUT, { recursive: true });

const { proc, wsUrl } = await launchChrome({
  binary: CHROMIUM,
  args: ["--headless=new", "--no-sandbox", "--disable-gpu", "--silent-debugger-extension-api",
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${OUT}/profile-${Date.now()}`, "about:blank"],
});

const ws = new WebSocket(wsUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const pending = new Map<string, (v: any) => void>();
const cdp = (method: string, params: any = {}, sessionId?: string) => new Promise<any>((res) => {
  const mid = ++id; pending.set(String(mid), res);
  ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
});
ws.onmessage = (m: MessageEvent) => {
  const j = JSON.parse((m as any).data);
  if (j.id && pending.has(String(j.id))) { pending.get(String(j.id))!(j); pending.delete(String(j.id)); }
};
const evaluate = async (expr: string, sessionId: string) => {
  const j = await cdp("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
  if (j.result?.exceptionDetails) return { __error: j.result.exceptionDetails.exception?.description ?? "evaluate failed" };
  return j.result?.result?.value ?? null;
};

try {
  // The SW registers asynchronously after extension load — wait for it.
  let sw = null;
  for (let i = 0; i < 40 && !sw; i += 1) {
    const { result: { targetInfos } } = await cdp("Target.getTargets");
    sw = targetInfos.find((t: any) => t.type === "service_worker") ?? null;
    if (!sw) await sleep(250);
  }
  if (!sw) throw new Error("no service worker target");
  const extId = new URL(sw.url).host;

  // Open the REAL new-tab page.
  const { result: { targetId: pageTarget } } = await cdp("Target.createTarget", { url: `chrome-extension://${extId}/ntp/ntp.html` });
  const { result: { sessionId: page } } = await cdp("Target.attachToTarget", { targetId: pageTarget, flatten: true });
  // A laptop-sized viewport (the headless default is 800x600, which squeezes
  // the sidebar to ~200px and hides most of the Board box behind its scroll).
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, page);
  await sleep(1500);

  // The page's own message chokepoint drives the REAL SW routes.
  const sendExpr = (type: string, payload: object) =>
    `new Promise((r) => chrome.runtime.sendMessage({ type: ${JSON.stringify(type)}, ...${JSON.stringify(payload)} }, (res) => r(res ?? null)))`;

  // 1. Post a job (the page context resolves to the hub).
  const posted = await evaluate(sendExpr("board.post", {
    description: "Critique the station blog draft — tighten the intro",
    requiredCapability: "critique",
  }), page);
  check("board.post accepts a hub-posted job", posted?.ok === true && typeof posted?.job?.id === "string", posted);
  check("the poster identity is recorded as the hub", posted?.job?.posterId === "hub", posted?.job?.posterId);

  // 2. The hub can never claim its own job (the guard runs live).
  const selfClaim = await evaluate(sendExpr("board.claim", { jobId: posted?.job?.id }), page);
  check("board.claim refuses a self-claim", selfClaim?.ok === false && selfClaim?.code === "board-self-claim", selfClaim);

  // 3. Post a second job + a broadcast message.
  const posted2 = await evaluate(sendExpr("board.post", { description: "Find three comparable tools and summarise pricing" }), page);
  check("a second job posts", posted2?.ok === true, posted2);
  const msg = await evaluate(sendExpr("board.message", { to: "broadcast", body: "Two jobs are up — writers and researchers welcome" }), page);
  check("a broadcast message posts", msg?.ok === true && msg?.message?.toId === "broadcast", msg);

  // 4. board.list returns both open jobs through the live route.
  const listed = await evaluate(sendExpr("board.list", { status: "pending" }), page);
  check("board.list returns the two open jobs", listed?.ok === true && listed?.jobs?.length === 2, listed?.jobs?.length);

  // 4b. (P1-1) The board logs are RESERVED: the page/model memory surface
  //     can never replace, read, or enumerate them — while the board routes
  //     keep working over the trusted paths.
  const forgeSet = await evaluate(sendExpr("memory.set", { origin: "master", key: "cap:board-jobs", value: [] }), page);
  check("memory.set can never replace the board jobs log", forgeSet == null || forgeSet?.ok === false || typeof forgeSet?.error === "string", forgeSet);
  const forgeGet = await evaluate(sendExpr("memory.get", { origin: "master", key: "cap:board-jobs" }), page);
  check("memory.get can never read the board jobs log", forgeGet == null || forgeGet?.ok === false || typeof forgeGet?.error === "string", forgeGet);
  const listKeys = await evaluate(sendExpr("memory.list", { origin: "master" }), page);
  const keys = Array.isArray(listKeys) ? listKeys : (listKeys?.keys ?? listKeys?.value ?? []);
  check("memory.list never enumerates the board keys", Array.isArray(keys) && !keys.some((k) => String(k).startsWith("cap:board-")), keys?.slice?.(0, 8));
  const stillThere = await evaluate(sendExpr("board.list", {}), page);
  check("the board still reads its log after the forge attempts", stillThere?.ok === true && stillThere?.jobs?.length === 2, stillThere?.jobs?.length);

  // 4b. (P1-1) The board logs are RESERVED: the page/model memory surface
  //    renderTasks fires refreshBoard on load; give the async section a beat,
  //    then nudge a re-render via the progress bus isn't needed — read the DOM.
  await evaluate("window.dispatchEvent(new Event('focus'))", page);
  await sleep(1200);
  const boardDom = await evaluate(`(() => {
    const section = document.getElementById("board-section");
    if (!section) return { missing: true };
    return {
      hidden: section.hidden,
      text: section.textContent,
      rows: section.querySelectorAll(".fr-row").length,
      label: section.querySelector(".fr-label")?.textContent ?? null,
    };
  })()`, page);
  check("the Board section is visible in the Tasks sidebar", boardDom?.hidden === false, boardDom);
  check("the Board label carries the open count", boardDom?.label === "Board (2 open)", boardDom?.label);
  check("both job descriptions render", typeof boardDom?.text === "string" && boardDom.text.includes("Critique the station blog draft") && boardDom.text.includes("Find three comparable tools"), boardDom?.text?.slice(0, 200));
  check("the message feed renders the broadcast", typeof boardDom?.text === "string" && boardDom.text.includes("Two jobs are up"), boardDom?.text?.slice(-160));

  // 5b. Geometry: the section fits INSIDE the (clipping) Tasks section, the
  //     first row is fully visible, and every row is reachable in the box's
  //     own scroll area (a long board scrolls internally — it never pushes the
  //     thread list out).
  const geo = await evaluate(`(() => {
    const section = document.getElementById("board-section");
    const rows = [...section.querySelectorAll(".fr-row")];
    const box = section.getBoundingClientRect();
    const parentBox = section.parentElement.getBoundingClientRect();
    const first = rows[0]?.getBoundingClientRect();
    return { sectionH: box.height, scrollH: section.scrollHeight, rows: rows.length,
      insideParent: box.bottom <= parentBox.bottom + 1,
      firstRowVisible: first ? first.top >= box.top - 1 && first.bottom <= box.bottom + 1 : false,
      overflowY: getComputedStyle(section).overflowY };
  })()`, page);
  check("the Board section fits inside the sidebar (no clipping)", geo?.insideParent === true, geo);
  check("the first Board row is fully visible (rest scroll inside the box)", geo?.firstRowVisible === true && geo?.rows >= 3 && geo?.overflowY === "auto", geo);

  // 5c. (P2-2) A REAL named agent claims + completes a job through the lazy
  //     tool protocol (@demo-board: board_list → board_claim_job →
  //     board_complete_job), its identity resolved from the LIVE run registry.
  //     Runs AFTER the render assertions: settlement removes the job from the
  //     open list (that removal IS the live-refresh assertion below).
  const created = await evaluate(sendExpr("named-agent.create", { name: "Board Worker", role: "You claim and complete board jobs." }), page);
  check("the claimant agent is created", created?.ok === true, created);
  const agentId = created?.agent?.id ?? "board-worker";
  // the marker demo model sits behind the developer flag (CAP-FB-20260830-KEYLESS-FIRST-RESULT-01)
  await evaluate(sendExpr("kv.set", { values: { "cap:developerFeatures": true } }), page);
  const run = await evaluate(sendExpr("named-agent.run", { id: agentId, task: "@demo-board" }), page);
  check("the @demo-board run settles ok", run?.ok === true || run?.status === "done" || run?.done === true, run && Object.keys(run).slice(0, 8));
  const settledJob = await evaluate(sendExpr("board.read", { jobId: posted2?.job?.id }), page);
  check("the agent claimed the job (identity from the run registry)", settledJob?.job?.claimantId === agentId, settledJob?.job?.claimantId);
  check("the agent completed the job with a result", settledJob?.job?.status === "completed" && typeof settledJob?.job?.result === "string" && settledJob.job.result.length > 0, settledJob?.job?.status);
  // Live UI refresh: the open NTP page re-renders from the board-* progress
  // events WITHOUT a reload — the completed job leaves the open list.
  let labelAfter = null;
  for (let i = 0; i < 20; i++) {
    labelAfter = await evaluate(`document.querySelector("#board-section .fr-label")?.textContent ?? null`, page);
    if (labelAfter === "Board (1 open)") break;
    await sleep(300);
  }
  check("the Board grouping live-refreshes (2 open → 1 open, no reload)", labelAfter === "Board (1 open)", labelAfter);
  // P2-1: poster/claimant metadata is VISIBLE text, not title-only.
  const metaVisible = await evaluate(`[...document.querySelectorAll("#board-section .fr-meta")].map((m) => m.textContent)`, page);
  check("board rows carry visible metadata spans", Array.isArray(metaVisible) && metaVisible.length >= 1 && metaVisible.every((t) => typeof t === "string" && t.length > 0), metaVisible);

  // ── CAP-FB-20260830-AGENT-BOARD-WORKING-01 — the board works end to end ──
  const waitFor = async (fn: () => Promise<boolean>, ms = 10000, step = 300) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (await fn()) return true; await sleep(step); }
    return await fn();
  };

  // 7. Blocked state (step 7): a job blocked by an open job renders "blocked
  //    by 1" and the demo model claims the OPEN one, never the blocked one.
  const blockedPost = await evaluate(sendExpr("board.post", {
    description: "Publish the critique once the station blog draft is critiqued",
    blockedBy: [posted?.job?.id],
  }), page);
  check("a blocked job posts (blockedBy the open critique job)", blockedPost?.ok === true && blockedPost?.job?.blockedBy?.length === 1, blockedPost);
  const blockedListed = await evaluate(sendExpr("board.list", {}), page);
  const blockedRow = blockedListed?.jobs?.find((j: any) => j.id === blockedPost?.job?.id);
  check("board_list marks the blocked job blocked:true (blockedByOpen 1)", blockedRow?.blocked === true && blockedRow?.blockedByOpen === 1, blockedRow);
  const blockedMetaSeen = await waitFor(async () =>
    (await evaluate(`[...document.querySelectorAll("#board-section .fr-meta")].map((m) => m.textContent)`, page))?.includes("blocked by 1"));
  check("a blocked job renders 'blocked by 1' in the sidebar", blockedMetaSeen === true,
    await evaluate(`[...document.querySelectorAll("#board-section .fr-meta")].map((m) => m.textContent)`, page));
  const run2 = await evaluate(sendExpr("named-agent.run", { id: agentId, task: "@demo-board" }), page);
  check("the second @demo-board run settles ok", run2?.ok === true || run2?.status === "done" || run2?.done === true, run2 && Object.keys(run2).slice(0, 8));
  const afterRun2 = await evaluate(sendExpr("board.list", {}), page);
  const blockedAfter = afterRun2?.jobs?.find((j: any) => j.id === blockedPost?.job?.id);
  const critiqueAfter = afterRun2?.jobs?.find((j: any) => j.id === posted?.job?.id);
  check("the blocked job is NOT claimed by @demo-board; the open one is completed instead",
    blockedAfter?.status === "pending" && blockedAfter?.claimantId == null && critiqueAfter?.status === "completed" && critiqueAfter?.claimantId === agentId,
    { blocked: blockedAfter?.status, critique: critiqueAfter?.status });
  check("settling the blocker unblocks the dependent job (blocked:false)", blockedAfter?.blocked === false && blockedAfter?.blockedByOpen === 0, blockedAfter);

  // 8. Sidebar CSS (step 8): the description keeps its width — at least 24
  //    characters of the first row's description are visible (measured with
  //    the row's own computed font).
  const visibleChars = await evaluate(`(() => {
    const text = document.querySelector("#board-section .fr-row .fr-text");
    if (!text) return -1;
    const font = getComputedStyle(text).font;
    const ctx = document.createElement("canvas").getContext("2d");
    ctx.font = font;
    const full = text.textContent ?? "";
    let n = 0;
    while (n < full.length && ctx.measureText(full.slice(0, n + 1)).width <= text.clientWidth) n += 1;
    return n;
  })()`, page);
  check("the first sidebar row shows at least 24 characters of the description", typeof visibleChars === "number" && visibleChars >= 24, visibleChars);

  // 9. A MODEL-context post (step 1) records the poster's thread, WAKES the
  //    target (step 3), and the settled result lands in the poster's thread
  //    (delivery) — the plain "ask the Research agent to…" path on the demo
  //    provider, with no manual run of the target.
  //    The poster is the HUB itself — the exact live path: the owner types
  //    the ask into the hub composer (agent.run creates the thread), the hub
  //    model calls board_post_job, and the result comes back to that thread.
  const postRun = await evaluate(sendExpr("agent.run", {
    task: '@demo-board-post target="Board Worker" desc="Find three articles about WebMCP and report back"',
  }), page);
  const posterThreadId = postRun?.threadId ?? null;
  check("the hub @demo-board-post run settles ok with a thread", (postRun?.ok === true || postRun?.done === true) && typeof posterThreadId === "string", postRun && Object.keys(postRun).slice(0, 8));
  const afterPost = await evaluate(sendExpr("board.list", {}), page);
  const modelJob = afterPost?.jobs?.find((j: any) => typeof j.description === "string" && j.description.includes("three articles about WebMCP"));
  check("a model-context post records the poster thread", modelJob?.posterId === "hub" && modelJob?.posterThreadId === posterThreadId, { posterId: modelJob?.posterId, posterThreadId: modelJob?.posterThreadId, expected: posterThreadId });
  check("the model-context post targets Board Worker", modelJob?.targetAgentId === agentId, modelJob?.targetAgentId);
  const wakeRunId = `board:${modelJob?.id}:${agentId}`;
  const woke = await waitFor(async () => {
    const runs = await evaluate(sendExpr("run.list", {}), page);
    return Array.isArray(runs?.runs) && runs.runs.some((r: any) => JSON.stringify(r).includes(wakeRunId));
  }, 10000);
  check("posting wakes the target (a Board Worker run appears within 10 s, no manual named-agent.run)", woke === true, wakeRunId);
  const settledViaWake = await waitFor(async () => {
    const r = await evaluate(sendExpr("board.read", { jobId: modelJob?.id }), page);
    return r?.job?.status === "completed";
  }, 30000, 500);
  const wakeJob = await evaluate(sendExpr("board.read", { jobId: modelJob?.id }), page);
  check("the woken agent claims and completes THAT job", settledViaWake === true && wakeJob?.job?.claimantId === agentId, { status: wakeJob?.job?.status, claimant: wakeJob?.job?.claimantId });
  const delivered = await waitFor(async () => {
    const t = await evaluate(sendExpr("thread.get", { id: posterThreadId }), page);
    return typeof t === "object" && t !== null && JSON.stringify(t).includes("completed by Board Worker");
  }, 15000, 500);
  check("the settled result lands in the poster thread", delivered === true, posterThreadId);

  // 10. board_read_messages (step 4): a named agent reads the broadcast.
  const readRun = await evaluate(sendExpr("named-agent.run", { id: agentId, task: "@demo-board-read" }), page);
  const readText = JSON.stringify(readRun ?? {});
  check("board_read_messages returns the broadcast to a named agent", readText.includes("Board messages:") && readText.includes("Two jobs are up"), readText.slice(0, 200));

  // 11. Settled visibility (step 6): the sidebar shows finished jobs with a
  //     result and a real button, and the final board-sidebar.png carries a
  //     full description row, a "blocked by 1" row, a settled row and a
  //     message row. A fresh blocked job keeps a blocked row on screen.
  await evaluate(sendExpr("board.post", { description: "Archive the published critique", blockedBy: [blockedPost?.job?.id] }), page);
  const finalDom = await waitFor(async () => {
    const d = await evaluate(`(() => {
      const s = document.getElementById("board-section");
      return { metas: [...s.querySelectorAll(".fr-meta")].map((m) => m.textContent), settled: s.querySelectorAll("button.board-settled").length, text: s.textContent };
    })()`, page);
    return d?.metas?.includes("blocked by 1") && d?.settled >= 1;
  });
  const dom = await evaluate(`(() => {
    const s = document.getElementById("board-section");
    return { metas: [...s.querySelectorAll(".fr-meta")].map((m) => m.textContent), settled: s.querySelectorAll("button.board-settled").length, text: s.textContent, buttons: [...s.querySelectorAll("button.board-settled")].map((b) => b.textContent) };
  })()`, page);
  check("settled jobs render as buttons with the claimant's result", finalDom === true && dom?.settled >= 1 && dom.buttons.some((t: string) => t.includes("Board Worker finished")), dom);

  // 12. Settings → Board permissions (step 9): the Agent select lists an agent
  //     created AFTER the options page loaded (no reload), rule rows print
  //     names, and the copy is one sentence.
  const { result: { targetId: optTarget } } = await cdp("Target.createTarget", { url: `chrome-extension://${extId}/options/options.html#board-permissions` });
  const { result: { sessionId: opts } } = await cdp("Target.attachToTarget", { targetId: optTarget, flatten: true });
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, opts);
  await sleep(1500);
  const research = await evaluate(sendExpr("named-agent.create", { name: "Research", role: "You research and report back." }), page);
  const researchId = research?.agent?.id ?? "research";
  const optionAppeared = await waitFor(async () =>
    (await evaluate(`(document.querySelector("#board-deny-agent")?.providers ?? []).some((p) => p.id === ${JSON.stringify(researchId)})`, opts)) === true);
  check("Settings Board permissions lists the newly created agent in the Agent select without a reload", optionAppeared === true, researchId);
  await evaluate(`document.querySelector("#board-deny-agent").value = ${JSON.stringify(researchId)}; document.querySelector("#board-deny-action").value = "claim"; document.querySelector("#board-deny-peer").value = "hub"; document.getElementById("board-deny-add-btn").click(); true`, opts);
  const ruleRow = await waitFor(async () =>
    (await evaluate(`[...document.querySelectorAll("#board-deny-list .perm-row .perm-name")].map((n) => n.textContent)`, opts))?.includes("Research cannot claim jobs from Hub"));
  check("the rule row reads 'Research cannot claim jobs from Hub' (names, one sentence)", ruleRow === true,
    await evaluate(`[...document.querySelectorAll("#board-deny-list .perm-row .perm-name")].map((n) => n.textContent)`, opts));
  await evaluate(`document.getElementById("board-permissions")?.scrollIntoView(); true`, opts);
  const settingsShot = await cdp("Page.captureScreenshot", { format: "png" }, opts);
  await Deno.writeFile(`${OUT}/board-settings.png`, Uint8Array.from(atob(settingsShot.result.data), (c) => c.charCodeAt(0)));
  console.log(`screenshot: ${OUT}/board-settings.png`);

  // 13. Screenshot evidence of the grouping.
  await evaluate("window.dispatchEvent(new Event('focus'))", page);
  await sleep(500);
  const shot = await cdp("Page.captureScreenshot", { format: "png" }, page);
  await Deno.writeFile(`${OUT}/board-sidebar.png`, Uint8Array.from(atob(shot.result.data), (c) => c.charCodeAt(0)));
  console.log(`screenshot: ${OUT}/board-sidebar.png`);
} finally {
  try { proc.kill(); } catch { /* already gone */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
Deno.exit(fail === 0 ? 0 : 1);
