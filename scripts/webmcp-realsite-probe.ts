// webmcp-realsite-probe.ts — instrumented reproduction for
// chrome-agent-platform-ajcc: drive the REAL declared tool
// search_docs({query}) on https://beads.gascity.com through the production
// enrollment + invocation path in a loaded extension, with the page-side
// dispatcher's diagnostics channel ON, and capture BOTH sides of the failure:
//   - the bridge/agent-visible result (what the model sees), and
//   - the page-console raw error (the diagnostics-gated warnToolFailure log —
//     the real name/message/stack the bridge redaction strips).
// The probe is the diagnosis artifact: it changes nothing about the site, and
// its evidence JSON records exactly what threw, in which realm, on which
// origin. Run before the honest-error fix to capture the redacted baseline;
// run after to show the same failure carrying its cause across the bridge.
//
//   deno run -A scripts/webmcp-realsite-probe.ts [<out-dir>]
//
// Network-dependent: fails honestly when the site or its search API is
// unreachable (the invoke then errors at a different layer and the probe
// says so).
//
// MODELCONTEXT SHIM: this Chromium (150) has no native document.modelContext,
// and beads.gascity.com (Mintlify) registers its tools ONLY when the native
// API already exists (`let r = document.modelContext; if (!r) return`). The
// probe therefore installs a faithful webmcp-tools-shaped shim at
// document_start (registerTool/getTools/executeTool over a Map) so the site's
// REAL registration and REAL search handler execute for real — including its
// live POST to /_mintlify/api-public/search/beads. What the shim cannot
// reproduce is Chrome's NATIVE dispatch layer; if the site handler succeeds
// under the shim, the owner's DOMException originates in the native layer,
// not in the site's code, and that conclusion is recorded in the evidence.

import { launchChrome, waitForServiceWorker } from "./lib/chrome-launch.ts";
import { durableDir } from "./lib/durable-root.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = `${ROOT}extension`;
const OUT = Deno.args[0] ?? `${ROOT}.cache/webmcp-realsite-probe`;
const SITE = "https://beads.gascity.com";
const TOOL = "search_docs";
const QUERY = "installation";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`); }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
await Deno.mkdir(OUT, { recursive: true });

// Headless Chrome does not settle the JIT scripting grant (the acceptance
// harness's headless mode does the same): copy the extension and move
// scripting+tabs from optional to required for the probe's load only.
// Transient build scratch, rebuilt every run (webmcp-acceptance.ts pattern).
const VARIANT = durableDir(`cap-webmcp-probe-variant-${Date.now()}`);
{
  const cp = new Deno.Command("cp", { args: ["-r", EXT + "/.", VARIANT] }).spawn();
  await cp.status;
  const mf = JSON.parse(await Deno.readTextFile(`${VARIANT}/manifest.json`));
  mf.permissions = [...new Set([...(mf.permissions ?? []), "scripting", "tabs"])];
  mf.optional_permissions = (mf.optional_permissions ?? []).filter((p: string) => p !== "scripting" && p !== "tabs");
  await Deno.writeTextFile(`${VARIANT}/manifest.json`, JSON.stringify(mf, null, 2) + "\n");
}

const profile = `${ROOT}.cache/webmcp-realsite-probe-${Date.now()}`;
const { proc, wsUrl } = await launchChrome({
  binary: "/usr/bin/chromium",
  args: ["--headless=new", "--no-sandbox", "--disable-gpu", "--silent-debugger-extension-api",
    `--disable-extensions-except=${VARIANT}`, `--load-extension=${VARIANT}`,
    "--remote-allow-origins=*", "--window-size=1400,1200",
    `--user-data-dir=${profile}`, "about:blank"],
});

const consoleEvents: { text: string; args: unknown[] }[] = [];
const ws = new WebSocket(wsUrl);
await new Promise((r, j) => { ws.onopen = () => r(null); ws.onerror = j; });
let id = 0; const pending = new Map<string, (v: any) => void>();
ws.onmessage = (m: MessageEvent) => {
  const j = JSON.parse(m.data as string);
  if (j.id && pending.has(String(j.id))) { pending.get(String(j.id))!(j); pending.delete(String(j.id)); return; }
  if (j.method === "Runtime.consoleAPICalled") {
    const args = (j.params?.args ?? []).map((a: any) => a?.value ?? a?.description ?? a?.unserializableValue ?? "");
    const text = args.map(String).join(" ");
    if (text.includes("[WebMCP")) consoleEvents.push({ text: text.slice(0, 2000), args: args.slice(0, 6) });
  }
};
const send = (method: string, params: any = {}, sessionId?: string) => new Promise<any>((res) => {
  const mid = ++id; pending.set(String(mid), res);
  ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
});
const evalIn = async (sid: string, expr: string) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sid);
  if (r?.result?.exceptionDetails) return { __exception: r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text };
  return r?.result?.result?.value;
};
const until = async (fn: () => Promise<any>, ms: number, step = 400) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await sleep(step);
  }
  return null;
};
const clickSelector = async (sid: string, expr: string) => {
  const box = await evalIn(sid, `(() => { const el = ${expr}; if (!el) return null; el.scrollIntoView({block:"center"}); const r = el.getBoundingClientRect(); return {x:r.x+r.width/2, y:r.y+r.height/2}; })()`);
  if (!box || typeof box.x !== "number") return false;
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", buttons: 1, clickCount: 1 }, sid);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", buttons: 0, clickCount: 1 }, sid);
  return true;
};

try {
  // 1. Extension service worker.
  const sw = await waitForServiceWorker((m, p) => send(m, p), { timeoutMs: 20000 });
  check("extension service worker present", !!sw);
  const sws = (await send("Target.attachToTarget", { targetId: sw.targetId, flatten: true })).result?.sessionId;
  await send("Runtime.enable", {}, sws);
  const extId = new URL(sw.url).host;

  // 2. Diagnostics ON via the REAL Settings toggle (gates the page-side
  //    [WebMCP:main] console capture we read the raw error from).
  const optT = await send("Target.createTarget", { url: `chrome-extension://${extId}/options/options.html` });
  const opts = (await send("Target.attachToTarget", { targetId: optT.result.targetId, flatten: true })).result?.sessionId;
  await send("Runtime.enable", {}, opts);
  await sleep(1600);
  const diagClicked = await clickSelector(opts, `document.getElementById("webmcp-diagnostics")`);
  check("Settings: clicked the Diagnostics toggle via a real click", diagClicked);
  const diagOn = await until(() => evalIn(opts, `chrome.runtime.sendMessage({ type: "webmcp.diagnostics.get" }).then(r => r?.enabled === true)`), 8000);
  check("diagnostics gate enabled", diagOn === true, diagOn);
  await send("Target.closeTarget", { targetId: optT.result.targetId });

  // 3. The real site — attach with console capture BEFORE navigation, and
  //    install the faithful modelContext shim at document_start (see header:
  //    this Chromium has no native WebMCP, and the site registers tools only
  //    when the API already exists). The site's own registration + handler
  //    code then runs for real.
  const sT = await send("Target.createTarget", { url: "about:blank" });
  const site = (await send("Target.attachToTarget", { targetId: sT.result.targetId, flatten: true })).result?.sessionId;
  await send("Runtime.enable", {}, site);
  await send("Page.enable", {}, site);
  const shim = `(() => {
    if (document.modelContext) return;
    const tools = new Map();
    document.modelContext = {
      registerTool: (t) => { tools.set(t.name, t); document.dispatchEvent(new Event("modelcontextchange")); return Promise.resolve(t); },
      getTools: () => Promise.resolve([...tools.values()].map((t) => ({
        name: t.name, description: t.description,
        inputSchema: typeof t.inputSchema === "string" ? t.inputSchema : JSON.stringify(t.inputSchema ?? { type: "object", properties: {} }),
        execute: t.execute,
      }))),
      executeTool: (tool, args) => Promise.resolve().then(() => tool.execute(args)),
    };
  })()`;
  await send("Page.addScriptToEvaluateOnNewDocument", { source: shim }, site);
  await send("Page.navigate", { url: `${SITE}/` }, site);
  const siteLoaded = await until(() => evalIn(site, `document.readyState === "complete" && !!document.modelContext ? true : null`), 45000);
  check("real site loaded with (shimmed) document.modelContext present", siteLoaded === true, siteLoaded);
  const siteRegistered = await until(() => evalIn(site, `document.modelContext.getTools().then(ts => ts.some(t => t.name === ${JSON.stringify(TOOL)}) ? ts.map(t => t.name) : null)`), 20000);
  check("the site's REAL registration ran under the shim (search_docs present page-side)", Array.isArray(siteRegistered), siteRegistered);

  // 4. Enroll through the REAL hub picker (discover → pick the site's tab).
  const nT = await send("Target.createTarget", { url: `chrome-extension://${extId}/ntp/ntp.html` });
  const ns = (await send("Target.attachToTarget", { targetId: nT.result.targetId, flatten: true })).result?.sessionId;
  await send("Runtime.enable", {}, ns);
  await sleep(1600);
  await send("Target.activateTarget", { targetId: nT.result.targetId });
  const discoverClicked = await clickSelector(ns, `document.getElementById("discover-page")`);
  check("hub: clicked Discover this page via a real click", discoverClicked);
  await sleep(3000);
  // Diagnostics for the enrollment path: is the passive detector installed in
  // the page, did the site's tools register, what does the SW offer registry
  // hold, and what rows does the picker actually render?
  const detectHook = await evalIn(site, `Object.getOwnPropertyNames(window).filter(n => n.startsWith("capWebmcpDetectBootstrap_")).length > 0 ? "function(randomized)" : typeof window.capWebmcpDetectBootstrap`);
  const pageToolCount = await evalIn(site, `document.modelContext.getTools().then(ts => ts.length).catch(() => -1)`);
  const offers = await evalIn(ns, `chrome.runtime.sendMessage({ type: "agent.tool-offers" })`);
  const pickerRows = await evalIn(ns, `[...document.querySelectorAll("agent-dialog capability-row")].map(r => r.getAttribute("description"))`);
  console.log("probe diagnostics:", JSON.stringify({ detectHook, pageToolCount, offers: String(JSON.stringify(offers)).slice(0, 800), pickerRows }));
  const rowClicked = await until(async () => {
    const has = await evalIn(ns, `(() => {
      const dlg = document.querySelector("agent-dialog");
      if (!dlg) return null;
      const rows = [...dlg.querySelectorAll("capability-row")];
      return rows.find((r) => r.getAttribute("description") === ${JSON.stringify(SITE)}) ? true : null;
    })()`);
    if (!has) return null;
    const clicked = await clickSelector(ns, `(() => {
      const dlg = document.querySelector("agent-dialog");
      const rows = [...dlg.querySelectorAll("capability-row")];
      const row = rows.find((r) => r.getAttribute("description") === ${JSON.stringify(SITE)});
      return row?.shadowRoot?.querySelector("button.run") ?? null;
    })()`);
    return clicked ? true : null;
  }, 30000);
  check("hub: picked the real site's tab in the picker via a real click", rowClicked === true);
  const enrolled = await until(async () => {
    const list = await evalIn(ns, `chrome.runtime.sendMessage({ type: "agent.list" })`);
    return Array.isArray(list) && list.includes(SITE) ? list : null;
  }, 20000);
  check("the real site origin is enrolled", !!enrolled, enrolled);

  // 5. Wait for the directory to carry search_docs (post-enrollment), then
  //    INVOKE through the production extension-only route — the exact call a
  //    site-agent task makes.
  const dirReady = enrolled ? await until(async () => {
    const r = await evalIn(ns, `chrome.runtime.sendMessage({ type: "tools.invoke", origin: ${JSON.stringify(SITE)}, name: ${JSON.stringify(TOOL)}, args: {} })`);
    // An empty-args probe: "no such tool" means discovery has not landed yet;
    // any other answer means the directory knows the tool.
    return (r && !(typeof r?.error === "string" && r.error.includes("no such tool"))) ? true : null;
  }, 30000) : null;
  check("the site directory carries search_docs", dirReady === true, dirReady);
  const siteTools = await evalIn(site, `document.modelContext.getTools().then(ts => ts.map(t => t.name))`).catch(() => null);

  const t0 = Date.now();
  const result = await evalIn(ns, `chrome.runtime.sendMessage({ type: "tools.invoke", origin: ${JSON.stringify(SITE)}, name: ${JSON.stringify(TOOL)}, args: { query: ${JSON.stringify(QUERY)} } })`);
  const elapsedMs = Date.now() - t0;
  console.log(`\nINVOKE RESULT (${elapsedMs}ms):`, JSON.stringify(result, null, 2));

  // 6. The page-side raw error (diagnostics channel) — the part the bridge
  //    redaction strips. Give the console event a beat to arrive.
  await sleep(1200);
  const rawFailure = consoleEvents.filter((e) => e.text.includes("tool call failed") || e.text.includes("DOMException") || e.text.includes("Error"));
  console.log(`\nPAGE CONSOLE (WebMCP + error events, ${consoleEvents.length} total):`);
  for (const e of consoleEvents.slice(-12)) console.log("  ", e.text.slice(0, 400));
  // What the probe proves on THIS Chromium (no native WebMCP): the production
  // path reaches the site's REAL handler and its own envelope comes back
  // (here: the site's backend answers 500 and the handler honestly returns
  // "Search failed (500)" — the handler does NOT throw). The owner-observed
  // DOMException therefore originates in Chrome's NATIVE WebMCP dispatch layer
  // (absent in Chromium 150); on a WebMCP-enabled Chrome this probe captures
  // that layer's raw error through the diagnostics channel below.
  check("the production invoke path reaches the site's REAL handler (its own envelope comes back — the handler does not throw here)",
    result?.ok === true, result);
  check("a failed invoke would carry the honest cause (name + message excerpt)",
    result?.ok === true || (typeof result?.error === "string" && result.error.includes("(")),
    result?.error ?? "(invoke succeeded — nothing to inspect)");
  check("the page-side diagnostics captured the RAW thrown error (or the invoke SUCCEEDED under the shim — handler healthy, owner failure is native-layer)",
    rawFailure.length > 0 || result?.ok === true, { rawFailures: rawFailure.map((e) => e.text.slice(0, 200)), ok: result?.ok });

  await Deno.writeTextFile(`${OUT}/probe-evidence.json`, JSON.stringify({
    ts: new Date().toISOString(),
    site: SITE, tool: TOOL, args: { query: QUERY },
    note: "this Chromium has no native document.modelContext; the probe installs a faithful document_start shim so the site's REAL registration + handler run. If the invoke succeeded under the shim, the owner-reported DOMException originates in Chrome's NATIVE WebMCP dispatch layer (absent here), not in the site's code.",
    siteRegisteredTools: siteTools ?? null,
    elapsedMs,
    invokeResult: result,
    pageConsole: consoleEvents,
  }, null, 2) + "\n");
  console.log(`\nevidence: ${OUT}/probe-evidence.json`);
} finally {
  try { proc.kill("SIGKILL"); } catch { /* already dead */ }
  try { await proc.status; } catch { /* reaped */ }
  await Deno.remove(profile, { recursive: true }).catch(() => {});
  await Deno.remove(VARIANT, { recursive: true }).catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed`);
Deno.exit(fail ? 1 : 0);
