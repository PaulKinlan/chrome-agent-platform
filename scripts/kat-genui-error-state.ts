// kat-genui-error-state.ts — the owner-reported GenUI stuck-preview bug,
// proven in a REAL browser against the LOADED extension:
//   (a) an update_asset call whose result is the approval-required denial must
//       render the error card — NOT the sandbox preview frame that used to sit
//       on "Preparing restricted preview…" forever;
//   (b) a plain error result likewise renders the error card;
//   (c) the happy path is untouched: a success result still mounts the frame
//       AND the staged payload is actually delivered (the host swaps the
//       preparing status for the content iframe — verified via CDP inside the
//       frame's execution context);
//   (d) the bounded wait: the host page with no payload stops saying
//       "Preparing…" after 15s, shows the honest failure + retry, and the
//       retry reloads back to the preparing state.
//
//   deno run -A scripts/kat-genui-error-state.ts <path-to-extension> [<out-dir>]
const ROOT = new URL("..", import.meta.url).pathname;
const EXT = Deno.args[0] ?? `${ROOT}extension`;
const OUT = Deno.args[1] ?? `${ROOT}.cache/kat-genui-error-state`;
const CHROMIUM = "/home/paulkinlan/.cache/puppeteer/chrome/linux-140.0.7339.82/chrome-linux64/chrome";
// Pick a free debug port — killed KAT runs leave zombie chromiums holding a
// fixed port, which then hangs every subsequent run's CDP handshake.
async function freePort(from: number): Promise<number> {
  for (let p = from; p < from + 200; p++) {
    const l = Deno.listen({ port: p });
    try { l.close(); return p; } catch { /* taken */ }
  }
  throw new Error("no free debug port in range");
}
const PORT = await freePort(9357);
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
    `--user-data-dir=${ROOT}.cache/kat-genui-error-state-${STAMP}`, "about:blank"],
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
const contexts: any[] = [];
ws!.onmessage = (m: MessageEvent) => {
  const j = JSON.parse(m.data);
  if (j.id && pending.has(String(j.id))) { pending.get(String(j.id))!(j); pending.delete(String(j.id)); }
  else if (j.method === "Runtime.executionContextCreated") contexts.push(j.params.context);
};
const send = (method: string, params: any = {}, sessionId?: string) => new Promise<any>((res) => {
  const mid = ++id; pending.set(String(mid), res);
  ws!.send(JSON.stringify({ id: mid, method, params, sessionId }));
});

// The extension id: prefer the live SW target; fall back to the profile's
// Preferences (the unpacked id is deterministic per path).
let sw: any = null;
for (let i = 0; i < 20 && !sw; i++) {
  const { result: { targetInfos } } = await send("Target.getTargets");
  sw = targetInfos.find((t: any) => t.type === "service_worker" && String(t.url).includes("dist/background"));
  if (!sw) await sleep(500);
}
let extId: string;
if (sw) extId = new URL(sw.url).host;
else {
  const prof = `${ROOT}.cache/kat-genui-error-state-${STAMP}/Default/Preferences`;
  // Under fleet load Chrome can take >10s to materialize the profile — poll.
  let prefsRaw: string | null = null;
  for (let i = 0; i < 30 && prefsRaw === null; i++) {
    prefsRaw = await Deno.readTextFile(prof).catch(() => null);
    if (prefsRaw === null) await sleep(1000);
  }
  if (prefsRaw === null) { console.log("FAIL: Chrome profile never materialized"); proc.kill(); Deno.exit(1); }
  const prefs = JSON.parse(prefsRaw);
  const entry = Object.entries<any>(prefs.extensions?.settings ?? {}).find(([, v]) => String(v?.path ?? "").endsWith("extension") && v?.location === 8);
  if (!entry) { console.log("FAIL: extension never registered"); proc.kill(); Deno.exit(1); }
  extId = entry[0];
}

async function newView(url: string) {
  const { result: { targetId } } = await send("Target.createTarget", { url: "about:blank" });
  const { result: { sessionId } } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Runtime.enable", {}, sessionId);
  await send("Page.enable", {}, sessionId);
  await send("Page.navigate", { url }, sessionId);
  const ev = async (expr: string) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
    return r.result?.result?.value;
  };
  return { targetId, sessionId, ev };
}

const HTML_DOC = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Retirement Planner</title></head>
<body><h1>Retirement Planner</h1></body></html>`;
const OWNER_ARGS = JSON.stringify({ content: HTML_DOC, origin: "master", id: "a_mtdjpsrc_7fgtnaiu", type: "html", name: "Retirement Savings & Investment Planner" });
// The owner's captured failing envelope, verbatim shape.
const OWNER_RESULT = JSON.stringify({
  modelContent: JSON.stringify({
    ok: true, selectedTool: "update_asset",
    result: { error: "This operation requires owner approval in Settings.", ok: false },
    selectionRef: "sel_48a5b187ad9ab795eecbb289c7f0c5aae400",
  }),
  authorizes: false, requiresLiveAuthorization: true,
});
const PLAIN_ERROR_RESULT = JSON.stringify({ ok: false, error: "asset store is read-only in this context" });
const SUCCESS_RESULT = JSON.stringify({ ok: true, asset: { name: "Retirement Planner", content: HTML_DOC } });
// A lazy-tool SUCCESS envelope: authorizes:false + requiresLiveAuthorization:true
// is NORMAL success metadata (lazy-tool-protocol stamps it on ok:true projections)
// — the preview must still render. The EXACT owner-reported shape (pinned by
// tests/artifacts-in-thread.test.ts from the live protocol): DOUBLE-WRAPPED —
// outer {modelContent: inner}, inner the stringified execute_tool payload naming
// selectedTool create_asset; the HTML itself lives in the create_asset ARGUMENTS.
const LAZY_SUCCESS_ARGS = JSON.stringify({ content: HTML_DOC, origin: "master", type: "html", name: "OpenClaw Report" });
const LAZY_SUCCESS_RESULT = JSON.stringify({
  modelContent: JSON.stringify({
    ok: true, selectedTool: "create_asset",
    result: { ok: true, id: "a_real_1", asset: { id: "a_real_1", name: "OpenClaw Report", type: "html", origin: "master", size: 12000 } },
    selectionRef: "sel_ba138fffcac9813515d075901fb166802eb9",
    authorizes: false, requiresLiveAuthorization: true,
  }),
});

// ── 1–3: message bubbles in the REAL NTP ────────────────────────────────────
const ntp = await newView(`chrome-extension://${extId}/ntp/ntp.html`);
await sleep(2000);

const bubbleReport = await ntp.ev(`(async () => {
  const mk = (attrs) => {
    const el = document.createElement("message-bubble");
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    document.body.appendChild(el);
    return el;
  };
  const read = (el) => {
    const root = el.shadowRoot;
    return {
      hasFrame: !!root.querySelector(".html-frame"),
      iframeSrc: root.querySelector(".html-frame iframe")?.getAttribute("src") ?? null,
      text: (((root.querySelector("details.tool"))?.textContent ?? root.textContent) || "").replace(/\\s+/g, " ").trim(),
      cardOpen: !!root.querySelector("details.tool[open]"),
      statusChip: root.querySelector(".tool-status")?.textContent ?? null,
      lead: root.querySelector(".tool-lead")?.textContent ?? null,
    };
  };
  const approval = mk({ role: "tool", "tool-name": "update_asset", "tool-status": "error",
    "tool-args": ${JSON.stringify(OWNER_ARGS)}, "tool-result": ${JSON.stringify(OWNER_RESULT)} });
  const plain = mk({ role: "tool", "tool-name": "update_asset", "tool-status": "error",
    "tool-args": ${JSON.stringify(OWNER_ARGS)}, "tool-result": ${JSON.stringify(PLAIN_ERROR_RESULT)} });
  const happy = mk({ role: "tool", "tool-name": "create_asset", "tool-status": "done",
    "tool-args": "{}", "tool-result": ${JSON.stringify(SUCCESS_RESULT)} });
  const lazySuccess = mk({ role: "tool", "tool-name": "create_asset", "tool-status": "done",
    "tool-args": ${JSON.stringify(LAZY_SUCCESS_ARGS)}, "tool-result": ${JSON.stringify(LAZY_SUCCESS_RESULT)} });
  // The LIVE-path shape: conversation.js stores summarizeToolResult(...) in
  // tool-result ("done" for the owner envelope) and the raw envelope in
  // tool-detail — the error card must headline the DENIAL, never the bare
  // summary (the round-3 owner bug).
  const liveShape = mk({ role: "tool", "tool-name": "update_asset", "tool-status": "error",
    "tool-args": ${JSON.stringify(OWNER_ARGS)}, "tool-result": "done", "tool-detail": ${JSON.stringify(OWNER_RESULT)} });
  // The owner envelope under a DONE status (what a persisted/replayed row carries)
  // — the card must still become the open error card, with the denial copy.
  const ownerDone = mk({ role: "tool", "tool-name": "update_asset", "tool-status": "done",
    "tool-args": ${JSON.stringify(OWNER_ARGS)}, "tool-result": ${JSON.stringify(OWNER_RESULT)} });
  await new Promise((r) => setTimeout(r, 300));
  return { approval: read(approval), plain: read(plain), happy: read(happy), lazySuccess: read(lazySuccess), ownerDone: read(ownerDone), liveShape: read(liveShape) };
})()`);

check("approval-required error: NO preview frame is rendered", bubbleReport?.approval?.hasFrame === false, bubbleReport?.approval);
check("approval-required error: the error text is visible (approval + Settings)", /owner approval in Settings/.test(bubbleReport?.approval?.text ?? ""), bubbleReport?.approval?.text);
check("approval-required error: the card renders the error state open", bubbleReport?.approval?.cardOpen === true && bubbleReport?.approval?.statusChip === "error", { open: bubbleReport?.approval?.cardOpen, chip: bubbleReport?.approval?.statusChip });
check("plain error: NO preview frame is rendered", bubbleReport?.plain?.hasFrame === false, bubbleReport?.plain);
check("plain error: the error text is visible", /read-only/.test(bubbleReport?.plain?.text ?? ""), bubbleReport?.plain?.text);
check("happy path: the preview frame STILL renders", bubbleReport?.happy?.hasFrame === true && String(bubbleReport?.happy?.iframeSrc ?? "").endsWith("sandbox/artifact-preview.html"), bubbleReport?.happy);
check("lazy success envelope (auth metadata + ok:true): the preview frame STILL renders", bubbleReport?.lazySuccess?.hasFrame === true && String(bubbleReport?.lazySuccess?.iframeSrc ?? "").endsWith("sandbox/artifact-preview.html"), bubbleReport?.lazySuccess);
check("live-path error shape (result='done' + detail=envelope): NO preview frame is rendered", bubbleReport?.liveShape?.hasFrame === false, bubbleReport?.liveShape);
check("live-path error shape: the headline is the DENIAL, not the bare 'done' summary", /owner approval in Settings/.test(bubbleReport?.liveShape?.lead ?? ""), { lead: bubbleReport?.liveShape?.lead });
check("live-path error shape: the card renders the error state open", bubbleReport?.liveShape?.cardOpen === true && bubbleReport?.liveShape?.statusChip === "error", { open: bubbleReport?.liveShape?.cardOpen, chip: bubbleReport?.liveShape?.statusChip });
check("owner envelope under a DONE status: NO preview frame is rendered", bubbleReport?.ownerDone?.hasFrame === false, bubbleReport?.ownerDone);
check("owner envelope under a DONE status: the card renders the error state open", bubbleReport?.ownerDone?.cardOpen === true && bubbleReport?.ownerDone?.statusChip === "error", { open: bubbleReport?.ownerDone?.cardOpen, chip: bubbleReport?.ownerDone?.statusChip });
check("owner envelope under a DONE status: the denial copy is visible", /owner approval in Settings/.test(bubbleReport?.ownerDone?.text ?? ""), bubbleReport?.ownerDone?.text?.slice(0, 400));

// ── 4: the host's receive path mounts a delivered payload (top-level tab:
// window.parent === window, so an in-page postMessage exercises the REAL
// receiver: nonce validation → byte cap → mount). The bubble→host delivery
// wiring (renderHtmlFrame staging + load-event post) is unit-tested.
const hostA = await newView(`chrome-extension://${extId}/sandbox/artifact-preview.html`);
await sleep(800);
const deliveredState = await hostA.ev(`(() => {
  window.postMessage({ type: "cap:artifact-preview-open", nonce: "kat-delivery", html: "<h1>delivered</h1>" }, "*");
  return true; })()`);
await sleep(600);
const mounted = await hostA.ev(`({ content: !!document.getElementById("artifact-preview-content"), statusGone: !document.getElementById("preview-status") || document.getElementById("preview-status").offsetParent === null && !document.getElementById("artifact-preview-content") ? false : true })`);
check("the host mounts a delivered payload (real receive path)", mounted?.content === true, mounted);

// ── 5–6: the bounded wait on a payload-less host ────────────────────────────
const host = await newView(`chrome-extension://${extId}/sandbox/artifact-preview.html`);
await sleep(1000);
const early = await host.ev(`({ status: document.getElementById("preview-status")?.textContent ?? null, retry: !!document.getElementById("preview-retry") })`);
check("before the timeout the host still says it is preparing", /Preparing restricted preview/.test(early?.status ?? "") && early?.retry === false, early);
console.log("…waiting out the 15s bounded wait…");
await sleep(16000);
const late = await host.ev(`({ status: document.getElementById("preview-status")?.textContent ?? null, retry: !!document.getElementById("preview-retry") })`);
check("after the bounded wait the host shows the HONEST failure (no infinite skeleton)", /Preview unavailable — the content never arrived/.test(late?.status ?? ""), late);
check("after the bounded wait a retry affordance exists", late?.retry === true, late);
await host.ev(`document.getElementById("preview-retry")?.click(); true`);
await sleep(1500);
const retried = await host.ev(`({ status: document.getElementById("preview-status")?.textContent ?? null })`);
check("the retry reloads back to the preparing state (the embedder re-posts on load)", /Preparing restricted preview/.test(retried?.status ?? ""), retried);

console.log(`\n${pass} passed, ${fail} failed`);
await send("Target.closeTarget", { targetId: ntp.targetId });
await send("Target.closeTarget", { targetId: hostA.targetId });
await send("Target.closeTarget", { targetId: host.targetId });
proc.kill();
Deno.exit(fail > 0 ? 1 : 0);
