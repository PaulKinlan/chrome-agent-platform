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
import { launchChrome, openCdp, computeUnpackedExtensionId } from "../../scripts/lib/chrome-launch.ts";
import { durableDir } from "../../scripts/lib/durable-root.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const EXT = `${ROOT}/extension`;
const OUT = Deno.args[0] ?? durableDir("ovfm4-sandbox-egress");

let pass = 0, fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; failures.push(name); console.log(`FAIL: ${name} — ${String(JSON.stringify(detail)).slice(0, 300)}`); }
}

await Deno.mkdir(OUT, { recursive: true });

// ── the owned endpoint: the observing assertion for every egress case ───────
type Seen = { method: string; path: string; origin: string | null; referer: string | null; cookie: string | null; upgrade: string | null };
const seen: Seen[] = [];
const server = Deno.serve({ port: 0, hostname: "127.0.0.1" }, (req) => {
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
const port = server.addr.port;
const base = `http://127.0.0.1:${port}`;
const arrived = (p: string) => seen.some((s) => s.path === p);

// ── the probe module, executed inside the real sandbox as an ES module ─────
const MODULE_SOURCE = `
export default async () => {
  const out = { origin: String(location.origin), cases: {} };
  const B = ${JSON.stringify(base)};
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
    try { const w = new WebSocket("ws://127.0.0.1:${port}/probe-ws");
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
const MOD_SOURCE = "export const value = 'from-module-ok'; export default async () => 'from-module-ok';";
const FETCH_MOD_SOURCE = `export default async () => { try { const r = await fetch(${JSON.stringify(base + "/probe-from-module")}); return 'status:' + r.status; } catch (e) { return 'refused:' + String(e).slice(0, 90); } };`;

const GUARD_MOD_SOURCE = `export default async () => {
  const out = {};
  const probe = async (name, fn) => {
    try { const v = await fn(); out[name] = "NO-THROW:" + String(v).slice(0, 24); }
    catch (e) { out[name] = "threw:" + String(e && e.message ? e.message : e).slice(0, 90); }
  };
  await probe("allowedMath", () => Math.max(1, 2));
  await probe("localStorage", () => localStorage.setItem("k", "v"));
  await probe("sessionStorage", () => sessionStorage.setItem("k", "v"));
  await probe("cookie", () => { document.cookie = "k=v"; return document.cookie; });
  await probe("indexedDB", () => indexedDB.open("k"));
  await probe("caches", () => caches.open("k"));
  await probe("opfs", () => navigator.storage && navigator.storage.getDirectory());
  return out;
};`;

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
      const modSourceExport = ${JSON.stringify("export default async () => 'exact-source-second-mint-ok';")};
      out.mapped = await host.runScriptInIframe(document, 'export default async () => { const def = (await import("kat-mod")).default; return await def(); };', "kat-mapped", { timeoutMs: 15000, modules: [{ name: "kat-mod", digest: good, source: modSource }] });
      out.mismatch = await host.runScriptInIframe(document, 'export default async () => { const def = (await import("kat-mod")).default; return await def(); };', "kat-mismatch", { timeoutMs: 15000, modules: [{ name: "kat-mod", digest: bad, source: modSource }] });
      out.unmapped = await host.runScriptInIframe(document, 'export default async () => { const m = await import("not-in-map"); return typeof m; };', "kat-unmapped", { timeoutMs: 15000 });
      out.importedFetch = await host.runScriptInIframe(document, 'export default async () => { const def = (await import("kat-fetch")).default; return await def(); };', "kat-imported-fetch", { timeoutMs: 15000, modules: [{ name: "kat-fetch", digest: fetchDigest, source: fetchMod }] });
      const guardSrc = ${JSON.stringify('export default async () => { const def = (await import("kat-guards")).default; return await def(); };')};
      const guardMod = ${JSON.stringify(GUARD_MOD_SOURCE)};
      out.guards = await host.runScriptInIframe(document, guardSrc, "kat-guards", { timeoutMs: 15000, modules: [{ name: "kat-guards", digest: lib.computeModuleDigest(enc.encode(guardMod)), source: guardMod }] });
      const iframesBefore = document.querySelectorAll("iframe").length;
      out.secondRunA = await host.runScriptInIframe(document, modSourceExport, "kat-second-a", { timeoutMs: 15000 });
      out.iframesBetween = document.querySelectorAll("iframe").length - iframesBefore;
      out.secondRunB = await host.runScriptInIframe(document, modSourceExport, "kat-second-b", { timeoutMs: 15000 });
      out.iframesAfter = document.querySelectorAll("iframe").length - iframesBefore;
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
}

const cases = result?.result?.cases ?? {};

// ── assertions: arrivals need a non-arrival beside them ───────────────────
check("the sandbox module executed at all (host bridge round-trip)", result?.ok === true && !!result?.result, result);

// ── always-on: the discriminating NEGATIVES (they hold in both regimes) ────
check("BRIDGED fetch is refused with loopback policy error",
  String(cases.bridged).includes("refused: private or loopback address"), cases.bridged);
check("…and the refused bridged fetch never reached the endpoint (observing assertion)",
  !arrived("/probe-bridged"), seen.filter((s) => s.path === "/probe-bridged"));
check("BRIDGED fetch to link-local metadata address is refused by loopback/private host policy",
  String(cases.bridgedSsrf).includes("refused: private or loopback address"), cases.bridgedSsrf);
check("a REMOTE classic script was REFUSED and never reached the endpoint (script-src IS declared)",
  !arrived("/probe-script.js") && cases.remoteScriptRan !== true,
  { remoteScript: cases.remoteScript, seen: seen.map((s) => s.path) });

// ── regime-aware egress assertions ─────────────────────────────────────────
const AMBIENT = ["/probe-plain", "/probe-cors", "/probe-ws", "/probe-beacon", "/probe-es", "/probe-img"];
const ambient = seen.filter((s) => AMBIENT.includes(s.path));
const egressObserved = ambient.length > 0;

if (egressObserved) {
  check("ambient egress must NOT reach the endpoint (confined to host bridge)", false,
    { ambient: ambient.map((s) => s.path), origins: ambient.map((s) => s.origin) });
} else {
  // The policy is doing its job.
  const bridgedRefused = String(cases.bridged).includes("refused: private or loopback address");
  check("NO ambient egress observed — the locked-down-policy state (this is a PASS, not a regression)",
    seen.filter((s) => AMBIENT.includes(s.path)).length === 0 && result?.ok === true,
    { ambient: [], bridgedFetchStillGated: bridgedRefused, moduleRan: result?.ok === true });
  check("…and the apparatus was demonstrably alive (the module ran on the real host path)",
    result?.ok === true && !!result?.result, result?.ok);
  check("…and the bridged path was still exercised, so 'no egress' is not 'no browser'",
    bridgedRefused, cases.bridged);
}

// ── Stage 4 core: import-map resolution and digest refusal, same real path ──
const modules = await runModuleCases();
const M = modules?.out ?? {};
const G = M.guards?.result ?? {};
const guardKeys = ["localStorage", "sessionStorage", "cookie", "indexedDB", "caches", "opfs"];
check("bare specifier resolves through the injected import map (positive)",
  M.mapped?.ok === true && String(M.mapped?.result) === "from-module-ok", M.mapped);
check("a digest mismatch FAILS CLOSED with digest_mismatch — the module never runs",
  M.mismatch?.ok === false && /digest_mismatch/.test(String(M.mismatch?.error)), M.mismatch);
check("the same module with its TRUE digest runs — so the refusal above is the digest, not the module",
  M.mapped?.ok === true && M.mismatch?.ok === false, { mapped: M.mapped?.ok, mismatch: M.mismatch?.ok });
check("an unmapped bare specifier does NOT resolve (the import map is load-bearing)",
  M.unmapped?.ok === false, M.unmapped);
check("storage teaching guards stay ACTIVE inside an imported module (all six surfaces throw the teaching error)",
  guardKeys.every((k) => /^threw:/.test(String(G[k] ?? "")) && /sandbox/i.test(String(G[k] ?? ""))),
  Object.fromEntries(guardKeys.map((k) => [k, G[k]])));
check("— and the probe can detect a SUCCESS, so the six throws are the guards and not a broken probe",
  /^NO-THROW:2/.test(String(G.allowedMath ?? "")), G.allowedMath);
check("the SAME exact source runs twice without a mangled second mint (ovfm.3 regression preserved)",
  M.secondRunA?.ok === true && M.secondRunB?.ok === true && String(M.secondRunA?.result) === String(M.secondRunB?.result),
  { a: M.secondRunA, b: M.secondRunB });
check("— and each run removed its sandbox iframe (no leak between runs)",
  M.iframesBetween === 0 && M.iframesAfter === 0, { between: M.iframesBetween, after: M.iframesAfter });

check("host-bridged fetch applies to code inside an IMPORTED module too",
  M.importedFetch?.ok === true && String(M.importedFetch?.result).includes("refused: private or loopback address"), M.importedFetch);
check("— and that imported module's fetch never reached the endpoint",
  !arrived("/probe-from-module"), seen.map((s) => s.path));

// ── write final evidence after ALL checks and modules have run ───────────────
const dump = { result, seen, modules, failures, pass, fail, timestamp: new Date().toISOString() };
await Deno.writeTextFile(`${OUT}/kat.json`, JSON.stringify(dump, null, 1));
await Deno.writeTextFile(`${OUT}/modules.json`, JSON.stringify(modules, null, 1));

console.log(`\nOVFM4 sandbox egress KAT: ${pass} passed, ${fail} failed`);
console.log(`evidence: ${OUT}/kat.json`);
await server.shutdown();
if (fail) { console.log(`failures: ${failures.join("; ")}`); Deno.exit(1); }
