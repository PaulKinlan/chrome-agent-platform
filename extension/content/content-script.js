// content/content-script.js — the isolated-world relay between the MAIN-world
// bridge (content/main-world.js) and the extension background worker.
//
// The isolated world cannot see the page's globals, and the MAIN world cannot
// use chrome.* APIs — so this file relays across window.postMessage, a
// BROADCAST channel every page script can observe. Message authentication (the
// round-30 bridge-forgery blocker): the MAC key (nonce) is ISSUED BY THE
// SERVICE WORKER and reaches this bridge via the enrollment.status RESPONSE
// (an extension-private channel — a page script cannot call chrome.runtime)
// and the MAIN world via chrome.scripting.executeScript func ARGS. The nonce
// NEVER transits the broadcast channel; bridge messages carry only an
// HMAC-SHA256 tag + monotonic sequence (content/bridge-auth.js), so a page
// script that only observes/injects postMessage traffic cannot forge/replay the
// cross-world transport. This does NOT attest page-owned tools/results: MAIN
// shares the page realm and those values remain explicitly untrusted.
//   MAIN world → postMessage("tools", MAC'd) → here → chrome.runtime "tools.upsert"
//   background → "invoke-tool" → here → postMessage("invoke", MAC'd) → MAIN world
//             → call → postMessage("result", MAC'd) → here → sendResponse
//
// On EVERY startup (reload / cross-document navigation re-injects this script)
// the bridge pulls the CURRENT enrollment generation + the SW-issued MAC key +
// the navigation epoch from the service worker (`enrollment.status`) — a
// one-time enrollment push can never cover a document that did not exist yet,
// so without the startup pull a fresh bridge would reject every invoke forever
// (fail-closed without recovery).

// Versioned singleton guard (the repeated-enrollment finding): an immediate
// re-injection (re-enroll while the tab is open) re-executes this file in the
// SAME isolated world. Without a guard each execution would install ANOTHER
// pair of listeners, so one invoke would be forwarded once per stale listener
// (duplicate side effects). The previous execution is torn down before the new
// one installs, so exactly ONE live bridge exists per tab. The ENTIRE file is
// function-scoped: chrome.scripting.executeScript may execute it repeatedly in
// the same world, and top-level lexical `const` declarations would otherwise
// make the second injection fail before the teardown guard could run.
(() => {
const BRIDGE_VERSION = 3;
const BRIDGE_GUARD_KEY = "__capIsolatedBridge";
{
  const prev = globalThis[BRIDGE_GUARD_KEY];
  if (prev && typeof prev === "object" && typeof prev.teardown === "function") {
    try { prev.teardown(); } catch { /* a stale bridge must never block the new one */ }
  }
}

const CHANNEL = "__cap_bridge";
const TAG = "[WebMCP:bridge]";
const auth = globalThis.CapBridgeAuth; // injected before this file

// The SW-issued bridge MAC key + navigation epoch. Both arrive via the
// enrollment.status response; the nonce is NEVER posted over the broadcast
// channel (only HMAC tags keyed by it cross). null = unarmed: no message is
// forwarded in either direction (fail closed).
let bridgeNonce = null;
let bridgeEpoch = null; // echoed in every tools.upsert (the snapshot gate)
// Per-direction bridge sequences (replay suppression, reset when the key rotates).
let downSeq = 0; // isolated → MAIN
let upSeq = -1; // MAIN → isolated (last accepted)
// The discovery-snapshot sequence: monotonically increasing per tools report
// within this document (the SW orders complete replacement snapshots by it,
// scoped by the sender-derived tab/document + the echoed epoch).
let collectSeq = 0;

// Developer diagnostics (gated): mirrors the MAIN world's [WebMCP] logs from the
// isolated relay side. Off by default; the SW reports the owner's toggle via
// `webmcp.diagnostics.get` (see Settings → Site agents → Diagnostics) and the
// bootstrap delivers it to the MAIN world.
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

// Seal + post an isolated→MAIN control message. Returns false when the bridge
// is unarmed (no SW-issued key yet) — the message is simply not sent.
function sendDown(msg) {
  if (!bridgeNonce || !auth) return false;
  window.postMessage(
    { [CHANNEL]: true, ...auth.seal(bridgeNonce, "down", downSeq++, msg) },
    "*",
  );
  return true;
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
  // (Re-)enrollment clears the MAIN world's cancel state so NEW invokes are
  // allowed again; the MAIN world's immutable epoch fence keeps anything
  // cancelled before this resume permanently cancelled.
  sendDown({ type: "resume", diagnostics });
  return null;
}

function cancelToolInvocations(via) {
  // A consent reset/disable is a coarse per-origin cancellation fence. Reject
  // every isolated-world waiter now and advance MAIN's immutable cancel epoch;
  // new calls remain possible under whatever consent state the SW authorizes.
  log("tool-consent-revoked", JSON.stringify({ origin: location.origin, via }));
  for (const [requestId, send] of pending) {
    pending.delete(requestId);
    try {
      send({ ok: false, error: "site tool consent changed — invocation cancelled" });
    } catch { /* sendResponse already consumed */ }
  }
  sendDown({ type: "cancel-invocations" });
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
  sendDown({ type: "cancel" });
  return null;
}

// STARTUP SYNC (the reload/navigation fix): a freshly injected bridge has
// never seen the one-time enrollment push, so it pulls the CURRENT enrollment
// generation — and with it the SW-issued MAC key + navigation epoch — from the
// SW (sender-origin-derived server-side) and applies it through the same
// monotonic fence. Until this resolves, invokes + reports fail closed.
// Returns the promise so the initial discovery collect can be gated on it (the
// first tools.upsert must carry the epoch the SW just assigned).
function syncEnrollmentAtStartup() {
  return chrome.runtime.sendMessage({ type: "enrollment.status" }).then((res) => {
    if (!res || res.ok !== true) {
      log("enrollment-sync", JSON.stringify({ origin: location.origin, via: "startup", ok: false }));
      return; // fail closed — currentGen stays null
    }
    const gen = normalizeGen(res.gen);
    if (res.enrolled === true) {
      // Arm the bridge: the SW-issued MAC key + the navigation epoch for THIS
      // document (sender-derived server-side). A missing key (the bootstrap
      // executeScript failed) leaves the bridge unarmed — fail closed.
      if (typeof res.nonce === "string" && res.nonce.length >= 16) {
        if (bridgeNonce !== res.nonce) {
          bridgeNonce = res.nonce;
          downSeq = 0;
          upSeq = -1;
        }
      }
      bridgeEpoch = typeof res.epoch === "number" && Number.isInteger(res.epoch) ? res.epoch : null;
      applyEnrollmentSync(gen, "startup");
    } else {
      applyDisenrollment(gen, "startup");
    }
  }).catch(() => { /* SW not ready — fail closed */ });
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
  // MAC gate FIRST: an unkeyed / wrongly-keyed / replayed message (a page
  // script that eavesdropped the broadcast, or a torn-down stale MAIN world)
  // is dropped before any dispatch (the round-30 blocker).
  const opened = auth ? auth.open(bridgeNonce, "up", upSeq, data) : { ok: false };
  if (!opened.ok) return;
  upSeq = opened.seq;
  const msg = opened.msg;

  if (msg.type === "tools") {
    const tools = Array.isArray(msg.tools) ? msg.tools : [];
    const origin = location.origin; // never trust a message-supplied origin (cross-origin spoof)
    const declared = tools.filter((t) => t.source === "declared").length;
    const inferred = tools.filter((t) => t.source === "inferred").length;
    log("tools-reported", JSON.stringify({ origin, toolCount: tools.length, declaredCount: declared, inferredCount: inferred, toolNames: tools.map((t) => t.name) }));
    // A COMPLETE replacement snapshot — forwarded even when EMPTY, so a page
    // that removed all its tools gets them removed from the directory too.
    // The epoch is the SW-assigned navigation identity of THIS document; the
    // gate rejects a report whose (tab, document, epoch) is not current.
    // Includes pageUrl + title for page-scoped site identity (CAP-FB-20260824-WEBMCP-PAGE-IDENTITY-01).
    const pageUrl = location.href;
    const pageTitle = document.title;
    chrome.runtime.sendMessage({ type: "tools.upsert", origin, tools, pageUrl, title: pageTitle, epoch: bridgeEpoch, seq: ++collectSeq }).then((res) => {
      log("registration", JSON.stringify({ origin, ok: res?.ok === true, accepted: res?.accepted ?? null }));
    }).catch((e) => {
      log("registration", JSON.stringify({ origin, ok: false, error: String(e?.message ?? e) }));
    });
  } else if (msg.type === "result") {
    const send = pending.get(msg.requestId);
    if (send) {
      pending.delete(msg.requestId);
      // errorDetail is the honest page-side failure description
      // (chrome-agent-platform-ajcc). Realm + origin are STAMPED HERE — the
      // isolated world knows which document this bridge serves; a page
      // script's self-reported origin over the broadcast channel is never
      // trusted (the same rule as the tools snapshot above).
      let errorDetail = null;
      if (!msg.ok && msg.errorDetail && typeof msg.errorDetail === "object") {
        errorDetail = { ...msg.errorDetail, realm: "main", origin: location.origin };
      }
      send(msg.ok ? { ok: true, result: msg.result } : { ok: false, error: msg.error, errorDetail });
    }
  }
}
window.addEventListener("message", onWindowMessage);

function onRuntimeMessage(message, _sender, sendResponse) {
  if (message?.type === "enrollment.poke" || message?.type === "bridge.ping") {
    // The SW requests a bridge re-sync/poke (e.g. on invocation tab reuse/open).
    syncEnrollmentAtStartup().then(() => {
      sendResponse({ ok: true, epoch: bridgeEpoch, gen: currentGen });
    }).catch((err) => {
      sendResponse({ ok: false, error: String(err?.message ?? err) });
    });
    return true;
  }
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
  if (message?.type === "tool-consent-revoked") {
    cancelToolInvocations("push");
    sendResponse({ ok: true });
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
    if (!bridgeNonce) {
      // Unarmed (the SW bootstrap failed) — fail closed rather than posting an
      // unauthenticatable invoke.
      sendResponse({ ok: false, error: "bridge not armed — invocation rejected" });
      return true;
    }
    const requestId = String(++reqSeq);
    pending.set(requestId, sendResponse);
    log("invoke-tool", JSON.stringify({ origin: location.origin, name: message.name, requestId, gen, source: message.source }));
    sendDown({
      type: "invoke",
      requestId,
      name: message.name,
      args: message.args,
      source: message.source,
      gen,
    });
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
    collectNow();
    sendResponse({ ok: true });
    return true;
  }
  return false;
}
chrome.runtime.onMessage.addListener(onRuntimeMessage);

// Kick off discovery once the bridge is armed, then RE-POLL a few times for
// sites that register their WebMCP tools ASYNCHRONOUSLY (aifoc.us resolves
// dynamic packs after `load`, so a single collect can read `getTools()` before
// the tools are registered). Each re-collect is a complete, idempotent
// replacement snapshot, so a late registration is picked up without
// duplicating. Every collect is gated on the startup sync so the first report
// already carries the SW-issued MAC key + navigation epoch.
const timers = new Set();
function trackTimer(id) {
  timers.add(id);
  return id;
}
function collectNow() {
  sendDown({ type: "collect", diagnostics });
}
const startupSync = Promise.all([syncEnrollmentAtStartup(), refreshDiagnostics()]);
startupSync.then(() => {
  // The bridge's own start lifecycle event, logged only when the SW issued a
  // MAC key (an unarmed bridge is silent) and AFTER the diagnostics gate is
  // known (the acceptance observes this event).
  if (bridgeNonce) {
    log("start", JSON.stringify({ origin: location.origin, role: "isolated-bridge", diagnostics }));
  }
  collectNow(); // armed initial collect (the SW bootstrap also kicks one)
  for (const delay of [800, 2000, 4000]) {
    trackTimer(setTimeout(collectNow, delay));
  }
});

// Register the versioned singleton so a re-injection tears THIS bridge down
// instead of stacking duplicate listeners (exactly one live bridge per tab).
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
    bridgeNonce = null; // the MAC gate goes closed even if a stale closure fires
    window.removeEventListener("message", onWindowMessage);
    try { chrome.runtime.onMessage.removeListener(onRuntimeMessage); } catch { /* already detached */ }
  },
};
})();
