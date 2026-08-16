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

// A nonce the MAIN-world bridge must echo back, so a page script cannot spoof
// invoke results.
const nonce = crypto.randomUUID();
let initialized = false;

// The enrollment generation the service worker has told us is CURRENT for this
// origin. A delete/disenroll tombstones + bumps the generation in the worker, so
// threading it into invoke-tool + enforcing it here lets a stale in-flight
// invocation be REJECTED at this bridge boundary (preemptive revocation: a
// deleted origin's page function must not run).
let currentGen = null; // null = never synced yet (first invoke accepts + records)
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

// Whether ANY generation-aware lifecycle state has been seen (a sync or
// disenrollment with a numeric generation, or a disenrollment). Once
// initialized, a lifecycle message with an ABSENT/invalid generation must FAIL
// CLOSED — a malformed/legacy message must never re-authorize a tombstoned
// bridge (the round-26 blocker: a missing-gen sync after a tombstone resumed
// MAIN and reached the page).
function lifecycleInitialized() {
  return maxGen !== -Infinity || currentGen !== null || disenrolled;
}

function ensureMainWorld() {
  if (initialized) return;
  initialized = true;
  // Pass the nonce to the MAIN world over the same postMessage channel.
  window.postMessage({ [CHANNEL]: true, type: "init", nonce }, "*");
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
    if (tools.length) {
      chrome.runtime.sendMessage({ type: "tools.upsert", origin, tools }).catch(() => {});
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
      // Missing/invalid generation must FAIL CLOSED once lifecycle state is
      // initialized — never resume a tombstoned bridge from a gen-less sync (the
      // round-26 blocker). Only the FIRST-ever lifecycle message may carry no
      // generation (legacy/initial state).
      if (lifecycleInitialized()) {
        sendResponse({ ok: false, error: "missing enrollment generation — sync rejected" });
        return true;
      }
    } else {
      if (gen < maxGen) {
        sendResponse({ ok: false, error: "stale enrollment-sync rejected" });
        return true;
      }
      maxGen = Math.max(maxGen, gen);
    }
    currentGen = gen;
    disenrolled = false;
    // Re-enrollment clears the MAIN world's cancel epoch so NEW invokes are
    // allowed again (a delete→re-enroll must not leave the page bridge
    // permanently cancelled — the round-23 blocker 1 fix).
    window.postMessage({ [CHANNEL]: true, type: "resume", nonce }, "*");
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
    if (gen == null) {
      // Missing/invalid generation must FAIL CLOSED once lifecycle state is
      // initialized (the round-26 blocker — strict monotonic state applies to
      // disenrollment too; a gen-less tombstone is malformed).
      if (lifecycleInitialized()) {
        sendResponse({ ok: false, error: "missing disenrollment generation — rejected" });
        return true;
      }
    } else {
      if (gen < maxGen) {
        sendResponse({ ok: false, error: "stale disenrollment rejected" });
        return true;
      }
      maxGen = Math.max(maxGen, gen);
    }
    disenrolled = true;
    currentGen = null;
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
    // into the invoke and enforce it here. If the origin was disenrolled OR the
    // message carries a stale generation (mismatches a newer synced gen), reject
    // WITHOUT forwarding to the MAIN world. A first invoke (never synced, not
    // disenrolled) accepts + records the gen.
    if (disenrolled) {
      sendResponse({
        ok: false,
        error: "origin disenrolled — invocation rejected",
      });
      return true;
    }
    if (typeof message.gen === "number") {
      if (currentGen === null) {
        currentGen = message.gen; // first sync — accept + record
      } else if (message.gen !== currentGen) {
        sendResponse({
          ok: false,
          error: "enrollment generation mismatch — invocation rejected",
        });
        return true;
      }
    } else if (currentGen !== null) {
      // A synced origin received an invoke WITHOUT a generation: reject
      // (fail closed) rather than run a page function unvalidated.
      sendResponse({
        ok: false,
        error: "missing enrollment generation — invocation rejected",
      });
      return true;
    }
    ensureMainWorld();
    const requestId = String(++reqSeq);
    pending.set(requestId, sendResponse);
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
    window.postMessage({ [CHANNEL]: true, type: "collect", nonce }, "*");
    sendResponse({ ok: true });
    return true;
  }
  return false;
});

// Kick off discovery once on load.
ensureMainWorld();
if (document.readyState === "complete") window.postMessage({ [CHANNEL]: true, type: "collect", nonce }, "*");
else window.addEventListener("load", () => window.postMessage({ [CHANNEL]: true, type: "collect", nonce }, "*"));
