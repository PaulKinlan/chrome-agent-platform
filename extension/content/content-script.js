// content/content-script.js — the isolated-world relay between the MAIN-world
// bridge (content/main-world.js) and the extension background worker.
//
// The isolated world cannot see the page's globals, and the MAIN world cannot
// use chrome.* APIs — so this file relays across a nonce-authenticated
// window.postMessage channel:
//   MAIN world → postMessage("tools") → here → chrome.runtime "tools.upsert"
//   background → "invoke-tool" → here → postMessage("invoke") → MAIN world → call
//             → postMessage("result") → here → sendResponse

const CHANNEL = "__cairn_bridge";
const TAG = "[WebMCP:bridge]";

// A nonce the MAIN-world bridge must echo back, so a page script cannot spoof
// invoke results.
const nonce = crypto.randomUUID();
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
// round-24 stale-lifecycle-ordering blocker: a Disable could send `disenrollment`
// first and an older in-flight `enrollment-sync` would land later and re-authorize
// the bridge with a stale generation).
let maxGen = -Infinity;

// Normalize a lifecycle message's generation: a finite non-negative integer,
// else null (missing/invalid). Non-finite (NaN/±Infinity), fractional, and
// negative generations are malformed and must never be trusted for monotonic
// ordering (the round-26 missing-gen blocker).
function normalizeGen(message) {
  const g = message?.gen;
  return typeof g === "number" && Number.isFinite(g) && Number.isInteger(g) && g >= 0
    ? g
    : null;
}

// A monotonic fence for lifecycle messages. Missing/invalid generations are now
// rejected UNCONDITIONALLY (the round-27 blocker 3) — the SW always produces
// numeric generations, so there is no valid legacy unscoped-first-message path.

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

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || typeof data !== "object" || data[CHANNEL] !== true) return;

  if (data.type === "tools") {
    const tools = Array.isArray(data.tools) ? data.tools : [];
    const origin = location.origin; // never trust a message-supplied origin (cross-origin spoof)
    const declared = tools.filter((t) => t.source === "declared").length;
    const inferred = tools.filter((t) => t.source === "inferred").length;
    log("tools-reported", JSON.stringify({ origin, toolCount: tools.length, declaredCount: declared, inferredCount: inferred, toolNames: tools.map((t) => t.name) }));
    if (tools.length) {
      chrome.runtime.sendMessage({ type: "tools.upsert", origin, tools }).then((res) => {
        log("registration", JSON.stringify({ origin, ok: res?.ok === true, result: res }));
      }).catch((e) => {
        log("registration", JSON.stringify({ origin, ok: false, error: String(e?.message ?? e) }));
      });
    }
  } else if (data.type === "result" && data.nonce === nonce) {
    const send = pending.get(data.requestId);
    if (send) {
      pending.delete(data.requestId);
      send(data.ok ? { ok: true, result: data.result } : { ok: false, error: data.error });
    }
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "enrollment-sync") {
    // The SW confirms the origin's CURRENT enrollment generation (sent on
    // enroll/re-enroll). Record it so a stale-generation invoke can be rejected.
    // MONOTONIC: reject a sync whose generation is OLDER than a disenrollment we
    // already applied — a stale sync must never clear `disenrolled` + resume MAIN
    // after a newer Disable (the round-24 stale-lifecycle-ordering blocker).
    const gen = normalizeGen(message);
    if (gen == null) {
      // Missing/invalid generation must FAIL CLOSED ALWAYS — including the FIRST
      // message (the round-27 blocker 3: the old code exempted the first-ever
      // lifecycle message, so a generationless `enrollment-sync` resumed a fresh
      // bridge and a generationless invoke then reached MAIN). The SW ALWAYS
      // produces numeric generations, so there is no valid legacy reason to
      // authorize an unscoped first message.
      sendResponse({ ok: false, error: "missing enrollment generation — sync rejected" });
      return true;
    }
    if (gen < maxGen) {
      sendResponse({ ok: false, error: "stale enrollment-sync rejected" });
      return true;
    }
    maxGen = Math.max(maxGen, gen);
    currentGen = gen;
    disenrolled = false;
    log("enrollment-sync", JSON.stringify({ origin: location.origin, gen }));
    // Re-enrollment clears the MAIN world's cancel epoch so NEW invokes are
    // allowed again (a delete→re-enroll must not leave the page bridge
    // permanently cancelled — the round-23 blocker 1 fix).
    window.postMessage({ [CHANNEL]: true, type: "resume", nonce, diagnostics }, "*");
    sendResponse({ ok: true });
    return true;
  }
  if (message?.type === "disenrollment") {
    // The origin was tombstoned/deleted. From this instant a stale in-flight
    // invoke (holding the old generation) is rejected before reaching the MAIN
    // world — preemptive revocation. This is COOPERATIVE CANCELLATION, not just
    // a flag flip (the round-21 blocker): (1) every ALREADY-FORWARDED invoke's
    // sendResponse is rejected so its result is never reported to the SW, and
    // (2) the MAIN world is signalled to DISCARD any in-flight page function's
    // result (the page function's own side effect cannot be unwound, but its
    // result is never surfaced). The disenrollment's generation is recorded
    // monotonically so a later stale sync cannot resurrect the bridge (round-24).
    const gen = normalizeGen(message);
    // MONOTONIC in BOTH directions (the round-25 blocker 8): reject a STALE
    // disenrollment (older gen than a sync we already applied) — the old code
    // unconditionally set `disenrolled = true`, so an older tombstone could cancel
    // a NEWER enrollment. Only the LATEST generation wins, for sync AND disenroll.
    // Missing/invalid generation FAILS CLOSED ALWAYS, including the first message
    // (the round-27 blocker 3).
    if (gen == null) {
      sendResponse({ ok: false, error: "missing disenrollment generation — rejected" });
      return true;
    }
    if (gen < maxGen) {
      sendResponse({ ok: false, error: "stale disenrollment rejected" });
      return true;
    }
    maxGen = Math.max(maxGen, gen);
    disenrolled = true;
    currentGen = null;
    log("disenrollment", JSON.stringify({ origin: location.origin, gen }));
    for (const [requestId, send] of pending) {
      pending.delete(requestId);
      try {
        send({ ok: false, error: "origin disenrolled — invocation cancelled" });
      } catch { /* sendResponse already consumed */ }
    }
    window.postMessage({ [CHANNEL]: true, type: "cancel", nonce }, "*");
    sendResponse({ ok: true });
    return true;
  }
  if (message?.type === "invoke-tool") {
    // ENROLLMENT-SCOPED cancellation (round-20 blocker): thread the generation
    // into the invoke and enforce it here. A MISSING/INVALID generation is
    // rejected UNCONDITIONALLY — including the first invoke (the round-27
    // blocker 3: the old code accepted a generationless first invoke while
    // `currentGen === null`, authorizing an unscoped page call before any sync).
    if (disenrolled) {
      sendResponse({
        ok: false,
        error: "origin disenrolled — invocation rejected",
      });
      return true;
    }
    const gen = normalizeGen(message);
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
    ensureMainWorld();
    const requestId = String(++reqSeq);
    pending.set(requestId, sendResponse);
    log("invoke-tool", JSON.stringify({ origin: location.origin, name: message.name, requestId, gen: message.gen }));
    window.postMessage({
      [CHANNEL]: true,
      type: "invoke",
      nonce,
      requestId,
      name: message.name,
      args: message.args,
      gen: message.gen,
    }, "*");
    // Timeout so a hung page function doesn't leak the sendResponse.
    setTimeout(() => {
      if (pending.has(requestId)) {
        pending.delete(requestId);
        sendResponse({ ok: false, error: "invoke timed out" });
      }
    }, 15000);
    return true;
  }
  if (message?.type === "collect-tools") {
    ensureMainWorld();
    collectNow();
    sendResponse({ ok: true });
    return true;
  }
  return false;
});

// Kick off discovery once on load, then RE-POLL a few times for sites that
// register their WebMCP tools ASYNCHRONOUSLY (aifoc.us resolves dynamic packs
// after `load`, so a single collect can read `getTools()` before the tools are
// registered). Each re-collect is idempotent (the SW upsert replaces the origin's
// tool set), so a late registration is picked up without duplicating.
function collectNow() {
  window.postMessage({ [CHANNEL]: true, type: "collect", nonce, diagnostics }, "*");
}
ensureMainWorld();
if (document.readyState === "complete") collectNow();
else window.addEventListener("load", collectNow);
// Re-poll at 800ms / 2s / 4s after load to catch async-registered tools.
for (const delay of [800, 2000, 4000]) {
  setTimeout(collectNow, delay);
}
