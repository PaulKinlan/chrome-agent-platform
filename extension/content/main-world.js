// content/main-world.js — runs in the PAGE's world (world: "MAIN"), so it can
// see the page's own globals + document.modelContext (WebMCP). It cannot use
// chrome.* APIs, so it talks to the isolated-world content script over a
// window.postMessage channel authenticated with a nonce.
//
// Discovery: reads window.* (non-DOM-owned functions) + document.modelContext
// tools, and posts them up. Invocation: on an authenticated "cairn-invoke"
// message, calls the page function / WebMCP tool and posts the result back.

(() => {
  const CHANNEL = "__cairn_bridge";
  let nonce = null;

  // In-flight invocations (requestId) + the set the bridge has CANCELLED. The
  // MAIN world is the PAGE's world (untrusted) — the isolated content script is
  // the trust boundary that validates enrollment generation before forwarding
  // an invoke. This module's cancellation state is cooperative: when the bridge
  // signals `cancel` (a disenrollment), every in-flight invoke's RESULT is
  // discarded (never posted back) so a deleted origin's page function cannot
  // surface its result — the round-21 blocker where the MAIN world ignored the
  // generation entirely and kept reporting results after a delete.
  const inFlight = new Set();
  // Cancelled invocation tombstones, BOUNDED (the round-27 blocker 5): the old
  // code used an unbounded `cancelled` Set — a never-settling page function's id
  // stayed resident forever, and repeated cancels grew the set without limit
  // (violating bounded-memory). A Map<id, timestamp> supports a hard cap with
  // oldest-first eviction (Set insertion order is not exposed) AND a TTL sweep so
  // a cancel tombstones a result long enough to cover the content-script's 15s
  // timeout + this world's 20s in-flight timeout, then forgets it.
  const cancelled = new Map();
  // Hard cap on the tombstone map (a single page cannot accumulate unbounded
  // never-settling cancellation tombstones).
  const CANCELLED_MAX = 512;
  // A cancelled id suppresses a late result for at most this long (well beyond the
  // 15s content-script timeout and the 20s in-flight timeout).
  const CANCELLED_TTL_MS = 60 * 1000;
  function markCancelled(id) {
    cancelled.set(id, Date.now());
    if (cancelled.size > CANCELLED_MAX) {
      // Evict the OLDEST tombstone (Map preserves insertion order) so the map
      // stays bounded even under a flood of never-settling cancellations.
      const oldest = cancelled.keys().next().value;
      cancelled.delete(oldest);
    }
  }
  function isCancelled(id) {
    const at = cancelled.get(id);
    if (at === undefined) return false;
    if (Date.now() - at > CANCELLED_TTL_MS) {
      cancelled.delete(id); // expired tombstone — no longer suppress
      return false;
    }
    return true;
  }
  // A cancellation EPOCH flag (round-23 blocker 1): `cancelled` only marks IDs
  // that were already in `inFlight` at cancel time, so a cancel that arrived
  // BEFORE a new invoke could not mark that future ID (it was not yet in
  // `inFlight`), and a cancel that arrived AFTER could not interleave because
  // the invoke handler called invoke() synchronously. `cancelledAll` is set on
  // EVERY cancel and blocks any NEW invoke until the bridge re-signals a
  // re-enrollment (`resume`/`init`).
  let cancelledAll = false;

  function isDomOwned(name) {
    const platform = new Set([
      "window", "self", "document", "location", "navigator", "history", "screen",
      "parent", "top", "frames", "opener", "fetch", "crypto", "indexedDB",
      "localStorage", "sessionStorage", "caches", "console", "alert", "confirm",
      "prompt", "open", "close", "focus", "blur", "scroll", "scrollTo", "scrollBy",
      "resizeTo", "resizeBy", "moveTo", "moveBy", "print", "stop", "postMessage",
      "requestAnimationFrame", "cancelAnimationFrame", "requestIdleCallback",
      "cancelIdleCallback", "setTimeout", "setInterval", "clearTimeout", "clearInterval",
      "getComputedStyle", "matchMedia", "getSelection", "atob", "btoa",
      "queueMicrotask", "structuredClone", "reportError", "addEventListener",
      "removeEventListener", "dispatchEvent", "customElements", "trustedTypes",
      "Image", "Option", "WebAssembly", "WebSocket", "Worker", "EventSource",
      "XMLHttpRequest", "URL", "URLSearchParams", "DOMParser", "Blob", "File",
      "FileReader", "FormData", "Response", "Request", "Headers", "Promise",
      "Symbol", "Reflect", "Proxy", "JSON", "Math", "Date", "RegExp", "Error",
      "TypeError", "RangeError", "SyntaxError", "Map", "Set", "WeakMap", "WeakSet",
      "Array", "Object", "String", "Number", "Boolean", "BigInt", "Intl",
      "chrome", "webkitRequestAnimationFrame", "webkitCancelAnimationFrame",
      "captureEvents", "releaseEvents", "showModalDialog", "webpackChunk",
      "__REACT_DEVTOOLS_GLOBAL_HOOK__", "__VUE__", "__NUXT__",
      // Web platform globals (not page-defined): imaging, picking, fonts,
      // filesystem, scheduling, navigation, storage, media, crypto, workers.
      "createImageBitmap", "find", "fetchLater", "getScreenDetails",
      "queryLocalFonts", "showDirectoryPicker", "showOpenFilePicker",
      "showSaveFilePicker", "webkitRequestFileSystem", "webkitResolveLocalFileSystemURL",
      "requestVideoFrameCallback", "webkitRequestVideoFrameCallback",
      "reportError", "scheduler", "navigation", "launchQueue", "documentPictureInPicture",
      "trustedTypes", "cookieStore", "credentialless", "fence", "sharedStorage",
      "attributionReporting", "interestCohort", "browsingTopics", "privateStateToken",
      "EyeDropper", "PresentationRequest", "BackgroundFetchManager", "Bluetooth",
      "HID", "USB", "NDEFReader", "Serial", "NFCReader", "XRSystem",
      "MediaStreamTrackProcessor", "MediaStreamTrackGenerator", "AudioData",
      "VideoFrame", "EncodedAudioChunk", "EncodedVideoChunk", "ImageDecoder",
      "VideoDecoder", "AudioDecoder", "VideoEncoder", "AudioEncoder",
      "CompressionStream", "DecompressionStream", "BroadcastChannel",
      "MessageChannel", "MessagePort", "TextEncoder", "TextDecoder",
      "TextDecoderStream", "TextEncoderStream", "ReadableStream", "WritableStream",
      "TransformStream", "ByteLengthQueuingStrategy", "CountQueuingStrategy",
      "Cache", "CacheStorage", "ServiceWorker", "ServiceWorkerRegistration",
      "SharedWorker", "Worklet", "AudioWorklet", "AnimationWorklet", "PaintWorklet",
      "Performance", "PerformanceObserver", "PerformanceEntry", "CryptoKey",
      "SubtleCrypto", "CredentialsContainer", "PermissionStatus", "Permissions",
      "StorageManager", "Storage", "Geolocation", "GeolocationPosition",
      "MediaQueryList", "MediaQueryListEvent", "ResizeObserver", "IntersectionObserver",
      "MutationObserver", "PerformanceObserverEntryList", "Node", "Element",
      "HTMLElement", "Event", "EventTarget", "Document", "Window",
      "IDBFactory", "IDBDatabase", "IDBObjectStore", "IDBIndex", "IDBRequest",
    ]);
    return platform.has(name);
  }

  function paramNames(fn) {
    try {
      const src = Function.prototype.toString.call(fn);
      const m = src.match(/^(?:async\s+)?(?:function\s*[^(]*)?\(([^)]*)\)/);
      if (!m) return [];
      return m[1].split(",").map((p) => p.trim()).filter((p) => p && !p.includes("=")).map((p) => p.replace(/\/\*.*?\*\//g, "").trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  function inferTools() {
    const out = [];
    for (const key of Object.keys(window)) {
      if (isDomOwned(key)) continue;
      try {
        const val = window[key];
        if (typeof val !== "function") continue;
        const params = paramNames(val);
        out.push({
          name: key,
          source: "inferred",
          description: `Inferred global function ${key}`,
          inputSchema: {
            type: "object",
            properties: Object.fromEntries(params.map((p) => [p, { type: "string" }])),
            required: [],
          },
          args: params,
        });
      } catch { /* not callable */ }
    }
    return out.slice(0, 200);
  }

  function declaredTools() {
    const mc = document.modelContext;
    const tools = mc?.tools ?? (typeof mc?.getTools === "function" ? mc.getTools() : null);
    const out = [];
    if (tools instanceof Map) {
      for (const [name, t] of tools) {
        out.push({ name, source: "declared", description: t.description ?? "", inputSchema: t.inputSchema ?? { type: "object", properties: {} } });
      }
    } else if (Array.isArray(tools)) {
      for (const t of tools) out.push({ name: t.name, source: "declared", description: t.description ?? "", inputSchema: t.inputSchema ?? {} });
    }
    return out;
  }

  function collectTools() {
    const declared = declaredTools();
    const inferred = declared.length ? [] : inferTools();
    return [...declared, ...inferred];
  }

  function post(msg) {
    window.postMessage({ [CHANNEL]: true, ...msg }, "*");
  }

  async function invoke(requestId, name, args) {
    // PRE-START cancellation check (the round-22 blocker: cancel only discarded
    // the RESULT, so a page function whose side effect had already executed kept
    // running). This synchronous check runs BEFORE the page function is invoked,
    // so a request that was already marked cancelled (or arrived after a cancel
    // epoch — round-23 blocker 1) never STARTS its side effect. It is
    // cooperative: once a page function has begun, its own DOM / storage /
    // network effects cannot be unwound — the result is discarded and the
    // invocation is marked cancelled, but the in-flight function itself runs
    // to settlement. That limit is documented (not papered over) below.
    if (cancelledAll || isCancelled(requestId)) {
      throw new Error("invocation cancelled");
    }
    // 1. a page-defined global function
    const fn = window[name];
    if (typeof fn === "function") {
      const params = paramNames(fn);
      const ordered = params.map((p) => args?.[p]);
      // Re-check IMMEDIATELY before the actual function call — the `paramNames`
      // reflection above is synchronous but the check must sit as close to the
      // side effect as possible so a cancel that landed in the same synchronous
      // turn (via the cancel EPOCH) is still honored right up to the call edge.
      // This is the MINIMUM window; once fn.apply runs, its effects are
      // unwindable (cooperative cancellation can only discard the result).
      if (cancelledAll || isCancelled(requestId)) {
        throw new Error("invocation cancelled");
      }
      return await fn.apply(window, ordered);
    }
    // 2. a WebMCP registered tool
    const mc = document.modelContext;
    if (typeof mc?.callTool === "function") {
      if (cancelledAll || isCancelled(requestId)) {
        throw new Error("invocation cancelled");
      }
      return await mc.callTool(name, args ?? {});
    }
    if (typeof mc?.invoke === "function") {
      if (cancelledAll || isCancelled(requestId)) {
        throw new Error("invocation cancelled");
      }
      return await mc.invoke(name, args ?? {});
    }
    throw new Error(`no such function/tool: ${name}`);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return; // only same-window messages
    const data = event.data;
    if (!data || typeof data !== "object" || data[CHANNEL] !== true) return;
    if (data.type === "init") {
      nonce = data.nonce;
      cancelledAll = false; // a fresh bridge/nonce resets the cancel epoch
      post({ type: "tools", origin: location.origin, tools: collectTools() });
    } else if (data.type === "collect") {
      post({ type: "tools", origin: location.origin, tools: collectTools() });
    } else if (data.type === "resume") {
      // Re-enrollment: clear the cancel epoch so NEW invokes are allowed again.
      // In-flight ids cancelled by the prior disenrollment stay cancelled (their
      // results remain discarded) — only the epoch is cleared.
      cancelledAll = false;
    } else if (data.type === "cancel") {
      // Disenrollment cancellation: (1) set the cancel EPOCH so any NEW invoke
      // is rejected before it starts (round-23 blocker 1: a cancel that arrived
      // before a future invoke could not mark that future ID), and (2) mark every
      // currently in-flight invoke as cancelled so its result is discarded.
      cancelledAll = true;
      for (const id of inFlight) markCancelled(id);
    } else if (data.type === "invoke" && data.nonce === nonce) {
      inFlight.add(data.requestId);
      // Bound the in-flight set: a hung page function must not leave its request
      // id resident forever (the content-script drops the response at 15s, but
      // this world's promise could otherwise linger).
      setTimeout(() => { inFlight.delete(data.requestId); }, 20000);
      // Defer the page-function invocation by ONE macrotask so a `cancel`
      // delivered in the same turn (a disenrollment that raced this invoke)
      // can run FIRST and mark the request cancelled BEFORE the page function
      // starts (the round-23 blocker: invoking synchronously meant a later
      // cancel could never interleave between inFlight.add and the call).
      setTimeout(() => {
        if (cancelledAll || isCancelled(data.requestId)) {
          inFlight.delete(data.requestId);
          post({ type: "result", nonce, requestId: data.requestId, ok: false, error: "invocation cancelled" });
          return;
        }
        invoke(data.requestId, data.name, data.args)
          .then((result) => {
            inFlight.delete(data.requestId);
            if (isCancelled(data.requestId)) {
              cancelled.delete(data.requestId);
              post({ type: "result", nonce, requestId: data.requestId, ok: false, error: "invocation cancelled" });
              return;
            }
            post({ type: "result", nonce, requestId: data.requestId, ok: true, result });
          })
          .catch((e) => {
            inFlight.delete(data.requestId);
            cancelled.delete(data.requestId);
            post({ type: "result", nonce, requestId: data.requestId, ok: false, error: String(e?.message ?? e) });
          });
      }, 0);
    }
  });

  // First pass after the page settles.
  if (document.readyState === "complete") setTimeout(() => post({ type: "tools", origin: location.origin, tools: collectTools() }), 300);
  else window.addEventListener("load", () => setTimeout(() => post({ type: "tools", origin: location.origin, tools: collectTools() }), 300));
})();
