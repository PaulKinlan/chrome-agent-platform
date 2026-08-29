// content/main-world.js — runs in the PAGE's world (world: "MAIN"), so it can
// see the page's own exposed functions + document.modelContext (WebMCP). It
// cannot use chrome.* APIs, so it talks to the isolated-world content script
// over window.postMessage — a BROADCAST channel every page script can observe.
//
// Transport integrity: the service worker delivers a per-document MAC key
// out-of-band (chrome.scripting.executeScript args), never over postMessage.
// HMAC-SHA256 + monotonic sequences reject unauthenticated/replayed transport
// messages, including control messages the old design accepted bare.
//
// TRUST LIMIT: MAIN is the page realm. The MAC does not attest page tools,
// side effects, return values, or realm integrity; all remain page-controlled.
// A page that ran first or poisoned intrinsics can interfere with its own
// bridge. The security boundary remains in the service worker: sender-derived
// origin/tab/document, exact binding, generation fencing, and owner approval.
//
// Discovery: reads the page's POSITIVE opt-in exposure (window.webmcpExpose) +
// document.modelContext tools, and posts them up. Blind window.* enumeration is
// GONE (the round-28 review: enumerating every enumerable global function was
// an unsafe eligibility policy). Invocation: on an authenticated "invoke"
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
// new one installs, so exactly ONE live MAIN-world bridge exists per tab. The
// ENTIRE file is function-scoped: repeated executeScript injection in the same
// realm must not fail on redeclaring top-level lexical `const` bindings before
// the teardown guard gets a chance to run.
(() => {
  const MAIN_WORLD_VERSION = 3;
  const GUARD_KEY = "__capMainWorldBridge";
  // Capture the NATIVE DOMException at document_start, before any page script
  // can replace the global (the redaction below relies on a genuine
  // instanceof check; a page-substituted constructor must not weaken it).
  const NativeDOMException = globalThis.DOMException;
  {
    const prev = window[GUARD_KEY];
    if (prev && typeof prev === "object" && typeof prev.teardown === "function") {
      try { prev.teardown(); } catch { /* a stale world must never block the new one */ }
    }
  }

  const CHANNEL = "__cap_bridge";
  const TAG = "[WebMCP:main]";
  const auth = globalThis.CapBridgeAuth; // injected before this file
  // The MAC key — set ONLY by the bootstrap hook (closure-captured, never
  // posted, never exposed on any global). null = unarmed: this world stays
  // silent and ignores every inbound message.
  let nonce = null;
  // Developer diagnostics (gated): when the bootstrap delivers
  // `diagnostics: true`, emit structured [WebMCP] logs so the discovery
  // pipeline is observable in the page DevTools console. Off by default (no
  // console noise); enabled from Settings → Site agents → Diagnostics.
  let diagnostics = false;
  function log(...args) {
    if (!diagnostics) return;
    try { console.log(TAG, ...args); } catch { /* never throw from a logger */ }
  }
  function warnToolFailure(name, args, error) {
    if (!diagnostics) return;
    let argsShape = typeof args;
    try {
      if (Array.isArray(args)) argsShape = `array(${args.length})`;
      else if (args && typeof args === "object") argsShape = `{ ${Object.keys(args).slice(0, 50).join(", ").slice(0, 1000)} }`;
    } catch { argsShape = "<unavailable>"; }
    try {
      // Page-local only: the original error never enters post(), the SW, or model logs.
      console.warn(TAG, "tool call failed", { tool: name, argsShape }, error);
    } catch { /* never throw from a logger */ }
  }

  // ── Cancellation: an IMMUTABLE epoch, not expiring tombstones ────────────
  // The round-30 blocker: the old per-id tombstones expired after 60s (or were
  // evicted under a flood) and re-enrollment cleared `cancelledAll`, so a
  // cancelled page promise settling AFTER expiry+resume could still surface
  // its result. `cancelEpoch` is a monotonic counter that ONLY EVER INCREASES
  // (on cancel, on (re-)arm, on teardown); every invocation captures it at
  // dispatch and re-checks it before its result is posted. A cancel advances
  // the epoch, so a cancelled invocation's captured epoch can NEVER match
  // again — no TTL, no eviction, no resurrection across resume. Correctness
  // no longer depends on retaining any tombstone. Bounded by construction
  // (two numbers, no map). Cooperative: once a page function has begun, its
  // own DOM / storage / network effects cannot be unwound — the result is
  // discarded and the invocation marked cancelled, but the in-flight function
  // itself runs to settlement.
  let cancelEpoch = 0;
  // `cancelledAll` blocks NEW invokes between a cancel and the next (re-)arm
  // (bootstrap/resume). It is always paired with a cancelEpoch increment.
  let cancelledAll = false;
  const inFlight = new Set();

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

  // Per-direction bridge sequences (replay suppression, per nonce).
  let upSeq = 0; // MAIN → isolated
  let downSeq = -1; // isolated → MAIN (last accepted)

  function post(msg) {
    // Every outbound message is MAC'd with the SW-issued nonce (never itself
    // posted). Before the bootstrap there is no key — stay silent rather than
    // emit anything spoofable-looking.
    if (!nonce || !auth) return;
    window.postMessage({ [CHANNEL]: true, ...auth.seal(nonce, "up", upSeq++, msg) }, "*");
  }

  // Page-thrown exception text is attacker-controlled and may embed secrets —
  // never surface it to the bridge/SW/model, not even in the DIAGNOSTICS log
  // (the round-30 redaction finding: the gated log used to mirror the raw page
  // exception text). Report only a bounded, allowlisted error NAME.
  const SAFE_ERROR_NAMES = new Set([
    "Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError",
    "EvalError", "URIError", "AggregateError", "DOMException",
  ]);
  // The spec-defined DOMException names (WebIDL §3.11 + the legacy code
  // names). A genuine DOMException's `.name` is drawn from THIS bounded set in
  // practice, but `new DOMException(msg, name)` accepts ANY string — so the
  // name is only surfaced when it is allowlisted here. The `.message` is
  // attacker-controlled free text and NEVER crosses the bridge.
  const SAFE_DOMEXCEPTION_NAMES = new Set([
    "IndexSizeError", "HierarchyRequestError", "WrongDocumentError",
    "InvalidCharacterError", "NoModificationAllowedError", "NotFoundError",
    "NotSupportedError", "InUseAttributeError", "InvalidStateError",
    "SyntaxError", "InvalidModificationError", "NamespaceError",
    "InvalidAccessError", "TypeMismatchError", "SecurityError",
    "NetworkError", "AbortError", "URLMismatchError", "QuotaExceededError",
    "TimeoutError", "InvalidNodeTypeError", "DataCloneError",
    "EncodingError", "NotReadableError", "UnknownError", "ConstraintError",
    "DataError", "TransactionInactiveError", "ReadOnlyError", "VersionError",
    "OperationError", "NotAllowedError",
  ]);
  function redactError(e) {
    // A GENUINE DOMException (native constructor, captured before page code
    // runs) may report its bounded spec-defined NAME — e.g. "NotAllowedError"
    // tells the owner WHAT failed without leaking attacker text. A crafted
    // name (DOMException accepts arbitrary name strings) falls back to the
    // bare type; the message NEVER surfaces.
    if (
      typeof NativeDOMException === "function" &&
      e instanceof NativeDOMException
    ) {
      const n = typeof e?.name === "string" ? e.name : "";
      return SAFE_DOMEXCEPTION_NAMES.has(n) ? `DOMException: ${n}` : "DOMException";
    }
    const name = e && typeof e === "object" ? e.constructor?.name : null;
    return SAFE_ERROR_NAMES.has(name) ? name : "Error";
  }
  // Errors WE throw (cancellation, dispatch, unknown tool) carry safe static
  // messages and may cross the bridge; page-thrown errors are redacted.
  function internalError(message) {
    const e = new Error(message);
    e.__capInternal = true;
    return e;
  }
  function resultError(e) {
    if (e && e.__capInternal === true) return String(e.message).slice(0, 200);
    return `tool failed (${redactError(e)})`;
  }

  async function invoke(isStale, name, args, source) {
    // PRE-START cancellation check (the round-22 blocker: cancel only discarded
    // the RESULT, so a page function whose side effect had already executed kept
    // running). This synchronous check runs BEFORE the page function is invoked,
    // so a request captured under a superseded cancel epoch never STARTS its
    // side effect.
    if (isStale()) {
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
        if (isStale()) {
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
        if (isStale()) {
          throw internalError("invocation cancelled");
        }
        if (typeof mc?.executeTool === "function") {
          return await mc.executeTool(tool, args ?? {});
        }
        if (typeof tool.execute === "function") return await tool.execute(args ?? {});
        if (typeof tool._execute === "function") return await tool._execute(args ?? {});
      }
      if (typeof mc?.callTool === "function") {
        if (isStale()) {
          throw internalError("invocation cancelled");
        }
        return await mc.callTool(name, args ?? {});
      }
      if (typeof mc?.invoke === "function") {
        if (isStale()) {
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

  // The instance API the stable bootstrap hook forwards to.
  const instance = {
    dead: false,
    bootstrap(n, diag) {
      if (this.dead) return;
      if (typeof n !== "string" || n.length < 16 || n.length > 128) return;
      if (nonce !== n) {
        nonce = n;
        upSeq = 0;
        downSeq = -1;
      }
      diagnostics = diag === true;
      // A (re-)arm is an enrollment boundary: NEW invokes are allowed again,
      // and the epoch advances so nothing captured before this arm can post.
      cancelledAll = false;
      cancelEpoch++;
      log("start", JSON.stringify({ origin: location.origin, role: "main-world" }));
      collectTools().then((tools) => post({ type: "tools", origin: location.origin, tools }));
    },
  };

  // The STABLE bootstrap hook: installed at most once per document as a
  // non-writable, non-configurable global (a page script that runs after us
  // cannot replace it; a page that pre-seized the name makes our install throw
  // and we fail CLOSED). The SW delivers the nonce by calling this hook via
  // chrome.scripting.executeScript func args — never over the broadcast
  // channel. Re-injection RE-TARGETS the same hook at the new instance (the
  // hook itself stays). A page calling the hook with a guessed value only
  // arms this world with the WRONG key — its messages fail MAC verification
  // at the isolated relay (fail closed, self-impact only).
  const HOOK_KEY = "__capMainWorldBootstrap";
  {
    const existing = globalThis[HOOK_KEY];
    if (typeof existing === "function" && existing.__capHook === true) {
      existing.adopt(instance);
    } else {
      let current = instance;
      const hook = function (n, d) {
        if (current && !current.dead) current.bootstrap(n, d);
      };
      Object.defineProperty(hook, "__capHook", { value: true });
      hook.adopt = (inst) => {
        current = inst && typeof inst.bootstrap === "function" ? inst : null;
      };
      Object.freeze(hook);
      try {
        Object.defineProperty(globalThis, HOOK_KEY, {
          value: hook,
          writable: false,
          configurable: false,
        });
      } catch {
        // A hostile page pre-seized the hook name — fail closed (discovery
        // stays silent); never throw out of a content script.
      }
    }
  }
  // The pending-bootstrap fallback: the SW's bootstrap may land BEFORE this
  // file executed (a document_start race). Consume + clear it immediately.
  try {
    const pending = globalThis.capMainWorldPendingBootstrap;
    if (pending && typeof pending === "object") {
      delete globalThis.capMainWorldPendingBootstrap;
      instance.bootstrap(pending.nonce, pending.diagnostics);
    }
  } catch { /* fail closed */ }

  function onMessage(event) {
    if (event.source !== window) return; // only same-window messages
    const data = event.data;
    if (!data || typeof data !== "object" || data[CHANNEL] !== true) return;
    // MAC gate FIRST (the round-30 blocker: init/resume/cancel/collect/invoke
    // were accepted UNAUTHENTICATED). An unkeyed, wrongly-keyed, or replayed
    // message is dropped before any dispatch.
    const opened = auth ? auth.open(nonce, "down", downSeq, data) : { ok: false };
    if (!opened.ok) return;
    downSeq = opened.seq;
    const msg = opened.msg;
    if (msg.type === "collect") {
      diagnostics = msg.diagnostics === true;
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
    } else if (msg.type === "resume") {
      diagnostics = msg.diagnostics === true;
      // Re-enrollment: NEW invokes are allowed again; the epoch advances so
      // invocations captured BEFORE the cancel stay cancelled forever (the
      // round-30 immutable-epoch fix — their results can never resurface).
      cancelledAll = false;
      cancelEpoch++;
      log("resume", JSON.stringify({ origin: location.origin }));
    } else if (msg.type === "cancel") {
      // Disenrollment cancellation: block NEW invokes and advance the epoch so
      // every in-flight invocation's captured epoch is permanently stale — its
      // result is discarded no matter when the page function settles.
      cancelledAll = true;
      cancelEpoch++;
      log("cancel", JSON.stringify({ origin: location.origin }));
    } else if (msg.type === "invoke") {
      log("invoke", JSON.stringify({ name: msg.name, requestId: msg.requestId }));
      const requestId = msg.requestId;
      // Capture the cancellation epoch AT DISPATCH (immutable fencing).
      const epoch = cancelEpoch;
      const isStale = () => cancelledAll || epoch !== cancelEpoch;
      // REGISTER the in-flight id BEFORE the deferral (the round-28 regression:
      // without inFlight.add, a teardown could never bound a running invoke).
      inFlight.add(requestId);
      // Bound the in-flight set: a hung page function must not leave its request
      // id resident forever (the content-script drops the response at 15s, but
      // this world's promise could otherwise linger).
      trackTimer(setTimeout(() => { inFlight.delete(requestId); }, 20000));
      // Defer the page-function invocation by ONE macrotask so a `cancel`
      // delivered in the same turn (a disenrollment that raced this invoke)
      // can run FIRST and advance the epoch BEFORE the page function starts
      // (the round-23 blocker: invoking synchronously meant a later cancel
      // could never interleave between inFlight.add and the call).
      trackTimer(setTimeout(() => {
        if (isStale()) {
          inFlight.delete(requestId);
          post({ type: "result", requestId, ok: false, error: "invocation cancelled" });
          return;
        }
        invoke(isStale, msg.name, msg.args, msg.source)
          .then((result) => {
            inFlight.delete(requestId);
            // Re-check the epoch at SETTLEMENT (the round-28 regression checked
            // only a per-id tombstone; the round-30 fix makes the fence an
            // immutable epoch so a post-resume late settlement can NEVER post).
            if (isStale()) {
              post({ type: "result", requestId, ok: false, error: "invocation cancelled" });
              return;
            }
            log("result", JSON.stringify({ name: msg.name, requestId, ok: true }));
            post({ type: "result", requestId, ok: true, result });
          })
          .catch((e) => {
            inFlight.delete(requestId);
            // The page owner can inspect the original error in their own
            // DevTools. Only the redacted value may cross the bridge or enter
            // the extension/model diagnostics path.
            warnToolFailure(msg.name, msg.args, e);
            const safe = isStale() ? "invocation cancelled" : resultError(e);
            log("result", JSON.stringify({ name: msg.name, requestId, ok: false, error: safe }));
            post({ type: "result", requestId, ok: false, error: safe });
          });
      }, 0));
    }
  }
  window.addEventListener("message", onMessage);

  // First pass after the page settles (the bootstrap also triggers a collect;
  // this covers an arming that happened after the load event).
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
      // Suppress every in-flight + future result (the epoch advance makes every
      // captured epoch permanently stale), remove the listeners, and clear the
      // pending timers so nothing from this instance can fire again.
      instance.dead = true;
      cancelledAll = true;
      cancelEpoch++;
      for (const t of inflightTimers) clearTimeout(t);
      inflightTimers.clear();
      window.removeEventListener("message", onMessage);
      window.removeEventListener("load", onLoad);
      nonce = null; // post() goes silent even if a stale closure fires
    },
  };
})();
