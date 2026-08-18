// content/content-script.js — the isolated-world relay between the MAIN-world
// bridge (content/main-world.js) and the extension background worker.
//
// The isolated world cannot see the page's globals, and the MAIN world cannot
// use chrome.* APIs — so this file relays across a nonce-authenticated
// window.postMessage channel:
//   MAIN world → postMessage("tools") → here → chrome.runtime "tools.upsert"
//   background → "invoke-tool" → here → postMessage("invoke") → MAIN world → call
//             → postMessage("result") → here → sendResponse
//
// On EVERY startup (reload / cross-document navigation re-injects this script)
// the bridge pulls the CURRENT enrollment generation from the service worker
// (`enrollment.status`) — a one-time enrollment push can never cover a document
// that did not exist yet, so without the startup pull a fresh bridge would
// reject every invoke forever (fail-closed without recovery).

// Versioned singleton guard (the repeated-enrollment finding): an immediate
// re-injection (re-enroll while the tab is open) re-executes this file in the
// SAME isolated world. Without a guard each execution would install ANOTHER
// pair of listeners, so one invoke would be forwarded once per stale listener
// (duplicate side effects). The previous execution is torn down before the new
// one installs, so exactly ONE live bridge exists per tab.
const BRIDGE_VERSION = 2;
const BRIDGE_GUARD_KEY = "__cairnIsolatedBridge";
{
  const prev = globalThis[BRIDGE_GUARD_KEY];
  if (prev && typeof prev === "object" && typeof prev.teardown === "function") {
    try { prev.teardown(); } catch { /* a stale bridge must never block the new one */ }
  }
}

(() => {
const CHANNEL = "__cairn_bridge";
const TAG = "[WebMCP:bridge]";

// A nonce the MAIN-world bridge must echo back, so a page script cannot spoof
// invoke results or tool reports.
const nonce = crypto.randomUUID();
// The discovery-snapshot session identity: fresh per bridge execution (per
// page load / navigation), with a monotonically increasing sequence per tools
// report, so the SW can order complete replacement snapshots and drop stale
// same-session replays.
const sessionId = crypto.randomUUID();
let collectSeq = 0;

let initialized = false;
// Developer diagnostics (gated): mirrors the MAIN world's [WebMCP] logs from the
// isolated relay side. Off by default; the SW reports the owner's toggle via
// `webmcp.diagnostics.get` (see Settings → Site agents → Diagnostics).
let diagnostics = false;
function log(...args) {
  if (!diagnostics) return;
  try { console.log(TAG, ...args); } catch { /* never throw from a logger */ }
}
async function refreshDiagnostics() {
  try {
    const r = await chrome.runtime.sendMessage({ type: "webmcp.diagnostics.get" });
    if (r && typeof r.enabled === "boolean") diagnostics = r.enabled;
  } catch { /* SW not ready yet — diagnostics stays off */ }
  return diagnostics;
}

// The enrollment generation the service worker has told us is CURRENT for this
// origin. A delete/disenroll tombstones + bumps the generation in the worker, so
// threading it into invoke-tool + enforcing it here lets a stale in-flight
// invocation be REJECTED at this bridge boundary (preemptive revocation: a
// deleted origin's page function must not run).
let currentGen = null; // null = never synced yet (invokes are rejected until a sync arrives)
let disenrolled = false; // a disenrollment was seen — reject ANY stale invoke
                         // (distinct from "never synced": the two must not be
                         // conflated, or a post-delete stale invoke would be
                         // accepted and re-record its old generation)
// The HIGHEST lifecycle generation ever seen (monotonic across sync + disenroll).
// `enrollment-sync` and `disenrollment` both carry the monotonic global enrollment
// generation; a STALE sync (its gen lower than a disenrollment we already saw)
// must be REJECTED rather than clearing `disenrolled` + resuming MAIN (the
// round-24 stale-lifecycle-ordering blocker).
let maxGen = -Infinity;

// Normalize a lifecycle message's generation: a finite non-negative integer,
// else null (missing/invalid). Non-finite (NaN/±Infinity), fractional, and
// negative generations are malformed and must never be trusted for monotonic
// ordering (the round-26 missing-gen blocker).
function normalizeGen(gen) {
  return typeof gen === "number" && Number.isFinite(gen) && Number.isInteger(gen) && gen >= 0
    ? gen
    : null;
}

// The monotonic lifecycle application, shared by the SW-pushed messages AND
// the startup pull (enrollment.status). Returns an error string on rejection.
function applyEnrollmentSync(gen, via) {
  if (gen == null) {
    // Missing/invalid generation must FAIL CLOSED ALWAYS — including the FIRST
    // message (the round-27 blocker 3). The SW ALWAYS produces numeric
    // generations, so there is no valid unscoped path.
    return "missing enrollment generation — sync rejected";
  }
  if (gen < maxGen) {
    return "stale enrollment-sync rejected";
  }
  maxGen = Math.max(maxGen, gen);
  currentGen = gen;
  disenrolled = false;
  log("enrollment-sync", JSON.stringify({ origin: location.origin, gen, via }));
  // (Re-)enrollment clears the MAIN world's cancel epoch so NEW invokes are
  // allowed again (a delete→re-enroll must not leave the page bridge
  // permanently cancelled — the round-23 blocker 1 fix).
  window.postMessage({ [CHANNEL]: true, type: "resume", nonce, diagnostics }, "*");
  return null;
}

function applyDisenrollment(gen, via) {
  // MONOTONIC in BOTH directions (the round-25 blocker 8): reject a STALE
  // disenrollment (older gen than a sync we already applied). Only the LATEST
  // generation wins, for sync AND disenroll. Missing/invalid generation FAILS
  // CLOSED ALWAYS, including the first message (the round-27 blocker 3).
  if (gen == null) {
    return "missing disenrollment generation — rejected";
  }
  if (gen < maxGen) {
    return "stale disenrollment rejected";
  }
  maxGen = Math.max(maxGen, gen);
  disenrolled = true;
  currentGen = null;
  log("disenrollment", JSON.stringify({ origin: location.origin, gen, via }));
  for (const [requestId, send] of pending) {
    pending.delete(requestId);
    try {
      send({ ok: false, error: "origin disenrolled — invocation cancelled" });
    } catch { /* sendResponse already consumed */ }
  }
  window.postMessage({ [CHANNEL]: true, type: "cancel", nonce }, "*");
  return null;
}

// STARTUP SYNC (the reload/navigation fix): a freshly injected bridge has
// never seen the one-time enrollment push, so it pulls the CURRENT enrollment
// generation from the SW (sender-origin-derived server-side) and applies it
// through the same monotonic fence. Until this resolves, invokes fail closed.
function syncEnrollmentAtStartup() {
  chrome.runtime.sendMessage({ type: "enrollment.status" }).then((res) => {
    if (!res || res.ok !== true) {
      log("enrollment-sync", JSON.stringify({ origin: location.origin, via: "startup", ok: false }));
      return; // fail closed — currentGen stays null
    }
    const gen = normalizeGen(res.gen);
    if (res.enrolled === true) {
      applyEnrollmentSync(gen, "startup");
    } else {
      applyDisenrollment(gen, "startup");
    }
  }).catch(() => { /* SW not ready — fail closed */ });
}

function ensureMainWorld() {
  if (initialized) return;
  initialized = true;
  // Post the nonce handshake SYNCHRONOUSLY first (preserving the original
  // no-race init so an invoke that arrives immediately is never stranded), then
  // re-post it once the REAL diagnostics gate is known (same nonce → idempotent:
  // MAIN just re-collects + re-logs its "start" with the correct gate).
  const sendInit = () => window.postMessage({ [CHANNEL]: true, type: "init", nonce, diagnostics }, "*");
  sendInit();
  refreshDiagnostics().then(() => {
    sendInit();
    log("start", JSON.stringify({ origin: location.origin, role: "isolated-bridge", diagnostics }));
  });
}

// A pending invoke request, keyed by requestId → sendResponse.
const pending = new Map();
let reqSeq = 0;

// The dispatch SOURCE is threaded from the SW's tool directory so the MAIN
// world resolves a DECLARED tool only through document.modelContext and an
// INFERRED tool only through the captured exposure registry — never through a
// hijackable window[name] global.
const VALID_SOURCES = new Set(["declared", "inferred"]);

function onWindowMessage(event) {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || typeof data !== "object" || data[CHANNEL] !== true) return;

  if (data.type === "tools") {
    // Nonce-gated: a page script (or a torn-down stale MAIN world) cannot
    // spoof a tool report — only the MAIN world that completed THIS bridge's
    // init handshake echoes the nonce.
    if (!nonce || data.nonce !== nonce) return;
    const tools = Array.isArray(data.tools) ? data.tools : [];
    const origin = location.origin; // never trust a message-supplied origin (cross-origin spoof)
    const declared = tools.filter((t) => t.source === "declared").length;
    const inferred = tools.filter((t) => t.source === "inferred").length;
    log("tools-reported", JSON.stringify({ origin, toolCount: tools.length, declaredCount: declared, inferredCount: inferred, toolNames: tools.map((t) => t.name) }));
    // A COMPLETE replacement snapshot — forwarded even when EMPTY, so a page
    // that removed all its tools gets them removed from the directory too.
    chrome.runtime.sendMessage({ type: "tools.upsert", origin, tools, sessionId, seq: ++collectSeq }).then((res) => {
      log("registration", JSON.stringify({ origin, ok: res?.ok === true, accepted: res?.accepted ?? null }));
    }).catch((e) => {
      log("registration", JSON.stringify({ origin, ok: false, error: String(e?.message ?? e) }));
    });
  } else if (data.type === "result" && data.nonce === nonce) {
    const send = pending.get(data.requestId);
    if (send) {
      pending.delete(data.requestId);
      send(data.ok ? { ok: true, result: data.result } : { ok: false, error: data.error });
    }
  }
}
window.addEventListener("message", onWindowMessage);

function onRuntimeMessage(message, _sender, sendResponse) {
  if (message?.type === "enrollment-sync") {
    // The SW confirms the origin's CURRENT enrollment generation (sent on
    // enroll/re-enroll). MONOTONIC: a stale sync must never clear `disenrolled`
    // + resume MAIN after a newer Disable (the round-24 blocker).
    const err = applyEnrollmentSync(normalizeGen(message?.gen), "push");
    sendResponse(err ? { ok: false, error: err } : { ok: true });
    return true;
  }
  if (message?.type === "disenrollment") {
    // The origin was tombstoned/deleted: reject in-flight invokes at the bridge
    // (preemptive revocation) and signal MAIN to discard in-flight results.
    const err = applyDisenrollment(normalizeGen(message?.gen), "push");
    sendResponse(err ? { ok: false, error: err } : { ok: true });
    return true;
  }
  if (message?.type === "invoke-tool") {
    // ENROLLMENT-SCOPED cancellation (round-20 blocker): thread the generation
    // into the invoke and enforce it here. A MISSING/INVALID generation is
    // rejected UNCONDITIONALLY — including the first invoke (the round-27
    // blocker 3).
    if (disenrolled) {
      sendResponse({
        ok: false,
        error: "origin disenrolled — invocation rejected",
      });
      return true;
    }
    const gen = normalizeGen(message?.gen);
    if (gen == null) {
      sendResponse({
        ok: false,
        error: "missing enrollment generation — invocation rejected",
      });
      return true;
    }
    if (currentGen === null) {
      // Never synced yet — there is no valid generation authority to invoke
      // under. Reject (fail closed) rather than accepting an unscoped first call.
      sendResponse({
        ok: false,
        error: "origin not synced — invocation rejected",
      });
      return true;
    }
    if (gen !== currentGen) {
      sendResponse({
        ok: false,
        error: "enrollment generation mismatch — invocation rejected",
      });
      return true;
    }
    // The dispatch source MUST be present and valid (declared|inferred) —
    // without it the MAIN world would have no identity-safe way to resolve
    // the tool, so reject rather than falling back to a window-global lookup.
    if (!VALID_SOURCES.has(message?.source)) {
      sendResponse({
        ok: false,
        error: "missing/invalid tool source — invocation rejected",
      });
      return true;
    }
    ensureMainWorld();
    const requestId = String(++reqSeq);
    pending.set(requestId, sendResponse);
    log("invoke-tool", JSON.stringify({ origin: location.origin, name: message.name, requestId, gen, source: message.source }));
    window.postMessage({
      [CHANNEL]: true,
      type: "invoke",
      nonce,
      requestId,
      name: message.name,
      args: message.args,
      source: message.source,
      gen,
    }, "*");
    // Timeout so a hung page function doesn't leak the sendResponse.
    trackTimer(setTimeout(() => {
      if (pending.has(requestId)) {
        pending.delete(requestId);
        sendResponse({ ok: false, error: "invoke timed out" });
      }
    }, 15000));
    return true;
  }
  if (message?.type === "collect-tools") {
    ensureMainWorld();
    collectNow();
    sendResponse({ ok: true });
    return true;
  }
  return false;
}
chrome.runtime.onMessage.addListener(onRuntimeMessage);

// Kick off discovery once on load, then RE-POLL a few times for sites that
// register their WebMCP tools ASYNCHRONOUSLY (aifoc.us resolves dynamic packs
// after `load`, so a single collect can read `getTools()` before the tools are
// registered). Each re-collect is a complete, idempotent replacement snapshot,
// so a late registration is picked up without duplicating.
const timers = new Set();
function trackTimer(id) {
  timers.add(id);
  return id;
}
function collectNow() {
  window.postMessage({ [CHANNEL]: true, type: "collect", nonce, diagnostics }, "*");
}
ensureMainWorld();
syncEnrollmentAtStartup();
if (document.readyState === "complete") collectNow();
else window.addEventListener("load", collectNow);
// Re-poll at 800ms / 2s / 4s after load to catch async-registered tools.
for (const delay of [800, 2000, 4000]) {
  trackTimer(setTimeout(collectNow, delay));
}

// Register the versioned singleton so a re-injection tears THIS bridge down
// instead of stacking duplicate listeners (exactly one live bridge per tab).
const onLoadCollect = collectNow;
globalThis[BRIDGE_GUARD_KEY] = {
  version: BRIDGE_VERSION,
  teardown() {
    // Reject every pending invoke, remove both listeners, and clear the
    // re-poll timers so nothing from this instance can fire again.
    for (const [requestId, send] of pending) {
      pending.delete(requestId);
      try {
        send({ ok: false, error: "bridge replaced — invocation cancelled" });
      } catch { /* sendResponse already consumed */ }
    }
    for (const t of timers) clearTimeout(t);
    timers.clear();
    window.removeEventListener("message", onWindowMessage);
    window.removeEventListener("load", onLoadCollect);
    try { chrome.runtime.onMessage.removeListener(onRuntimeMessage); } catch { /* already detached */ }
  },
};
})();
