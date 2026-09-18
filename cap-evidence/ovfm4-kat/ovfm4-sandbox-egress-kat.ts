// ovfm4-sandbox-egress-kat.ts — Stage 4 KAT: what can the script sandbox reach?
//
//   deno run -A cap-evidence/ovfm4-sandbox-egress-kat.ts [outDir]
//
// The claim under test (docs/SANDBOX-JS-MODULES-DESIGN.md Stage 2/3, and the
// sandbox's own header): a script in sandbox/script-sandbox.html has exactly
// the host-bridged `fetch` and log, from an opaque origin. The bead's extra
// scope (coord 195/196 + Astra review) says the manifest sandbox CSP declares
// no connect-src and no default-src, so the claim must be MEASURED, and the
// four properties kept apart:
//
//   confinement (opaque origin) · outgoing reachability · CORS readability ·
//   credential transmission
//
// Nothing about origin=null proves "no egress", so every case below has an
// observing assertion on the SERVER side (an owned endpoint that records what
// actually arrived) and a deliberate opposite: the bridged fetch must be
// refused and must NOT arrive, while a remote <script> must be refused BY CSP
// and must NOT arrive — those two non-arrivals are what make the arrivals mean
// something rather than being a server that logs everything it sees.
//
// The module runs on the real Stage 3 path: runScriptInIframe() from an
// extension page mints the Blob URL, injects the import map, and executes the
// source as an ES module inside the sandboxed iframe.

import { fileURLToPath } from "node:url";
import { launchChrome, openCdp, computeUnpackedExtensionId } from "../scripts/lib/chrome-launch.ts";
import { durableDir } from "../scripts/lib/durable-root.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXT = `${ROOT}extension`;
const OUT = Deno.args[0] ?? durableDir("ovfm4-sandbox-egress");
const PORT = 8955;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; failures.push(name); console.log(`FAIL: ${name} — ${JSON.stringify(detail).slice(0, 300)}`); }
}

await Deno.mkdir(OUT, { recursive: true });

// ── the owned endpoint: the observing assertion for every egress case ───────
type Seen = { method: string; path: string; origin: string | null; referer: string | null; cookie: string | null; upgrade: string | null };
const seen: Seen[] = [];
const server = Deno.serve({ port: PORT, hostname: "127.0.0.1" }, (req) => {
  const u = new URL(req.url);
  seen.push({
    method: req.method, path: u.pathname,
    origin: req.headers.get("origin"), referer: req.headers.get("referer"),
    cookie: req.headers.get("cookie"), upgrade: req.headers.get("upgrade"),
  });
  const headers: Record<string, string> = { "content-type": "text/plain" };
  if (u.pathname === "/probe-cors") headers["access-control-allow-origin"] = "*";
  if (u.pathname === "/probe-script.js") headers["content-type"] = "text/javascript";
  if (u.pathname === "/probe-es") headers["content-type"] = "text/event-stream";
  const body = u.pathname === "/probe-cors" ? "cors-ok"
    : u.pathname === "/probe-script.js" ? "window.__katRemoteScriptRan = true;"
    : "ok";
  return new Response(body, { headers });
});
const arrived = (p: string) => seen.some((s) => s.path === p);

// ── the probe module, executed inside the real sandbox as an ES module ─────
const MODULE_SOURCE = `
export default async () => {
  const out = { origin: String(location.origin), cases: {} };
  const B = ${JSON.stringify(BASE)};
  const wait = (fn) => new Promise((res) => { try { fn(res); } catch (e) { res("err:" + String(e)); } });

  // 1. the bridged fetch (window.fetch is replaced by the host bridge)
  out.cases.bridged = await wait(async (res) => {
    try { const r = await fetch(B + "/probe-bridged"); res("status:" + r.status); }
    catch (e) { res("refused:" + String(e).slice(0, 120)); }
  });
  // 2. the bridge's SSRF validation (link-local metadata address)
  out.cases.bridgedSsrf = await wait(async (res) => {
    try { const r = await fetch("http://169.254.169.254/latest/meta-data/"); res("status:" + r.status); }
    catch (e) { res("refused:" + String(e).slice(0, 120)); }
  });
  // 3. AMBIENT XMLHttpRequest, cross-origin, no CORS headers on the response
  out.cases.xhrPlain = await wait((res) => {
    const x = new XMLHttpRequest();
    x.open("GET", B + "/probe-plain");
    x.onload = () => res("status:" + x.status + " readable:" + String(x.responseText).slice(0, 20));
    x.onerror = () => res("onerror (arrived, unreadable)");
    x.send();
  });
  // 4. AMBIENT XHR where the response IS CORS-readable
  out.cases.xhrCors = await wait((res) => {
    const x = new XMLHttpRequest();
    x.open("GET", B + "/probe-cors");
    x.onload = () => res("status:" + x.status + " readable:" + String(x.responseText).slice(0, 20));
    x.onerror = () => res("onerror");
    x.send();
  });
  // 5. WebSocket handshake
  out.cases.webSocket = await wait((res) => {
    try { const w = new WebSocket("ws://127.0.0.1:${PORT}/probe-ws");
      w.onopen = () => res("open"); w.onerror = () => res("error (handshake attempted)");
      setTimeout(() => res("timeout (handshake attempted)"), 2500);
    } catch (e) { res("err:" + String(e)); }
  });
  // 6. sendBeacon
  out.cases.beacon = await wait((res) => {
    try { res("queued:" + navigator.sendBeacon(B + "/probe-beacon", "x=1")); } catch (e) { res("err:" + String(e)); }
  });
  // 7. an image element
  out.cases.image = await wait((res) => {
    const i = new Image();
    i.onload = () => res("load"); i.onerror = () => res("error (request attempted)");
    i.src = B + "/probe-img?t=" + Date.now();
    setTimeout(() => res("timeout"), 2500);
  });
  // 8. EventSource
  out.cases.eventSource = await wait((res) => {
    try { const es = new EventSource(B + "/probe-es");
      es.onopen = () => res("open"); es.onerror = () => res("error (request attempted)");
      setTimeout(() => res("timeout (request attempted)"), 2500);
    } catch (e) { res("err:" + String(e)); }
  });
  // 9. a REMOTE classic script — the discriminating negative: script-src IS declared
  out.cases.remoteScript = await wait((res) => {
    const s = document.createElement("script");
    s.src = B + "/probe-script.js";
    s.onload = () => res("load"); s.onerror = () => res("error (blocked or failed)");
    document.head.appendChild(s);
    setTimeout(() => res("timeout"), 2500);
  });
  out.remoteScriptRan = window.__katRemoteScriptRan === true;
  return out;
};
`;

// ── Stage 4 module cases, run through the same host path ───────────────────
// Each sub-case is a real runScriptInIframe call with a REAL import map minted
// by the host; the digest is computed by the shipped lib, not by this harness,
// so a lib/inline divergence would surface as digest_mismatch rather than hide.
const MOD_SOURCE = "export const value = 'from-module-ok'; export default async () => 'from-module-ok';";
const FETCH_MOD_SOURCE = `export default async () => { try { const r = await fetch(${JSON.stringify(BASE + "/probe-from-module")}); return 'status:' + r.status; } catch (e) { return 'refused:' + String(e).slice(0, 90); } };`;

async function runModuleCases() {
  const { proc, wsUrl } = await launchChrome({ extension: EXT, timeoutMs: 40_000 });
  try {
    const cdp = await openCdp(wsUrl);
    const id = await computeUnpackedExtensionId(EXT);
    const page = await cdp.open(`chrome-extension://${id}/options/options.html`);
    await new Promise((r) => setTimeout(r, 1500));
    return await cdp.eval(page.sessionId, `(async () => {
      const host = await import(chrome.runtime.getURL("lib/script-host.js"));
      const lib = await import(chrome.runtime.getURL("lib/script-sandbox-modules.js"));
      const enc = new TextEncoder();
      const modSource = ${JSON.stringify(MOD_SOURCE)};
      const good = lib.computeModuleDigest(enc.encode(modSource));
      const bad = "0".repeat(64);
      const fetchMod = ${JSON.stringify(FETCH_MOD_SOURCE)};
      const fetchDigest = lib.computeModuleDigest(enc.encode(fetchMod));
      const out = {};
      out.goodDigest = good;
      out.mapped = await host.runScriptInIframe(document, 'export default async () => { const def = (await import("kat-mod")).default; return await def(); };', "kat-mapped", { timeoutMs: 15000, modules: [{ name: "kat-mod", digest: good, source: modSource }] });
      out.mismatch = await host.runScriptInIframe(document, 'export default async () => { const def = (await import("kat-mod")).default; return await def(); };', "kat-mismatch", { timeoutMs: 15000, modules: [{ name: "kat-mod", digest: bad, source: modSource }] });
      out.unmapped = await host.runScriptInIframe(document, 'export default async () => { const m = await import("not-in-map"); return typeof m; };', "kat-unmapped", { timeoutMs: 15000 });
      out.importedFetch = await host.runScriptInIframe(document, 'export default async () => { const def = (await import("kat-fetch")).default; return await def(); };', "kat-imported-fetch", { timeoutMs: 15000, modules: [{ name: "kat-fetch", digest: fetchDigest, source: fetchMod }] });
      return { out };
    })()`);
  } finally {
    try { proc.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

// ── run it through the real host path ─────────────────────────────────────
const { proc, wsUrl } = await launchChrome({ extension: EXT, timeoutMs: 40_000 });
let result: any = null;
try {
  const cdp = await openCdp(wsUrl);
  const id = await computeUnpackedExtensionId(EXT);
  const page = await cdp.open(`chrome-extension://${id}/options/options.html`);
  await new Promise((r) => setTimeout(r, 1500)); // let the page settle

  result = await cdp.eval(page.sessionId, `(async () => {
    const host = await import(chrome.runtime.getURL("lib/script-host.js"));
    return await host.runScriptInIframe(document, ${JSON.stringify(MODULE_SOURCE)}, "ovfm4-kat", { timeoutMs: 25000 });
  })()`);
} finally {
  try { proc.kill("SIGKILL"); } catch { /* already gone */ }
  // the owned endpoint stays up for the module cases below: shutting it down here
  // would make "never reached the endpoint" vacuously true
}

const cases = result?.result?.cases ?? {};
const dump = { result, seen, failures, timestamp: new Date().toISOString() };
await Deno.writeTextFile(`${OUT}/kat.json`, JSON.stringify(dump, null, 1));

// ── assertions: arrivals need a non-arrival beside them ───────────────────
check("the sandbox module executed at all (host bridge round-trip)", result?.ok === true && !!result?.result, result);
// Probe the confinement property where it is observable: the wire. `location.origin`
// inside the frame self-reports the frame's URL (chrome-extension://…), which is NOT
// its security origin — the first run of this KAT asserted on that signal and was wrong.
// What the server saw is the evidence: every ambient request carried `Origin: null`.
const ambient = seen.filter((s) => ["/probe-plain", "/probe-cors", "/probe-ws", "/probe-beacon", "/probe-es"].includes(s.path));
check("the sandbox's requests carry `Origin: null` — opaque origin, read from the wire not from location.origin",
  ambient.length > 0 && ambient.every((s) => s.origin === "null"),
  { ambient: ambient.map((s) => s.path), origins: ambient.map((s) => s.origin), locationOriginInFrame: result?.result?.origin });

check("BRIDGED fetch is refused without an approved run allow-list",
  /refused|error/i.test(String(cases.bridged)), cases.bridged);
check("…and the refused bridged fetch never reached the endpoint (observing assertion)",
  !arrived("/probe-bridged"), seen.filter((s) => s.path === "/probe-bridged"));

check("BRIDGED fetch to a link-local metadata address is refused by URL validation",
  /refused|error/i.test(String(cases.bridgedSsrf)), cases.bridgedSsrf);
check("…and that request never left the browser",
  !seen.some((s) => (s.path ?? "").includes("meta-data")), seen.map((s) => s.path));

check("AMBIENT XHR REACHES the endpoint (egress is not confined to the bridge)",
  arrived("/probe-plain"), seen.map((s) => s.path));
check("…and its response is NOT readable without CORS (reachability ≠ readability)",
  /onerror|status:0|unreadable/i.test(String(cases.xhrPlain)), cases.xhrPlain);
check("AMBIENT XHR to a CORS-permitting endpoint IS readable (readability is a separate property)",
  /status:200/.test(String(cases.xhrCors)) && /cors-ok/.test(String(cases.xhrCors)), cases.xhrCors);
check("the ambient XHR carried an Origin header to the server (and it is `null`)",
  seen.some((s) => s.origin === "null"), seen.filter((s) => s.path === "/probe-plain").map((s) => s.origin));

check("AMBIENT WebSocket handshake reached the endpoint", arrived("/probe-ws"), seen.map((s) => s.path));
check("AMBIENT sendBeacon reached the endpoint", arrived("/probe-beacon"), seen.map((s) => s.path));
check("AMBIENT image request reached the endpoint", arrived("/probe-img"), seen.map((s) => s.path));
check("AMBIENT EventSource request reached the endpoint", arrived("/probe-es"), seen.map((s) => s.path));

check("a REMOTE classic script was REFUSED and never reached the endpoint (script-src IS declared)",
  !arrived("/probe-script.js") && cases.remoteScriptRan !== true, { remoteScript: cases.remoteScript, seen: seen.map((s) => s.path) });

check("no cookie was transmitted by any ambient request (credential transmission, measured not inferred)",
  seen.every((s) => !s.cookie), seen.filter((s) => s.cookie));

// ── Stage 4 core: import-map resolution and digest refusal, same real path ──
const modules = await runModuleCases();
await Deno.writeTextFile(`${OUT}/modules.json`, JSON.stringify(modules, null, 1));
const M = modules?.out ?? {};
check("bare specifier resolves through the injected import map (positive)",
  M.mapped?.ok === true && String(M.mapped?.result) === "from-module-ok", M.mapped);
check("a digest mismatch FAILS CLOSED with digest_mismatch — the module never runs",
  M.mismatch?.ok === false && /digest_mismatch/.test(String(M.mismatch?.error)), M.mismatch);
check("the same module with its TRUE digest runs — so the refusal above is the digest, not the module",
  M.mapped?.ok === true && M.mismatch?.ok === false, { mapped: M.mapped?.ok, mismatch: M.mismatch?.ok });
check("an unmapped bare specifier does NOT resolve (the import map is load-bearing)",
  M.unmapped?.ok === false, M.unmapped);
check("host-bridged fetch applies to code inside an IMPORTED module too",
  /refused|error/i.test(String(M.importedFetch?.result ?? M.importedFetch?.error)), M.importedFetch);
check("— and that imported module's fetch never reached the endpoint",
  !arrived("/probe-from-module"), seen.map((s) => s.path));

console.log(`\nOVFM4 sandbox egress KAT: ${pass} passed, ${fail} failed`);
console.log(`evidence: ${OUT}/kat.json`);
await server.shutdown();
if (fail) { console.log(`failures: ${failures.join("; ")}`); Deno.exit(1); }
