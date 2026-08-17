// lib/scripts.js — the agent-generated-script system.
//
// Paul (2026-08-17): agents should be able to create JavaScript that runs
// REPEATEDLY — repeatable tasks that do NOT re-invoke the model (no token burn)
// — sandboxed + async, for speed, security, and verifiability.
//
// A script is an origin-keyed asset (like an artifact) with bounded JS source.
// It runs SANDBOXED: the source is evaluated inside an opaque sandboxed iframe
// (sandbox="allow-scripts", a restrictive CSP with NO network access) hosted by
// the OFFSCREEN document. The script gets a CONTROLLED, minimal capability set —
// `fetch(url, opts)` (the offscreen host fetches on the extension's behalf,
// URL-validated + size-bounded) and `log(text)` — and returns a value. It has
// NO raw DOM, NO extension APIs, NO network, and NO access to the parent.
//
// Storage model (mirrors lib/artifacts.js): each script is a SEPARATE OPFS value
// under `script:<id>`; a lightweight reserved INDEX `scripts` lists the metadata
// so list_scripts never reads every body.

import { masterMemory, siteMemory, canonicalOrigin } from "./memory.js";

const INDEX_KEY = "scripts"; // reserved authority key (see memory.js)
const CONTENT_PREFIX = "script:";

export const SCRIPT_BOUNDS = {
  maxSourceBytes: 64 * 1024, // 64 KiB of JS source per script
  maxNameLength: 200,
  maxScriptsPerOrigin: 200,
  maxFetchBytes: 512 * 1024, // a single fetch result the host returns to the script
  maxResultBytes: 256 * 1024, // the returned result (serialized) is bounded
};

const utf8Bytes = (s) => new TextEncoder().encode(String(s ?? "")).byteLength;

function scriptStore(origin) {
  return origin === "master" ? masterMemory() : siteMemory(origin);
}
function canonical(origin) {
  return origin === "master" ? "master" : (canonicalOrigin(origin) ?? "master");
}
function newId() {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function boundScript({ name, source }) {
  const n = String(name ?? "").trim();
  const src = String(source ?? "");
  if (!n) throw new Error("script name required");
  if (n.length > SCRIPT_BOUNDS.maxNameLength) {
    throw new Error(`script name too long (max ${SCRIPT_BOUNDS.maxNameLength})`);
  }
  if (!src.trim()) throw new Error("script source required");
  if (utf8Bytes(src) > SCRIPT_BOUNDS.maxSourceBytes) {
    throw new Error(`script source too large (max ${SCRIPT_BOUNDS.maxSourceBytes} bytes)`);
  }
  return { name: n, source: src };
}

async function readIndex(store) {
  return (await store.get(INDEX_KEY)) ?? [];
}
async function writeIndex(store, index) {
  await store.setTrusted(INDEX_KEY, index);
}

/** Create a script. Returns `{ ok:true, script }` or `{ ok:false, error }`. */
export async function createScript(origin, { name, source }) {
  const o = canonical(origin);
  const store = scriptStore(o);
  let meta;
  try {
    meta = boundScript({ name, source });
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
  const id = newId();
  const body = {
    id,
    name: meta.name,
    source: meta.source,
    origin: o,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastRunAt: null,
    lastResult: null,
    status: "idle", // idle | running | ok | failed
  };
  await store.setTrusted(CONTENT_PREFIX + id, body);
  const index = await readIndex(store);
  if (index.length >= SCRIPT_BOUNDS.maxScriptsPerOrigin) {
    return { ok: false, error: `too many scripts (max ${SCRIPT_BOUNDS.maxScriptsPerOrigin})` };
  }
  index.push({
    id,
    name: meta.name,
    origin: o,
    at: Date.now(),
    sourceBytes: utf8Bytes(meta.source),
  });
  await writeIndex(store, index);
  return { ok: true, script: { id, name: meta.name, origin: o, sourceBytes: utf8Bytes(meta.source) }, index };
}

/** Update a script's name/source. */
export async function updateScript(origin, id, patch = {}) {
  const o = canonical(origin);
  const store = scriptStore(o);
  const body = await store.get(CONTENT_PREFIX + id);
  if (!body) return { ok: false, error: "script not found" };
  if (patch.name !== undefined) body.name = String(patch.name ?? "").trim();
  if (patch.source !== undefined) body.source = String(patch.source ?? "");
  let meta;
  try {
    meta = boundScript({ name: body.name, source: body.source });
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
  body.name = meta.name;
  body.source = meta.source;
  body.updatedAt = Date.now();
  await store.setTrusted(CONTENT_PREFIX + id, body);
  const index = await readIndex(store);
  const idx = index.find((s) => s.id === id);
  if (idx) {
    idx.name = meta.name;
    idx.sourceBytes = utf8Bytes(meta.source);
    idx.at = Date.now();
    await writeIndex(store, index);
  }
  return { ok: true, script: { id, name: meta.name, origin: o } };
}

/** Delete a script (its body + its index row). */
export async function deleteScript(origin, id) {
  const o = canonical(origin);
  const store = scriptStore(o);
  const had = await store.get(CONTENT_PREFIX + id);
  await store.delete(CONTENT_PREFIX + id);
  const index = (await readIndex(store)).filter((s) => s.id !== id);
  await writeIndex(store, index);
  return { ok: had != null, index };
}

/** List an origin's scripts (metadata only). */
export async function listScripts(origin) {
  const store = scriptStore(canonical(origin));
  return { ok: true, scripts: await readIndex(store) };
}

/** Read one script (name + source + status). */
export async function getScript(origin, id) {
  const store = scriptStore(canonical(origin));
  const body = await store.get(CONTENT_PREFIX + id);
  if (!body) return { ok: false, error: "script not found" };
  return { ok: true, script: body };
}

/** Record a run outcome on the script body (status + lastResult + lastRunAt). */
export async function recordScriptRun(origin, id, outcome) {
  const store = scriptStore(canonical(origin));
  const body = await store.get(CONTENT_PREFIX + id);
  if (!body) return { ok: false, error: "script not found" };
  body.status = outcome.ok ? "ok" : "failed";
  body.lastRunAt = Date.now();
  // Bound the retained result (it is telemetry, not the source of truth).
  const result = outcome.result == null ? null : outcome.result;
  body.lastResult = result;
  await store.setTrusted(CONTENT_PREFIX + id, body);
  return { ok: true };
}

// ── the sandbox bootstrap ────────────────────────────────────────────────────

/**
 * The CSP for the script's sandboxed frame. `default-src 'none'` means the
 * script's document has NO network access of its own (it must go through the
 * controlled `fetch` bridge); `script-src 'unsafe-inline' 'unsafe-eval'` lets
 * the injected bootstrap + the wrapped user source run (the sandbox is an
 * OPAQUE origin, fully isolated from the extension + the page, so eval is the
 * whole point — the security boundary is the sandbox, not eval).
 */
export const SCRIPT_FRAME_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'";

/**
 * TEST-ONLY: build the `<iframe srcdoc>` bootstrap for the unit tests. The
 * PRODUCTION path does NOT use a srcdoc — it runs the source via
 * `sandbox/script-sandbox.js` (the manifest `sandbox` page, which uses
 * `new Function` in a page whose CSP is `sandbox allow-scripts` and which has
 * no chrome.* access). The security boundary is the opaque sandbox origin,
 * not the eval mechanism; the CONSTITUTION's "no eval in the bundle" applies
 * to the extension bundle (SW + pages), not the isolated sandbox page.
 */
export function buildScriptSrcdoc(source, { runId, nonce } = {}) {
  const rid = JSON.stringify(String(runId ?? ""));
  const n = JSON.stringify(String(nonce ?? ""));
  // Escape a literal closing script tag so the user source can never break out
  // of its <script> element (the sandbox still has no network, but a breakout
  // could run markup in the frame — close that too).
  const src = String(source ?? "").replace(/<\/script/gi, "<\\/script");
  const navGuard = [
    "(function(){",
    "try{window.open=function(){return null;};}catch(e){}",
    "try{var L=window.location;Object.defineProperty(window,'location',{configurable:false,get:function(){return L;},set:function(){}});}catch(e){}",
    "function block(e){e.preventDefault();e.stopPropagation();}",
    "document.addEventListener('click',function(e){var t=e.target;var a=t&&t.closest?t.closest('a[href],area[href]'):null;if(a)block(e);},true);",
    "document.addEventListener('submit',block,true);",
    "})();",
  ].join("");
  const bridge = [
    "(function(){",
    "var runId=" + rid + "; var nonce=" + n + ";",
    "var pending={};",
    "function post(m){try{window.parent.postMessage(m,'*');}catch(e){}}",
    "function call(kind,payload){",
    "  return new Promise(function(resolve,reject){",
    "    var callId=Math.random().toString(36).slice(2);",
    "    pending[callId]={resolve:resolve,reject:reject};",
    "    post({type:'cap:script-call',runId:runId,nonce:nonce,callId:callId,kind:kind,payload:payload||{}});",
    "  });",
    "}",
    // The controlled api as GLOBALS (shadow the natives — the frame has no
    // network of its own, so this is the script's only fetch + log).
    "window.fetch=function(url,opts){return call('fetch',{url:String(url||''),opts:opts||{}});};",
    "window.log=function(){post({type:'cap:script-log',runId:runId,nonce:nonce,text:Array.prototype.map.call(arguments,function(x){return String(x);}).join(' ')});};",
    "window.addEventListener('message',function(e){",
    "  if(e.source!==window.parent)return;",
    "  var d=e.data; if(!d||d.runId!==runId)return;",
    "  if(d.type==='cap:script-call-result'){",
    "    var p=pending[d.callId]; if(!p)return; delete pending[d.callId];",
    "    if(d.ok){p.resolve(d.value);}else{p.reject(new Error(d.error||'call failed'));}",
    "  }",
    "});",
    "})();",
  ].join("");
  // The user source is the body of an async IIFE, so `await fetch(...)` + `log(...)`
  // + `return <value>` all work. The result/error is posted by the runner below.
  const runner = [
    "(async function(){",
    "try{",
    "  var result=await (async function(){",
    src,
    "  })();",
    "  try{window.parent.postMessage({type:'cap:script-result',runId:" + rid + ",nonce:" + n + ",ok:true,result:result},'*');}catch(e){}",
    "}catch(e){",
    "  try{window.parent.postMessage({type:'cap:script-error',runId:" + rid + ",nonce:" + n + ",error:String(e&&e.message||e)},'*');}catch(_){}",
    "}",
    "})();",
  ].join("\n");

  return (
    `<meta http-equiv="Content-Security-Policy" content="${SCRIPT_FRAME_CSP}">` +
    `<script data-cap-navguard>${navGuard}</script>` +
    `<script data-cap-bridge>${bridge}</script>` +
    `<script data-cap-user>${runner}</script>`
  );
}
