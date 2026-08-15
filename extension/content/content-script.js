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
    const origin = data.origin || location.origin;
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
  if (message?.type === "invoke-tool") {
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
