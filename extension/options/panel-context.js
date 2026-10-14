// extension/options/panel-context.js — Stage 3a (chrome-agent-platform-8v5l.1).
//
// Host-injected context (`ctx`) contract for mountable Settings panels.

import { subscribeDiagnosticsRevision as defaultSubscribeDiagnosticsRevision } from "../shared/diagnostics-client.js";

export function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

export function withUnmount(promise, unmount) {
  const wrapped = Promise.resolve(promise).then(() => ({ unmount }));
  wrapped.unmount = unmount;
  return wrapped;
}

export function resolvePanelCtx(sectionId, root, ctx, activeCtx) {
  if (ctx) return ctx;
  if (activeCtx) return activeCtx;
  return createPanelContext({
    root: root ?? (typeof document !== "undefined" ? (document.getElementById(sectionId) ?? document) : null),
  });
}

export function bindPanelCtx(sectionId) {
  let active = null;
  const wired = new WeakSet();
  const ensure = (root, ctx) => (active = resolvePanelCtx(sectionId, root, ctx, active));
  const get = () => ensure();
  const wireOnce = (ctx) => {
    const c = ensure(null, ctx);
    const key = c.root ?? c;
    if (wired.has(key)) return null;
    wired.add(key);
    c.registerCleanup(() => wired.delete(key));
    return c;
  };
  return [
    ensure,
    (sel, r) => get().$(sel, r),
    (sel, r) => get().$$(sel, r),
    (id, r) => get().byId(id, r),
    (t, p) => get().send(t, p),
    (t, p, ms) => get().boundedSend(t, p, ms),
    {
      get: (k) => get().storage.get(k),
      set: (v) => get().storage.set(v),
      remove: (k) => get().storage.remove(k),
    },
    (m) => get().saveFlash(m),
    (el, t, fn, o) => get().on(el, t, fn, o),
    (panelCtx) => () => {
      if (active === panelCtx) active = null;
      panelCtx.unmount();
    },
    wireOnce,
  ];
}

function findByIdInRoot(root, id) {
  const clean = String(id ?? "").replace(/^#/, "");
  if (!root || !clean) return null;
  if (root.id === clean) return root;
  let found = null;
  try {
    found = root.getElementById?.(clean) ?? root.querySelector?.(`#${globalThis.CSS?.escape ? CSS.escape(clean) : clean}`);
  } catch {
    found = root.querySelector?.(`#${clean}`);
  }
  if (found) return found;
  const stack = [...(root.children ?? root.childNodes ?? [])];
  while (stack.length > 0) {
    const node = stack.shift();
    if (!node) continue;
    if (node.id === clean) return node;
    const kids = node.children ?? node.childNodes;
    if (kids?.length) stack.unshift(...kids);
  }
  return null;
}

function findSelectorInRoot(root, selector) {
  const sel = String(selector ?? "").trim();
  if (!root || !sel) return null;
  if (sel[0] === "#" && !/[\s.>~+\[:#]/.test(sel.slice(1))) return findByIdInRoot(root, sel.slice(1));
  try { if (root.matches?.(sel)) return root; } catch { /* ignore */ }
  return root.querySelector?.(sel) ?? null;
}

export function createPanelContext(options = {}) {
  let currentRoot = options.root ?? null;
  let controller = new AbortController();
  const cleanups = [];
  const activeTimers = new Set();
  const trackedNodes = new WeakSet();

  const setTimeoutFn = options.setTimeout ?? ((fn, ms, ...args) => globalThis.setTimeout(fn, ms, ...args));
  const clearTimeoutFn = options.clearTimeout ?? ((id) => globalThis.clearTimeout(id));
  const subscribeDiagFn = options.subscribeDiagnosticsRevision ?? defaultSubscribeDiagnosticsRevision;
  const connectPortFn = options.connectPort ?? ((info) => globalThis.chrome?.runtime?.connect?.(info));
  const rawSendMessage = options.rawSendMessage ?? ((message) => globalThis.chrome.runtime.sendMessage(message));

  const sendFn = options.send
    ? (typeOrMsg, payload = {}) => {
      if (typeof typeOrMsg === "object" && typeOrMsg !== null) {
        const { type, ...rest } = typeOrMsg;
        return options.send(type, rest, typeOrMsg);
      }
      return options.send(typeOrMsg, payload);
    }
    : (typeOrMsg, payload = {}) =>
      rawSendMessage(typeof typeOrMsg === "object" && typeOrMsg !== null ? typeOrMsg : { type: typeOrMsg, ...payload });

  const boundedSendFn = options.boundedSend ?? ((type, payload = {}, timeoutMs = 12000) => {
    let timerId;
    return Promise.race([
      sendFn(type, payload),
      new Promise((_, reject) => { timerId = trackedSetTimeout(() => reject(new Error("timeout")), timeoutMs); }),
    ]).finally(() => trackedClearTimeout(timerId));
  });

  const kvOp = (op, label, payload) =>
    boundedSendFn(`kv.${op}`, payload).catch((e) => ({ error: `storage ${label} didn't answer — ${String(e?.message ?? e)}` }));
  const storage = options.storage ?? {
    get: (keys) => kvOp("get", "read", { keys }),
    set: (values) => kvOp("set", "write", { values }),
    remove: (keys) => kvOp("remove", "remove", { keys }),
  };

  let devState = typeof options.developerFeatures === "boolean" ? options.developerFeatures : false;
  const getDeveloperFeatures = typeof options.developerFeatures === "function" ? options.developerFeatures : () => devState;
  const setDeveloperFeatures = options.setDeveloperFeatures ?? ((on) => { devState = Boolean(on); });
  const getStorageGranted = typeof options.storageGranted === "function"
    ? options.storageGranted
    : () => (options.storageGranted !== undefined ? Boolean(options.storageGranted) : true);
  const refreshStoragePermission = options.refreshStoragePermission ?? (async () => getStorageGranted());
  const embedded = Boolean(options.embedded);
  const isFirstRunFlow = typeof options.isFirstRunFlow === "function" ? options.isFirstRunFlow : () => embedded;
  const navigateSection = options.navigateSection ?? (async () => true);
  const saveFlash = options.saveFlash ?? (() => {});
  const noop = () => {};
  const callbacks = {
    goHome: noop,
    returnToComposer: noop,
    editNamedAgent: noop,
    onFactoryReset: noop,
    onPermissionsChanged: noop,
    onEnrolledSitesChanged: noop,
    onSiteDataChanged: noop,
    ...options.callbacks,
  };

  function registerCleanup(fn) {
    if (typeof fn !== "function") return noop;
    cleanups.push(fn);
    return () => {
      const idx = cleanups.indexOf(fn);
      if (idx !== -1) cleanups.splice(idx, 1);
    };
  }

  function trackDomNode(node) {
    if (!node || (typeof node !== "object" && typeof node !== "function") || trackedNodes.has(node)) return node;
    trackedNodes.add(node);
    const origAdd = typeof node.addEventListener === "function" ? node.addEventListener : null;
    const origRemove = typeof node.removeEventListener === "function" ? node.removeEventListener : null;
    const origQS = typeof node.querySelector === "function" ? node.querySelector : null;
    const origQSA = typeof node.querySelectorAll === "function" ? node.querySelectorAll : null;

    if (origAdd && origRemove) {
      try {
        node.addEventListener = (type, listener, opts) => {
          if (!listener) return;
          origAdd.call(node, type, listener, opts);
          registerCleanup(() => { try { origRemove.call(node, type, listener, opts); } catch { /* ignore */ } });
        };
      } catch { /* read-only */ }
    }
    if (origQS) {
      try { node.querySelector = (sel) => trackDomNode(origQS.call(node, sel)); } catch { /* read-only */ }
    }
    if (origQSA) {
      try {
        node.querySelectorAll = (sel) => {
          const list = origQSA.call(node, sel);
          if (list) for (const item of list) trackDomNode(item);
          return list;
        };
      } catch { /* read-only */ }
    }
    registerCleanup(() => {
      try {
        if (origAdd) node.addEventListener = origAdd;
        if (origQS) node.querySelector = origQS;
        if (origQSA) node.querySelectorAll = origQSA;
      } catch { /* ignore */ }
      trackedNodes.delete(node);
    });
    return node;
  }

  if (currentRoot) trackDomNode(currentRoot);

  function byId(id, rootOverride = currentRoot) {
    const r = rootOverride ?? currentRoot;
    if (r) trackDomNode(r);
    return trackDomNode(findByIdInRoot(r, id));
  }

  function $(selector, rootOverride = currentRoot) {
    const r = rootOverride ?? currentRoot;
    if (r) trackDomNode(r);
    return trackDomNode(findSelectorInRoot(r, selector));
  }

  function $$(selector, rootOverride = currentRoot) {
    const r = rootOverride ?? currentRoot;
    if (r) trackDomNode(r);
    const list = r && typeof r.querySelectorAll === "function" ? Array.from(r.querySelectorAll(String(selector).trim())) : [];
    return list.map(trackDomNode);
  }

  function addEventListener(target, type, listener, opts) {
    if (!target || typeof target.addEventListener !== "function" || !listener) return noop;
    target.addEventListener(type, listener, opts);
    return registerCleanup(() => { try { target.removeEventListener?.(type, listener, opts); } catch { /* ignore */ } });
  }

  function addChromeListener(eventObj, listener) {
    if (!eventObj || typeof eventObj.addListener !== "function" || !listener) return noop;
    eventObj.addListener(listener);
    return registerCleanup(() => { try { eventObj.removeListener?.(listener); } catch { /* ignore */ } });
  }

  function connectPort(connectInfo) {
    const port = connectPortFn(connectInfo);
    if (!port) return null;
    if (port.onMessage && typeof port.onMessage.addListener === "function") {
      const origPortAdd = port.onMessage.addListener.bind(port.onMessage);
      const origPortRemove = port.onMessage.removeListener?.bind(port.onMessage);
      port.onMessage.addListener = (listener) => {
        origPortAdd(listener);
        registerCleanup(() => { try { origPortRemove?.(listener); } catch { /* ignore */ } });
      };
    }
    registerCleanup(() => { try { port.disconnect?.(); } catch { /* ignore */ } });
    return port;
  }

  function subscribeDiagnosticsRevision(onChange) {
    const unsub = subscribeDiagFn(onChange);
    if (typeof unsub === "function") {
      registerCleanup(unsub);
      return unsub;
    }
    return noop;
  }

  function trackedSetTimeout(fn, delayMs = 0, ...args) {
    if (controller.signal.aborted) return null;
    let id = null;
    id = setTimeoutFn(() => {
      if (id !== null) activeTimers.delete(id);
      if (!controller.signal.aborted) fn(...args);
    }, delayMs);
    if (id !== null && id !== undefined) activeTimers.add(id);
    return id;
  }

  function trackedClearTimeout(id) {
    if (id === null || id === undefined) return;
    activeTimers.delete(id);
    clearTimeoutFn(id);
  }

  function unmount() {
    if (!controller.signal.aborted) controller.abort();
    for (const timerId of [...activeTimers]) {
      activeTimers.delete(timerId);
      try { clearTimeoutFn(timerId); } catch { /* ignore */ }
    }
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      try { fn(); } catch { /* cleanup never throws */ }
    }
  }


  return {
    get root() { return currentRoot; },
    set root(r) { currentRoot = r; if (r) trackDomNode(r); },
    send: sendFn,
    boundedSend: boundedSendFn,
    storage,
    byId,
    $,
    $$,
    embedded,
    isFirstRunFlow,
    developerFeatures: getDeveloperFeatures,
    setDeveloperFeatures,
    storageGranted: getStorageGranted,
    refreshStoragePermission,
    navigateSection,
    saveFlash,
    callbacks,
    get signal() { return controller.signal; },
    registerCleanup,
    onUnmount: registerCleanup,
    setTimeout: trackedSetTimeout,
    clearTimeout: trackedClearTimeout,
    on: addEventListener,
    addEventListener,
    addChromeListener,
    connectPort,
    subscribeDiagnosticsRevision,
    unmount,
  };
}
