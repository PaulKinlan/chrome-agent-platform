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

  // 5. The Tasks sidebar's Board grouping renders the jobs + the message.
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

  // 6. Screenshot evidence of the grouping.
  const shot = await cdp("Page.captureScreenshot", { format: "png" }, page);
  await Deno.writeFile(`${OUT}/board-sidebar.png`, Uint8Array.from(atob(shot.result.data), (c) => c.charCodeAt(0)));
  console.log(`screenshot: ${OUT}/board-sidebar.png`);
} finally {
  try { proc.kill(); } catch { /* already gone */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
Deno.exit(fail === 0 ? 0 : 1);
