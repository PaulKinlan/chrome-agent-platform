// webmcp-integration.ts — REAL-browser verification that the WebMCP discovery
// discovers BOTH the declared WebMCP tools AND the inferred page functions, and
// that the tools round-trip to the service worker (tools.upsert → agent listing).
//
// The full enrollment→injection path requires the optional host permission,
// which headless Chrome auto-denies (documented in chrome-journeys.ts). This
// test therefore drives the REAL discovery script in a REAL page (declared +
// inferred, served by fixtures/webmcp-server.ts) and the REAL tools.upsert →
// list_agents route — the two ends of the pipeline — plus the NEW
// agent.discover-active route (the active-tab origin resolution the hub's
// "Discover this page" button uses).
//
//   deno run -A scripts/webmcp-integration.ts
const ROOT = new URL("..", import.meta.url).pathname;
const EXT = `${ROOT}extension`;
const CHROMIUM = "/usr/bin/chromium";
const FIXTURE_PORT = 8934;
const PAGE_ORIGIN = `http://127.0.0.1:${FIXTURE_PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log("PASS: " + name); }
  else { fail++; console.log("FAIL: " + name + " — " + JSON.stringify(detail)); }
}
async function fetchJson(url: string) { const r = await fetch(url); return r.json(); }

function launchFixture() {
  return new Deno.Command("deno", { args: ["run", "-A", `${ROOT}fixtures/webmcp-server.ts`], stdout: "null", stderr: "piped" }).spawn();
}

function launch(profile: string) {
  return new Deno.Command(CHROMIUM, { args: [
    "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
    "--silent-debugger-extension-api", `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    "--remote-debugging-port=0", "--remote-allow-origins=*", "--window-size=1400,1200",
    `--user-data-dir=${profile}`, "about:blank",
  ], stdout: "null", stderr: "piped" }).spawn();
}

async function main() {
  // 0. Start the fixture server (the real page the discovery drives).
  const fixture = launchFixture();
  await sleep(800); // let it bind

  const profile = `/tmp/cap-webmcp-int-${Date.now()}`;
  await Deno.mkdir(profile, { recursive: true });
  const proc = launch(profile);
  try {
    let port = 0;
    for (let i = 0; i < 80 && !port; i++) {
      await sleep(250);
      const reader = proc.stderr.getReader();
      const { value, done } = await reader.read(); reader.releaseLock();
      const m = (done ? null : new TextDecoder().decode(value))?.match(/ws:\/\/127\.0\.0\.1:(\d+)/);
      if (m) port = Number(m[1]);
    }
    const version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = rej; });
    let id = 0; const pend = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
    };
    const send = (method: string, params: any, sessionId?: string) => new Promise((res, rej) => { const mid = ++id; pend.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method, params, sessionId })); });
    const evalIn = async (s: string, e: string) => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }, s); return r?.result?.value; };

    // Find the SW + open the NTP (for the message routes).
    let sw: any = null;
    for (let i = 0; i < 60 && !sw; i++) { const ts = await fetchJson(`http://127.0.0.1:${port}/json/list`); sw = ts.find((t: any) => t.type === "service_worker"); if (!sw) await sleep(200); }
    const extId = sw.url.split("/")[2];
    check("extension loaded (service worker present)", !!sw);
    const ntp = await send("Target.createTarget", { url: `chrome-extension://${extId}/ntp/ntp.html` });
    const ns = (await send("Target.attachToTarget", { targetId: ntp.targetId, flatten: true })).sessionId;
    await send("Runtime.enable", {}, ns); await sleep(1500);
    const sendMsg = (p: any) => evalIn(ns, `chrome.runtime.sendMessage(${JSON.stringify(p)}).then(v=>({v}),e=>({err:e.message}))`);

    // 1. A REAL page with a WebMCP polyfill (declared tools) + a page fn (inferred).
    const t = await send("Target.createTarget", { url: `${PAGE_ORIGIN}/index.html` });
    const ps = (await send("Target.attachToTarget", { targetId: t.targetId, flatten: true })).sessionId;
    await send("Runtime.enable", {}, ps); await sleep(1500);

    // Evaluate the REAL discovery script in the page + capture the posted tools
    // AND the [WebMCP] diagnostics logs AND the MAIN-world invoke result (the
    // same handshake the isolated bridge drives: init(diagnostics:true) → collect).
    const SRC = Deno.readTextFileSync(`${ROOT}extension/content/main-world.js`);
    const discovery = await evalIn(ps, `(async () => {
      window.__posted = [];
      window.__webmcpLogs = [];
      const origPost = window.postMessage.bind(window);
      window.postMessage = (msg, target) => { window.__posted.push(msg); return origPost(msg, target); };
      const origLog = window.console.log.bind(window.console);
      window.console.log = (...args) => { window.__webmcpLogs.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')); return origLog(...args); };
      ${SRC}
      // init with diagnostics ON so the [WebMCP:main] logs are emitted, then
      // collect twice — the fixture registers shop.coupon ASYNC at ~700ms, so a
      // single collect misses it; the content script re-polls (800ms/2s/4s).
      window.postMessage({ __cairn_bridge: true, type: 'init', nonce: 'probe', diagnostics: true }, '*');
      const collect = () => window.postMessage({ __cairn_bridge: true, type: 'collect', nonce: 'probe', diagnostics: true }, '*');
      await new Promise(r => setTimeout(r, 600));
      collect();
      await new Promise(r => setTimeout(r, 1000));
      collect();
      await new Promise(r => setTimeout(r, 600));
      const toolsMsgs = window.__posted.filter(m => m && m.type === 'tools');
      const last = toolsMsgs[toolsMsgs.length - 1];
      const tools = last?.tools ?? [];
      // Invoke the inferred page function through the REAL MAIN-world invoke
      // handler (the agent's invoke-tool path reaches this same code).
      const invokeResult = await new Promise((resolve) => {
        const rq = 'inv1';
        const onMsg = (ev) => {
          if (ev.source !== window) return;
          const d = ev.data;
          if (d && d.__cairn_bridge === true && d.type === 'result' && d.requestId === rq) { window.removeEventListener('message', onMsg); resolve(d); }
        };
        window.addEventListener('message', onMsg);
        window.postMessage({ __cairn_bridge: true, type: 'invoke', nonce: 'probe', requestId: rq, name: 'greet', args: { name: 'paul' } }, '*');
        setTimeout(() => resolve(null), 3000);
      });
      return { tools, logs: window.__webmcpLogs, invokeResult };
    })()`);
    const tools = (discovery?.tools ?? []);
    const names = tools.map((x: any) => x.name);
    check("REAL browser: declared WebMCP tools discovered (shop.total + shop.catalog)", names.includes("shop.total") && names.includes("shop.catalog"), names);
    check("REAL browser: inferred page function discovered (greet)", names.includes("greet"), names);
    // The async-registered tool (shop.coupon) must be picked up by the re-poll.
    check("REAL browser: async-registered tool discovered (shop.coupon)", names.includes("shop.coupon"), names);
    // The [WebMCP:main] diagnostics logs must be emitted (start + discover) when
    // the diagnostics gate is on — the "no logs proving it runs" fix.
    const logs = Array.isArray(discovery?.logs) ? discovery.logs : [];
    check("REAL browser: [WebMCP:main] start log emitted", logs.some((l: string) => l.includes("[WebMCP:main]") && l.includes("start")), logs);
    check("REAL browser: [WebMCP:main] discover log emits declared/inferred counts + tool names", logs.some((l: string) => l.includes("discover") && l.includes("declaredCount") && l.includes("shop.total")), logs);
    check("REAL browser: MAIN-world invoke returns the page function result", discovery?.invokeResult?.ok === true && discovery?.invokeResult?.result === "hello paul", discovery?.invokeResult);

    // 2. The tools round-trip to the SW (tools.upsert → list_agents). Enroll the
    //    page's REAL origin in memory (agent.create — no host permission needed)
    //    so the upsert route accepts it, then upsert the DISCOVERED tools + assert
    //    the listing shows them.
    const created = await sendMsg({ type: "agent.create", origin: PAGE_ORIGIN, name: "webmcp worker" });
    check("agent.create enrolled the page origin", created?.v?.ok === true, created);
    const upsert = await sendMsg({ type: "tools.upsert", origin: PAGE_ORIGIN, tools });
    check("discovered tools upsert to the worker", upsert?.v?.ok === true, upsert);
    // Idempotent registration: upserting the SAME set again must not duplicate.
    const upsert2 = await sendMsg({ type: "tools.upsert", origin: PAGE_ORIGIN, tools });
    check("tools.upsert is idempotent (second upsert ok)", upsert2?.v?.ok === true, upsert2);
    const toolList = await sendMsg({ type: "tools.list", origin: PAGE_ORIGIN });
    const listed = Array.isArray(toolList?.v) ? toolList.v : [];
    const uniqueNames = [...new Set(tools.map((x: any) => x.name))];
    check("idempotent upsert keeps a single tool per name (no duplicates)", listed.length === uniqueNames.length, { listed: listed.length, expected: uniqueNames.length, listed });
    const list = await sendMsg({ type: "agent.directory" });
    const site = Array.isArray(list?.v?.agents) ? list.v.agents.find((a: any) => a.origin === PAGE_ORIGIN) : null;
    const siteTools = Array.isArray(site?.tools) ? site.tools : [];
    check("the listed site agent shows the discovered tools", siteTools.includes("shop.total") && siteTools.includes("greet"), siteTools);

    // 2b. The diagnostics toggle + the status surface route (the observability fix).
    const diagSet = await sendMsg({ type: "webmcp.diagnostics.set", enabled: true });
    check("webmcp.diagnostics.set enables the gate", diagSet?.v?.enabled === true, diagSet);
    const diagGet = await sendMsg({ type: "webmcp.diagnostics.get" });
    check("webmcp.diagnostics.get reports enabled", diagGet?.v?.enabled === true, diagGet);
    const wstatus = await sendMsg({ type: "webmcp.status" });
    check("webmcp.status reflects the last discovery (origin + counts + script status)",
      wstatus?.v?.status?.origin === PAGE_ORIGIN &&
      wstatus?.v?.status?.scriptStatus === "discovered" &&
      (wstatus?.v?.status?.toolCount ?? 0) >= uniqueNames.length, wstatus);

    // 3. The agent.discover-active route resolves the active tab's origin (the
    //    hub "Discover this page" button's first step). Without the `tabs`
    //    permission the URL is hidden, so it must honestly report needTabs.
    const da = await sendMsg({ type: "agent.discover-active" });
    check("agent.discover-active returns ok-or-needTabs (never a throw)", da?.v?.ok === true || da?.v?.needTabs === true, da);
    // Grant `tabs` in the NTP (a page context with a user gesture is not
    // available headless, so this asserts the route's honest fallback rather than
    // a successful origin read).
    check("discover-active does not fabricate an origin without the tabs permission", !(da?.v?.needTabs && da?.v?.origin), da);

    ws.close();
  } finally {
    try { proc.kill("SIGKILL"); } catch {}
    try { fixture.kill("SIGKILL"); } catch {}
    await Deno.remove(profile, { recursive: true }).catch(() => {});
  }
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  if (fail > 0) Deno.exit(1);
}
await main();
