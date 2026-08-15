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
    currentGen = typeof message.gen === "number" ? message.gen : null;
    disenrolled = false;
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
    // result is never surfaced).
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
