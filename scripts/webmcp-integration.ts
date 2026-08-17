// webmcp-integration.ts — REAL-browser verification that the WebMCP discovery
// discovers BOTH the declared WebMCP tools AND the inferred page functions, and
// that the tools round-trip to the service worker (tools.upsert → agent listing).
//
// The full enrollment→injection path requires the optional host permission,
// which headless Chrome auto-denies (documented in chrome-journeys.ts). This
// test therefore drives the REAL discovery script in a REAL page (declared +
// inferred) and the REAL tools.upsert → list_agents route — the two ends of the
// pipeline — rather than the mock-only webmcp-discovery.test.ts.
//
//   deno run -A scripts/webmcp-integration.ts
const ROOT = new URL("..", import.meta.url).pathname;
const EXT = `${ROOT}extension`;
const CHROMIUM = "/usr/bin/chromium";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log("PASS: " + name); }
  else { fail++; console.log("FAIL: " + name + " — " + JSON.stringify(detail)); }
}
async function fetchJson(url: string) { const r = await fetch(url); return r.json(); }

const PAGE_ORIGIN = "https://webmcp.example";

function launch(profile: string) {
  return new Deno.Command(CHROMIUM, { args: [
    "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
    "--silent-debugger-extension-api", `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    "--remote-debugging-port=0", "--remote-allow-origins=*", "--window-size=1400,1200",
    `--user-data-dir=${profile}`, "about:blank",
  ], stdout: "null", stderr: "piped" }).spawn();
}

async function main() {
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
    const t = await send("Target.createTarget", { url: "http://127.0.0.1:8933/index.html" });
    const ps = (await send("Target.attachToTarget", { targetId: t.targetId, flatten: true })).sessionId;
    await send("Runtime.enable", {}, ps); await sleep(1500);

    // Evaluate the REAL discovery script in the page + capture the posted tools.
    const SRC = Deno.readTextFileSync(`${ROOT}extension/content/main-world.js`);
    const discovery = await evalIn(ps, `(async () => {
      window.__posted = [];
      const origPost = window.postMessage.bind(window);
      window.postMessage = (msg, target) => { window.__posted.push(msg); return origPost(msg, target); };
      ${SRC}
      window.postMessage({ __cairn_bridge: true, type: 'collect', nonce: 'probe' }, '*');
      await new Promise(r => setTimeout(r, 800));
      const toolsMsg = window.__posted.find(m => m && m.type === 'tools');
      return toolsMsg?.tools ?? [];
    })()`);
    const names = (discovery ?? []).map((x: any) => x.name);
    check("REAL browser: declared WebMCP tools discovered (shop.total + shop.catalog)", names.includes("shop.total") && names.includes("shop.catalog"), names);
    check("REAL browser: inferred page function discovered (greet)", names.includes("greet"), names);

    // 2. The tools round-trip to the SW (tools.upsert → list_agents). Enroll a
    //    worker origin in memory (agent.create — no host permission needed) so the
    //    upsert route accepts it, then upsert the DISCOVERED tools + assert the
    //    listing shows them.
    const created = await sendMsg({ type: "agent.create", origin: PAGE_ORIGIN, name: "webmcp worker" });
    check("agent.create enrolled a worker origin", created?.v?.ok === true, created);
    const upsert = await sendMsg({ type: "tools.upsert", origin: PAGE_ORIGIN, tools: discovery ?? [] });
    check("discovered tools upsert to the worker", upsert?.v?.ok === true, upsert);
    const list = await sendMsg({ type: "agent.directory" });
    const site = Array.isArray(list?.v?.agents) ? list.v.agents.find((a: any) => a.origin === PAGE_ORIGIN) : null;
    const siteTools = Array.isArray(site?.tools) ? site.tools : [];
    check("the listed site agent shows the discovered tools", siteTools.includes("shop.total") && siteTools.includes("greet"), siteTools);

    ws.close();
  } finally {
    try { proc.kill("SIGKILL"); } catch {}
    await Deno.remove(profile, { recursive: true }).catch(() => {});
  }
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  if (fail > 0) Deno.exit(1);
}
await main();
