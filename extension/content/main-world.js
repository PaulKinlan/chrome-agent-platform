// content/main-world.js — runs in the PAGE's world (world: "MAIN"), so it can
// see the page's own exposed functions + document.modelContext (WebMCP). It
// cannot use chrome.* APIs, so it talks to the isolated-world content script
// over a window.postMessage channel authenticated with a nonce.
//
// Discovery: reads the page's POSITIVE opt-in exposure (window.webmcpExpose) +
// document.modelContext tools, and posts them up. Blind window.* enumeration is
// GONE (the round-28 review: enumerating every enumerable global function was
// an unsafe eligibility policy). Invocation: on an authenticated "cairn-invoke"
// message, dispatches BY SOURCE — a declared WebMCP tool is only ever resolved
// through document.modelContext, an inferred tool only through the captured
// exposure registry (never window[name], so a global cannot hijack a declared
// tool name).

// Versioned singleton guard (the repeated-enrollment finding): an immediate
// re-injection (re-enroll while the tab is open) re-executes this file in the
// SAME page world. Without a guard every execution would install ANOTHER
// message listener, so one invoke would run the page function once per stale
// listener (duplicate side effects). The previous execution is torn down
// (listeners removed, timers cleared, in-flight results suppressed) before the
// new one installs, so exactly ONE live MAIN-world bridge exists per tab.
const MAIN_WORLD_VERSION = 2;
const GUARD_KEY = "__cairnMainWorldBridge";
{
  const prev = window[GUARD_KEY];
  if (prev && typeof prev === "object" && typeof prev.teardown === "function") {
    try { prev.teardown(); } catch { /* a stale world must never block the new one */ }
  }
}

(() => {
  const CHANNEL = "__cairn_bridge";
  const TAG = "[WebMCP:main]";
  let nonce = null;
  // Developer diagnostics (gated): when the isolated bridge signals
  // `diagnostics: true`, emit structured [WebMCP] logs so the discovery
  // pipeline is observable in the page DevTools console. Off by default (no
  // console noise); enabled from Settings → Site agents → Diagnostics.
  let diagnostics = false;
  function log(...args) {
    if (!diagnostics) return;
    try { console.log(TAG, ...args); } catch { /* never throw from a logger */ }
  }

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

  // A tool name must be a plain dotted identifier (no prototype-chain tricks,
  // no whitespace/control bytes, bounded length).
  const TOOL_NAME_RE = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;
  function validToolName(name) {
    return typeof name === "string" && name.length > 0 && name.length <= 128 && TOOL_NAME_RE.test(name);
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

  // ── Inferred tools: conservative POSITIVE opt-in ─────────────────────────
  // A page exposes callable functions by assigning an array of functions (or
  // { name?, description?, fn } descriptors) to `window.webmcpExpose`. Anything
  // NOT explicitly listed is never inferred — the old blind window.* function
  // enumeration is removed (it violated conservative eligibility: every
  // enumerable global function became a tool). The captured registry preserves
  // descriptor IDENTITY: invocation calls the captured function reference, so
  // reassigning a global after discovery cannot hijack an approved tool.
  const EXPOSE_KEY = "webmcpExpose";
  const MAX_EXPOSED = 100;
  // name → { fn, description } captured at the last collect.
  let exposedRegistry = new Map();
  function captureExposed() {
    const out = new Map();
    const raw = window[EXPOSE_KEY];
    if (!Array.isArray(raw)) {
      exposedRegistry = out;
      return out;
    }
    for (const entry of raw) {
      let fn = null;
      let name = null;
      let description = "";
      if (typeof entry === "function") {
        fn = entry;
        name = entry.name;
      } else if (entry && typeof entry === "object" && typeof entry.fn === "function") {
        fn = entry.fn;
        name = typeof entry.name === "string" && entry.name ? entry.name : entry.fn.name;
        description = typeof entry.description === "string" ? entry.description : "";
      }
      if (!fn || !validToolName(name)) continue;
      if (isDomOwned(name)) continue; // defense-in-depth: never re-expose a platform global
      if (out.has(name)) continue; // first exposure wins
      out.set(name, { fn, description });
      if (out.size >= MAX_EXPOSED) break;
    }
    exposedRegistry = out;
    return out;
  }

  function inferTools() {
    const out = [];
    for (const [name, { fn, description }] of exposedRegistry) {
      const params = paramNames(fn);
      out.push({
        name,
        source: "inferred",
        description: description || `Exposed page function ${name}`,
        inputSchema: {
          type: "object",
          properties: Object.fromEntries(params.map((p) => [p, { type: "string" }])),
          required: [],
        },
      });
    }
    return out;
  }

  // The WebMCP API (GoogleChromeLabs/webmcp-tools): tools are read via
  // document.modelContext.getTools(), which is ASYNC and returns an ARRAY of
  // tool objects whose `inputSchema` is a STRINGIFIED JSON (not an object).
  // `mc.tools` may exist as a ReadonlyMap on the native (non-polyfilled)
  // implementation.
  //
  // Schema validation is STRICT: a malformed schema (unparseable string,
  // non-object, array, or a non-object `type`) REJECTS the descriptor — the
  // old code converted garbage into a permissive empty schema, silently
  // accepting malformed tools.
  function parseInputSchema(schema) {
    if (schema == null) return { type: "object", properties: {} };
    let s = schema;
    if (typeof s === "string") {
      if (s.length > 16384) return null;
      try {
        s = JSON.parse(s);
      } catch {
        return null; // malformed string schema — reject the descriptor
      }
    }
    if (!s || typeof s !== "object" || Array.isArray(s)) return null;
    if (s.type !== undefined && s.type !== "object") return null;
    return s;
  }

  // The RAW tools (with their execute fn + window), un-normalized — used for both
  // discovery (declaredTools) and invocation (executeTool needs the raw object).
  // The native WebMCP API's getTools() returns a ReadonlyMap, which may NOT pass
  // `instanceof Map` (it is a WebIDL ReadonlyMap, and cross-realm wrappers fail
  // the check), so duck-type any Map-LIKE result (has .values()/.entries()/.get()).
  function isMapLike(v) {
    return !!v && typeof v === "object" && typeof v.values === "function" && typeof v.entries === "function" && typeof v.get === "function";
  }
  async function getRawTools() {
    const mc = document.modelContext;
    if (!mc) return [];
    if (typeof mc.getTools === "function") {
      const got = await mc.getTools().catch(() => null);
      if (Array.isArray(got)) return got;
      if (isMapLike(got)) return [...got.values()];
      // Some implementations return an object keyed by tool name.
      if (got && typeof got === "object") return Object.values(got);
    }
    if (isMapLike(mc.tools)) return [...mc.tools.values()];
    if (Array.isArray(mc.tools)) return mc.tools;
    return [];
  }

  async function declaredTools() {
    const raw = await getRawTools();
    const out = [];
    for (const t of raw) {
      if (!t || !validToolName(t.name)) continue; // malformed descriptor — reject
      const schema = parseInputSchema(t.inputSchema);
      if (schema === null) continue; // malformed schema — reject the descriptor
      out.push({
        name: t.name,
        source: "declared",
        description: typeof t.description === "string" ? t.description : "",
        inputSchema: schema,
      });
    }
    return out;
  }

  async function collectTools() {
    const declared = await declaredTools();
    // Include BOTH the declared WebMCP tools AND the positively-exposed page
    // functions. Dedupe by name (a DECLARED tool wins a collision) + cap.
    captureExposed();
    const declaredNames = new Set(declared.map((t) => t.name));
    const inferred = inferTools().filter((t) => !declaredNames.has(t.name));
    return [...declared, ...inferred].slice(0, 200);
  }

  function post(msg) {
    // Every message carries the bridge-issued nonce once known (the isolated
    // bridge drops nonce-less reports, so a page script / a stale MAIN world
    // cannot spoof a tools report or a result). Before the init handshake
    // there is nothing trusted to say — stay silent.
    if (!nonce) return;
    window.postMessage({ [CHANNEL]: true, nonce, ...msg }, "*");
  }

  // Page-thrown exception text is attacker-controlled and may embed secrets —
  // never surface it to the bridge/SW/model. Report only a bounded, allowlisted
  // error NAME (the full text stays in the page's own console via the gated log,
  // where the page already had it).
  const SAFE_ERROR_NAMES = new Set([
    "Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError",
    "EvalError", "URIError", "AggregateError", "DOMException",
  ]);
  function redactError(e) {
    const name = e && typeof e === "object" ? e.constructor?.name : null;
    return SAFE_ERROR_NAMES.has(name) ? name : "Error";
  }
  // Errors WE throw (cancellation, dispatch, unknown tool) carry safe static
  // messages and may cross the bridge; page-thrown errors are redacted.
  function internalError(message) {
    const e = new Error(message);
    e.__cairnInternal = true;
    return e;
  }
  function resultError(e) {
    if (e && e.__cairnInternal === true) return String(e.message).slice(0, 200);
    return `tool failed (${redactError(e)})`;
  }

  async function invoke(requestId, name, args, source) {
    // PRE-START cancellation check (the round-22 blocker: cancel only discarded
    // the RESULT, so a page function whose side effect had already executed kept
    // running). This synchronous check runs BEFORE the page function is invoked,
    // so a request that was already marked cancelled (or arrived after a cancel
    // epoch — round-23 blocker 1) never STARTS its side effect. It is
    // cooperative: once a page function has begun, its own DOM / storage /
    // network effects cannot be unwound — the result is discarded and the
    // invocation is marked cancelled, but the in-flight function itself runs
    // to settlement.
    if (cancelledAll || isCancelled(requestId)) {
      throw internalError("invocation cancelled");
    }
    if (!validToolName(name)) {
      throw internalError("invalid tool name");
    }
    // Dispatch BY SOURCE (the descriptor identity is threaded from the SW's
    // tool directory): a DECLARED WebMCP tool is resolved only through
    // document.modelContext — NEVER through window[name], so a page global
    // colliding with a declared tool name cannot hijack the invocation. An
    // INFERRED tool is resolved only through the captured exposure registry
    // (the exact function that was discovered), never a fresh window lookup.
    if (source === "inferred") {
      const entry = exposedRegistry.get(name);
      if (entry && typeof entry.fn === "function") {
        if (cancelledAll || isCancelled(requestId)) {
          throw internalError("invocation cancelled");
        }
        const params = paramNames(entry.fn);
        const ordered = params.map((p) => args?.[p]);
        return await entry.fn.apply(window, ordered);
      }
      throw internalError(`no such exposed function: ${name}`);
    }
    if (source === "declared") {
      // The webmcp-tools API executes via `document.modelContext.executeTool(
      // tool, args)` (a TOOL OBJECT, not a name), or the tool's own execute fn.
      const mc = document.modelContext;
      const raw = await getRawTools();
      const tool = raw.find((t) => t && t.name === name);
      if (tool) {
        if (cancelledAll || isCancelled(requestId)) {
          throw internalError("invocation cancelled");
        }
        if (typeof mc?.executeTool === "function") {
          return await mc.executeTool(tool, args ?? {});
        }
        if (typeof tool.execute === "function") return await tool.execute(args ?? {});
        if (typeof tool._execute === "function") return await tool._execute(args ?? {});
      }
      if (typeof mc?.callTool === "function") {
        if (cancelledAll || isCancelled(requestId)) {
          throw internalError("invocation cancelled");
        }
        return await mc.callTool(name, args ?? {});
      }
      if (typeof mc?.invoke === "function") {
        if (cancelledAll || isCancelled(requestId)) {
          throw internalError("invocation cancelled");
        }
        return await mc.invoke(name, args ?? {});
      }
      throw internalError(`no such declared tool: ${name}`);
    }
    throw internalError(`unknown tool source: ${String(source)}`);
  }

  const inflightTimers = new Set();
  function trackTimer(id) {
    inflightTimers.add(id);
    return id;
  }

  function onMessage(event) {
    if (event.source !== window) return; // only same-window messages
    const data = event.data;
    if (!data || typeof data !== "object" || data[CHANNEL] !== true) return;
    if (data.type === "init") {
      nonce = typeof data.nonce === "string" ? data.nonce : null;
      diagnostics = data.diagnostics === true;
      cancelledAll = false; // a fresh bridge/nonce resets the cancel epoch
      log("start", JSON.stringify({ origin: location.origin, role: "main-world" }));
      collectTools().then((tools) => post({ type: "tools", origin: location.origin, tools }));
    } else if (data.type === "collect") {
      diagnostics = data.diagnostics === true;
      collectTools().then((tools) => {
        const declared = tools.filter((t) => t.source === "declared").length;
        const inferred = tools.filter((t) => t.source === "inferred").length;
        log("discover", JSON.stringify({
          origin: location.origin,
          declaredCount: declared,
          inferredCount: inferred,
          toolCount: tools.length,
          toolNames: tools.map((t) => t.name),
        }));
        post({ type: "tools", origin: location.origin, tools });
      });
    } else if (data.type === "resume") {
      diagnostics = data.diagnostics === true;
      // Re-enrollment: clear the cancel epoch so NEW invokes are allowed again.
      // In-flight ids cancelled by the prior disenrollment stay cancelled (their
      // results remain discarded) — only the epoch is cleared.
      cancelledAll = false;
      log("resume", JSON.stringify({ origin: location.origin }));
    } else if (data.type === "cancel") {
      // Disenrollment cancellation: (1) set the cancel EPOCH so any NEW invoke
      // is rejected before it starts (round-23 blocker 1: a cancel that arrived
      // before a future invoke could not mark that future ID), and (2) mark every
      // currently in-flight invoke as cancelled so its result is discarded.
      cancelledAll = true;
      for (const id of inFlight) markCancelled(id);
      log("cancel", JSON.stringify({ origin: location.origin }));
    } else if (data.type === "invoke" && nonce && data.nonce === nonce) {
      log("invoke", JSON.stringify({ name: data.name, requestId: data.requestId }));
      const requestId = data.requestId;
      // REGISTER the in-flight id BEFORE the deferral (the round-28 regression:
      // without inFlight.add, a cancel could never tombstone a running invoke).
      inFlight.add(requestId);
      // Bound the in-flight set: a hung page function must not leave its request
      // id resident forever (the content-script drops the response at 15s, but
      // this world's promise could otherwise linger).
      trackTimer(setTimeout(() => { inFlight.delete(requestId); }, 20000));
      // Defer the page-function invocation by ONE macrotask so a `cancel`
      // delivered in the same turn (a disenrollment that raced this invoke)
      // can run FIRST and mark the request cancelled BEFORE the page function
      // starts (the round-23 blocker: invoking synchronously meant a later
      // cancel could never interleave between inFlight.add and the call).
      trackTimer(setTimeout(() => {
        if (cancelledAll || isCancelled(requestId)) {
          inFlight.delete(requestId);
          post({ type: "result", requestId, ok: false, error: "invocation cancelled" });
          return;
        }
        invoke(requestId, data.name, data.args, data.source)
          .then((result) => {
            inFlight.delete(requestId);
            // Check BOTH the per-id tombstone AND the cancel epoch (the round-28
            // regression: the success path only checked the tombstone, so a
            // cancel-all during the await let the result through).
            if (cancelledAll || isCancelled(requestId)) {
              cancelled.delete(requestId);
              post({ type: "result", requestId, ok: false, error: "invocation cancelled" });
              return;
            }
            log("result", JSON.stringify({ name: data.name, requestId, ok: true }));
            post({ type: "result", requestId, ok: true, result });
          })
          .catch((e) => {
            inFlight.delete(requestId);
            cancelled.delete(requestId);
            log("result", JSON.stringify({ name: data.name, requestId, ok: false, error: String(e?.message ?? e) }));
            // Redact the page-thrown body — only our own internal messages or
            // an allowlisted error NAME cross the bridge boundary.
            post({ type: "result", requestId, ok: false, error: resultError(e) });
          });
      }, 0));
    }
  }
  window.addEventListener("message", onMessage);

  // First pass after the page settles (the bridge's init also triggers a
  // collect; this covers a bridge that started later than this world).
  let loadTimer = null;
  const discoverAfterLoad = () => {
    loadTimer = trackTimer(setTimeout(() => collectTools().then((tools) => post({ type: "tools", origin: location.origin, tools })), 300));
  };
  const onLoad = () => discoverAfterLoad();
  if (document.readyState === "complete") discoverAfterLoad();
  else window.addEventListener("load", onLoad);

  // Register the versioned singleton so a re-injection tears THIS instance
  // down instead of stacking a duplicate listener (exactly one live MAIN-world
  // bridge per tab, no matter how many times enrollment re-injects).
  window[GUARD_KEY] = {
    version: MAIN_WORLD_VERSION,
    teardown() {
      // Suppress every in-flight + future result, remove the listeners, and
      // clear the pending timers so nothing from this instance can fire again.
      cancelledAll = true;
      for (const id of inFlight) markCancelled(id);
      for (const t of inflightTimers) clearTimeout(t);
      inflightTimers.clear();
      window.removeEventListener("message", onMessage);
      window.removeEventListener("load", onLoad);
      nonce = null; // post() goes silent even if a stale closure fires
    },
  };
})();
