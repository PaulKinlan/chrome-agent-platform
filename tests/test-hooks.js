// test-hooks.js — the Deno unit-test harness's helpers. Lives in tests/
// (NEVER shipped). The shipped modules (lib/kv.js, lib/scheduler.js) OWN their
// in-memory state in module CLOSURE and expose no map/setter/reset/advance API,
// so the harness resets state by re-importing a FRESH module instance with a
// cache-busted dynamic import (Deno treats each distinct URL query as a distinct
// module instance). No __*ForTest export exists anywhere in extension/.
import { SCRIPT_FRAME_CSP } from "../extension/lib/scripts.js";

let seq = 0;
function bust() {
  return `${Date.now()}_${++seq}_${Math.random().toString(36).slice(2)}`;
}

/** Import a FRESH instance of lib/kv.js (fresh session Map + warned/migrated
 * flags). Used by tests that exercise the session fallback / migration state. */
export function freshKv() {
  return import(`../extension/lib/kv.js?fresh=${bust()}`);
}

/** Import a FRESH instance of lib/scheduler.js (fresh activeRuns + BOOT_AT).
 * Used to simulate a service-worker restart. */
export function freshScheduler() {
  return import(`../extension/lib/scheduler.js?fresh=${bust()}`);
}


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
