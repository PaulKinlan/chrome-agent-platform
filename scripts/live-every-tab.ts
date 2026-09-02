// scripts/live-every-tab.ts — CAP-FB-20260901-RUN-BUDGET-EVERY-ITEM-01, the
// live check: 30 real tabs, a real provider (Gemini), "read every tab and
// produce a sourced digest". Reports how many tabs were listed / read / cited,
// how many search_tools + execute_tool rows the run log holds, and how many
// `selection-replayed` rows appeared (the owner's log had two).
//
// Usage:  set -a; . ~/.env; set +a; deno run -A scripts/live-every-tab.ts
//         (GEMINI_API_KEY is read from the environment and NEVER printed.)
//   CAP_LIVE_MODEL   model id (default gemini-3.7-flash)
//   CAP_LIVE_TABS    tab count (default 30)
//   CAP_LIVE_OUT     evidence directory (default test-artifacts/live-every-tab)
//   CAP_LIVE_MAX_ITERATIONS  force the run's outer-iteration budget (the inner
//                    step limit follows: max(2, min(n, 24)) — 8 forces a 30-tab
//                    loop across several inner turns, the context-window check
//                    of CAP-FB-20260902-LOOP-CONTEXT-WINDOW-01). The composer's
//                    own agent.run message carries it (the route accepts an
//                    explicit bounded budget); the screenshot is then named
//                    every-tab-three-turns.png.
//
// Port discipline: Chrome is launched through launchChrome() (kernel-assigned
// port, endpoint read from this process's own stderr). The extension is the
// REAL built bundle; the tabs are served by a local fixture with one unique
// FACT per page so "cited" is a verifiable count, not an impression.
import { launchChrome, waitForServiceWorker } from "./lib/chrome-launch.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = `${ROOT}extension`;
const CHROMIUM = Deno.env.get("CAP_CHROMIUM") ?? "/usr/bin/chromium";
const MODEL_ID = Deno.env.get("CAP_LIVE_MODEL") ?? "gemini-3.7-flash";
const TAB_COUNT = Math.max(1, Math.min(64, Number(Deno.env.get("CAP_LIVE_TABS") ?? 30) || 30));
const OUT = Deno.env.get("CAP_LIVE_OUT") ?? `${ROOT}test-artifacts/live-every-tab`;
const MAX_ITERATIONS = (() => { const n = Number(Deno.env.get("CAP_LIVE_MAX_ITERATIONS") ?? ""); return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : null; })();
const KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
if (!KEY) {
  console.error("GEMINI_API_KEY is required (read from the environment, never printed).");
  Deno.exit(2);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- the fixture: N distinct pages, each with ONE unique fact ----
const TOPICS = [
  "tide tables", "sourdough starters", "bicycle gearing", "volcanic soils", "loom weaving", "radio telescopes",
  "beekeeping", "cast iron seasoning", "orbital mechanics", "typewriter ribbons", "glacier melt", "fermented tea",
  "letterpress", "coral reefs", "kite aerodynamics", "cheese caves", "canal locks", "moss gardens", "sundials",
  "peat bogs", "lighthouse lenses", "salt marshes", "clock escapements", "wind turbines", "bonsai", "ice cores",
  "map projections", "paper marbling", "bell founding", "seed vaults", "tidal mills", "rope making",
];
const fact = (n: number) => `FACT-${String(n).padStart(2, "0")}: the ${TOPICS[(n - 1) % TOPICS.length]} page reports a reading of ${(n * 37) % 1000} units`;
const fixture = Deno.serve({ port: 0, hostname: "127.0.0.1" }, (req) => {
  const u = new URL(req.url);
  const m = u.pathname.match(/^\/page\/(\d+)$/);
  if (!m) return new Response("not found", { status: 404 });
  const n = Number(m[1]);
  const topic = TOPICS[(n - 1) % TOPICS.length];
  const html = `<!doctype html><html><head><title>Page ${n} — ${topic}</title></head><body>
<h1>Notes on ${topic}</h1>
<p>This is page ${n} of the research set. It covers ${topic} in a short, plain paragraph so a reader can summarise it in one line.</p>
<p><strong>${fact(n)}.</strong></p>
<p>Nothing else on this page matters for the digest; the fact above is the sourced claim.</p>
</body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
});
const ORIGIN = `http://127.0.0.1:${fixture.addr.port}`;

// ---- CDP plumbing ----
const profile = await Deno.makeTempDir({ prefix: "cap-live-every-tab-" });
const CHROME_ARGS = [
  "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--silent-debugger-extension-api",
  `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
  `--user-data-dir=${profile}`, "--no-first-run", "--noerrdialogs", "--window-size=1400,1600", "about:blank",
];
let proc: Deno.ChildProcess | null = null;
let ws: WebSocket | null = null;
let id = 0;
const pending = new Map<number, (v: any) => void>();
// Every CDP call is bounded: a wedged page or worker surfaces as a timeout
// with the console evidence below, never as a harness that hangs forever.
const send = (method: string, params: any = {}, sessionId?: string, timeoutMs = 60000) =>
  new Promise<any>((res, rej) => {
    const i = ++id;
    const timer = setTimeout(() => { pending.delete(i); rej(new Error(`cdp timeout: ${method}`)); }, timeoutMs);
    pending.set(i, (v) => { clearTimeout(timer); res(v); });
    ws!.send(JSON.stringify({ id: i, method, params, sessionId }));
  });

// The service worker's console (bounded, key-redacted): the honest evidence
// when a run stalls or fails — what the provider lane actually said.
const swConsole: string[] = [];
let swSession: string | null = null;
const redact = (s: string) => s.replace(/AIza[A-Za-z0-9_-]+/g, "[REDACTED]").replace(/sk-[A-Za-z0-9_-]{8,}/g, "[REDACTED]");
async function boot() {
  const l = await launchChrome({ binary: CHROMIUM, args: CHROME_ARGS });
  proc = l.proc;
  ws = new WebSocket(l.wsUrl);
  await new Promise((r) => { ws!.onopen = r; });
  ws.onmessage = (e) => {
    const d = JSON.parse(e.data as string);
    if (d.id && pending.has(d.id)) { pending.get(d.id)!(d); pending.delete(d.id); return; }
    if (d.sessionId && d.sessionId === swSession) {
      if (d.method === "Runtime.consoleAPICalled") {
        const text = (d.params?.args ?? []).map((a: any) => a?.value ?? a?.description ?? "").join(" ");
        swConsole.push(`[${d.params?.type ?? "log"}] ${redact(String(text)).slice(0, 400)}`);
      } else if (d.method === "Runtime.exceptionThrown") {
        swConsole.push(`[exception] ${redact(String(d.params?.exceptionDetails?.exception?.description ?? d.params?.exceptionDetails?.text ?? "")).slice(0, 400)}`);
      }
      if (swConsole.length > 400) swConsole.splice(0, swConsole.length - 400);
    }
  };
  const sw = await waitForServiceWorker(send, { timeoutMs: 20000, match: (t: any) => t.type === "service_worker" && t.url.startsWith("chrome-extension://") });
  if (!sw) throw new Error("no service worker");
  try {
    const attached = await send("Target.attachToTarget", { targetId: sw.targetId, flatten: true });
    swSession = attached?.result?.sessionId ?? null;
    if (swSession) await send("Runtime.enable", {}, swSession);
  } catch { swSession = null; }
  return new URL(sw.url).host;
}
function dumpSwConsole(label: string, n = 40) {
  const tail = swConsole.slice(-n);
  console.log(`SW console (${label}, last ${tail.length} of ${swConsole.length}):`);
  for (const line of tail) console.log("  " + line);
}
async function kill() {
  try { proc?.kill("SIGKILL"); } catch { /* gone */ }
  try { await proc?.status; } catch { /* reaped */ }
  try { ws?.close(); } catch { /* closed */ }
}
async function attach(url: string, waitMs = 1500) {
  const t = (await send("Target.createTarget", { url })).result.targetId;
  const s = (await send("Target.attachToTarget", { targetId: t, flatten: true })).result.sessionId;
  await send("Runtime.enable", {}, s);
  await send("Page.enable", {}, s);
  await sleep(waitMs);
  const ev = async (expr: string) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, s);
    if (r?.result?.exceptionDetails) return { __error: r.result.exceptionDetails.exception?.description ?? "threw" };
    return r?.result?.result?.value;
  };
  const shot = async (name: string) => {
    const r = await send("Page.captureScreenshot", { format: "png" }, s);
    if (!r?.result?.data) return null;
    await Deno.writeFile(`${OUT}/${name}`, Uint8Array.from(atob(r.result.data), (c) => c.charCodeAt(0)));
    return name;
  };
  const click = async (selector: string) => {
    const b = await ev(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    if (!b || typeof b.x !== "number") return false;
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: b.x, y: b.y, button: "left", buttons: 1, clickCount: 1 }, s);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: b.x, y: b.y, button: "left", buttons: 0, clickCount: 1 }, s);
    return true;
  };
  return { t, s, ev, shot, click };
}
const msg = (o: object) =>
  `chrome.runtime.sendMessage(${JSON.stringify(o)}).then(v => v, e => ({ __sendError: String(e?.message ?? e) }))`;

let exitCode = 1;
try {
  await Deno.mkdir(OUT, { recursive: true });
  let extId = await boot();
  // TEST AFFORDANCE: seed the optional permissions headless cannot grant from a
  // gesture (the product itself never self-grants — the Allow card asks).
  await kill();
  const prefPath = `${profile}/Default/Preferences`;
  let prefs: any = {};
  try { prefs = JSON.parse(await Deno.readTextFile(prefPath)); } catch { prefs = {}; }
  prefs.extensions ??= {}; prefs.extensions.settings ??= {};
  const settings = prefs.extensions.settings[extId] ??= {};
  const grant = {
    api: ["tabs", "scripting", "activeTab", "storage", "alarms", "offscreen", "sidePanel"],
    explicit_host: ["<all_urls>"], manifest_permissions: [], scriptable_host: ["http://*/*", "https://*/*"],
  };
  settings.granted_permissions = grant; settings.active_permissions = grant;
  await Deno.mkdir(`${profile}/Default`, { recursive: true });
  await Deno.writeTextFile(prefPath, JSON.stringify(prefs));
  extId = await boot();

  const opts = await attach(`chrome-extension://${extId}/options/options.html`, 2000);
  const perms = await opts.ev(`Promise.all([chrome.permissions.contains({permissions:["scripting"]}), chrome.permissions.contains({permissions:["tabs"]})]).then(([s,t]) => JSON.stringify({ scripting: s, tabs: t }))`);
  console.log("permissions held (seeded):", perms);
  // The provider: the REAL Gemini lane with the key from the environment. The
  // route's reply is reduced to ok/provider/model so nothing secret is echoed.
  const set = await opts.ev(msg({ type: "provider.set", config: { provider: "gemini", apiKey: KEY, baseURL: "", model: MODEL_ID } }));
  console.log("provider.set ->", JSON.stringify({ ok: set?.ok ?? set, provider: set?.config?.provider ?? set?.provider ?? "gemini", model: MODEL_ID }));

  // Thirty real tabs.
  const tabTargets: string[] = [];
  for (let n = 1; n <= TAB_COUNT; n++) {
    tabTargets.push((await send("Target.createTarget", { url: `${ORIGIN}/page/${n}` })).result.targetId);
  }
  await sleep(2500);
  const openTabs = await opts.ev(`chrome.tabs.query({}).then((t) => t.length)`);
  console.log(`tabs open (chrome.tabs.query({})): ${openTabs}`);

  // Drive the hub from the NEW-TAB PAGE exactly as the owner does: type the
  // task and click Run.
  const ntp = await attach(`chrome-extension://${extId}/ntp/ntp.html`, 2500);
  await send("Target.activateTarget", { targetId: ntp.t });
  const TASK = `Read every open tab whose URL contains "/page/" and produce a sourced digest: one line per tab with the page number, its title and the FACT-NN sentence it states, citing the tab's URL. Do not stop until every one of those tabs has been read; list any tab you could not read and why.`;
  if (MAX_ITERATIONS != null) {
    // The composer's own agent.run message carries the explicit bounded step
    // budget the route accepts (`maxIterations`), so the run is driven exactly
    // as the owner drives it — only smaller inner turns.
    await ntp.ev(`(() => { const send = chrome.runtime.sendMessage.bind(chrome.runtime); chrome.runtime.sendMessage = (m, ...rest) => send(m && typeof m === "object" && m.type === "agent.run" ? { ...m, maxIterations: ${MAX_ITERATIONS} } : m, ...rest); return true; })()`);
    console.log(`forcing maxIterations=${MAX_ITERATIONS} (innerStepLimit ${Math.max(2, Math.min(MAX_ITERATIONS, 24))}) on the composer's agent.run`);
  }
  await ntp.click("#task-input");
  await send("Input.insertText", { text: TASK }, ntp.s);
  await sleep(300);
  const clicked = await ntp.click("#run-task");
  console.log(`run started via the composer: ${clicked}`);
  const t0 = Date.now();

  // Wait for the run to settle (the durable registry is the authority).
  let run: any = null;
  let lastStatus = "";
  const RUN_STATUS = `(() => { const row = document.querySelector('#thread-conversation conversation-run-status.live-status'); const sr = row?.shadowRoot; return row ? JSON.stringify({ state: row.getAttribute('state'), label: (sr?.querySelector('.label')?.textContent ?? '').trim(), action: row.getAttribute('action-label') }) : null; })()`;
  let stepShot = false;
  while (Date.now() - t0 < 15 * 60 * 1000) {
    const st = await ntp.ev(RUN_STATUS);
    if (typeof st === "string" && st !== lastStatus) { lastStatus = st; console.log(`[${Math.round((Date.now() - t0) / 1000)}s] status ${st}`); }
    if (!stepShot && typeof st === "string" && /Step \d+ of \d+/.test(st)) { stepShot = true; await ntp.shot("live-step-counter.png"); }
    const list = await opts.ev(msg({ type: "run.list" }));
    const rows = Array.isArray(list?.runs) ? list.runs : [];
    // THIS run: the one whose stored task is the digest task (the public
    // record carries taskPreview; its timestamps are not relied on).
    const latest = rows.filter((r: any) => /sourced digest/.test(String(r?.taskPreview ?? ""))).pop();
    if (latest && (latest.phase === "terminal" || latest.phase === "cancelled")) { run = latest; break; }
    await sleep(1500);
  }
  if (!run) {
    // Honest failure evidence: where the run was when the ceiling hit.
    const list = await opts.ev(msg({ type: "run.list" }));
    const rows = Array.isArray(list?.runs) ? list.runs : [];
    const latest = rows.sort((a: any, b: any) => (a?.createdAt ?? 0) - (b?.createdAt ?? 0)).pop();
    console.log(`run NOT settled: ${JSON.stringify({ phase: latest?.phase, executionId: latest?.executionId, updatedAt: latest?.updatedAt })}`);
    if (latest?.executionId) {
      const logs = await opts.ev(msg({ type: "run.logs", executionId: latest.executionId }));
      const rowsText: string[] = (Array.isArray(logs?.logs) ? logs.logs : []).map((r: any) => { try { return redact(JSON.stringify(r)).slice(0, 300); } catch { return ""; } });
      console.log(`run log rows: ${rowsText.length}`);
      for (const r of rowsText.slice(-8)) console.log("  " + r);
    }
    dumpSwConsole("stalled", 60);
    await ntp.shot("live-stalled.png");
    throw new Error("the run did not settle within 15 minutes");
  }
  dumpSwConsole("settled", 20);
  const elapsedS = Math.round((Date.now() - t0) / 1000);
  console.log(`run settled in ${elapsedS}s: phase=${run.phase} ok=${run.terminal?.ok} errorCategory=${run.terminal?.errorCategory ?? "-"} budget=${JSON.stringify(run.terminal?.budget ?? null)}`);

  // The run log: what actually happened.
  const logs = await opts.ev(msg({ type: "run.logs", executionId: run.executionId }));
  const rows: string[] = (Array.isArray(logs?.logs) ? logs.logs : []).map((r: any) => { try { return JSON.stringify(r); } catch { return ""; } });
  const count = (re: RegExp) => rows.filter((s) => re.test(s)).length;
  const searchCalls = count(/"type":"tool-call".*"tool":"search_tools"/);
  const executeCalls = count(/"type":"tool-call".*"tool":"execute_tool"/);
  // The journaled result is JSON inside JSON (escaped quotes): strip the
  // backslashes before matching so the nested envelope reads plainly.
  const plain = rows.map((s) => s.replace(/\\+/g, ""));
  const listTabsOk = plain.filter((s) => /"type":"tool-result"/.test(s) && /"selectedTool":"list_tabs"/.test(s) && /"ok":true/.test(s)).length;
  const readPageRows = plain.filter((s) => /"type":"tool-result"/.test(s) && /"selectedTool":"read_page"/.test(s));
  const readPageOk = readPageRows.filter((s) => /"ok":true/.test(s) && !/Cannot access|"error":/.test(s)).length;
  const replayed = count(/selection-replayed/);
  // How many inner turns the tool calls spanned (the outer iteration each
  // tool-call row records), and the digest carry-over lines the runtime logged
  // at each boundary (bytes only — never content).
  const digestLines = swConsole.filter((l) => /run digest carried/.test(l)).map((l) => l.slice(0, 200));
  const innerTurns = 1 + Math.max(0, ...digestLines.map((l) => Number(l.match(/"turns":(\d+)/)?.[1] ?? 0)));
  const listedCount = (() => {
    for (const s of plain) {
      if (!/"selectedTool":"list_tabs"/.test(s)) continue;
      const m = s.match(/"count":(\d+)/);
      if (m) return Number(m[1]);
    }
    return null;
  })();

  // The digest: the thread's final assistant text — count the cited facts.
  const thread = await opts.ev(msg({ type: "thread.get", id: run.threadId }));
  const messages: any[] = Array.isArray(thread?.thread?.messages) ? thread.thread.messages : [];
  const assistant = messages.filter((m) => m?.role === "assistant" && typeof m?.content === "string");
  const digest = assistant.map((m) => m.content).join("\n");
  const cited = new Set<number>();
  for (const m of digest.matchAll(/FACT-(\d{2})/g)) cited.add(Number(m[1]));
  const citedUrls = new Set<number>();
  for (const m of digest.matchAll(/\/page\/(\d+)/g)) citedUrls.add(Number(m[1]));
  await Deno.writeTextFile(`${OUT}/live-digest.txt`, digest);
  await ntp.shot(MAX_ITERATIONS != null ? "every-tab-three-turns.png" : "every-tab-digest.png");

  const report = {
    model: MODEL_ID,
    ...(MAX_ITERATIONS != null ? { maxIterations: MAX_ITERATIONS, innerStepLimit: Math.max(2, Math.min(MAX_ITERATIONS, 24)) } : {}),
    innerTurns,
    digestCarries: digestLines,
    tabsOpened: TAB_COUNT,
    tabsSeenByChrome: openTabs,
    listedByListTabs: listedCount,
    listTabsCalls: listTabsOk,
    searchToolsCalls: searchCalls,
    executeToolCalls: executeCalls,
    readPageCalls: readPageRows.length,
    readPageOk,
    selectionReplayed: replayed,
    citedFacts: cited.size,
    citedUrls: citedUrls.size,
    terminal: { ok: run.terminal?.ok, errorCategory: run.terminal?.errorCategory ?? null, budget: run.terminal?.budget ?? null },
    elapsedS,
    logRows: rows.length,
  };
  console.log("LIVE REPORT", JSON.stringify(report));
  await Deno.writeTextFile(`${OUT}/live-report.json`, JSON.stringify(report, null, 2));
  exitCode = readPageOk >= TAB_COUNT && replayed === 0 && cited.size >= TAB_COUNT ? 0 : 1;
  for (const t of tabTargets) await send("Target.closeTarget", { targetId: t });
} catch (e) {
  console.error("live-every-tab failed:", redact(String((e as Error)?.message ?? e)));
  dumpSwConsole("failure", 60);
  exitCode = 1;
} finally {
  await kill();
  try { await fixture.shutdown(); } catch { /* closed */ }
  try { await Deno.remove(profile, { recursive: true }); } catch { /* gone */ }
}
Deno.exit(exitCode);
