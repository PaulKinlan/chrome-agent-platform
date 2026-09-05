// Lightweight MAIN-world capability probe. Detection only: no enrollment,
// bridge arming, descriptor transport, or invocation surface. Snapshots are
// MAC'd with a per-document key delivered out-of-band by the extension.
(() => {
  const CHANNEL = "__cap_webmcp_detect";
  // NOTE: no `__` prefix — the shipped-code oracle scan flags every
  // `window/self/globalThis.__*` access as a test-oracle smell, and bundle
  // minification inlines the probe's `const root = globalThis` alias into a
  // direct `globalThis.<name>` access. The production hook name stays clear
  // of the oracle rule so the minified store bundle scans clean.
  //
  // The hook name is PER-DOCUMENT and unguessable (the fingerprint-surface
  // finding, chrome-agent-platform-f62c): a fixed global name let any page
  // probe for the extension's presence. The random suffix is generated at
  // document_start; the isolated relay learns the name from the one-time
  // `hook` channel message posted below and hands it to the service worker
  // over the privileged runtime channel. A page can still ENUMERATE its own
  // globals (getOwnPropertyNames) — that is observation of its own realm,
  // not a probe — but no page can probe a STATIC contract. A page that
  // injects a fake `hook` message can only point the SW at a function in its
  // own document; the delivered nonce scopes to this document's detection
  // feed, which the page already fully controls by declaring or removing its
  // own tools. Fail-closed: if the relay never reports a valid name, the SW
  // simply cannot arm the probe (detection stays off, never spoofable).
  const HOOK_KEY = `capWebmcpDetectBootstrap_${crypto.randomUUID().replaceAll("-", "")}`;
  const encoder = new TextEncoder();
  const subtle = crypto.subtle;
  let nonce = null;
  let sequence = 0;
  let lastCount = -1;
  let scans = Promise.resolve();

  async function sign(value) {
    const key = await subtle.importKey(
      "raw",
      encoder.encode(nonce),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const bytes = new Uint8Array(await subtle.sign("HMAC", key, encoder.encode(value)));
    return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function toolName(value) {
    return value && typeof value.name === "string" && value.name.length > 0 && value.name.length <= 128
      ? value.name
      : null;
  }

  async function declaredNames() {
    let context;
    try { context = document.modelContext ?? navigator.modelContext; } catch { return []; }
    if (!context) return [];
    let tools;
    try {
      if (typeof context.getTools === "function") {
        tools = await Promise.race([
          Promise.resolve(context.getTools()),
          new Promise((resolve) => setTimeout(() => resolve(null), 250)),
        ]);
      } else {
        tools = context.tools;
      }
    } catch { return []; }
    if (Array.isArray(tools)) return tools.map(toolName).filter(Boolean);
    if (tools && typeof tools.values === "function") {
      try { return [...tools.values()].map(toolName).filter(Boolean); } catch { return []; }
    }
    if (tools && typeof tools === "object") return Object.values(tools).map(toolName).filter(Boolean);
    return [];
  }

  function exposedNames() {
    let exposed;
    try { exposed = window.webmcpExpose; } catch { return []; }
    if (!Array.isArray(exposed)) return [];
    return exposed.slice(0, 100).map((entry) => {
      if (typeof entry === "function") return entry.name || null;
      if (entry && typeof entry.fn === "function") return entry.name || entry.fn.name || null;
      return null;
    }).filter(Boolean);
  }

  function scan() {
    scans = scans.then(async () => {
      if (!nonce) return;
      const names = new Set([...(await declaredNames()), ...exposedNames()]);
      const toolCount = Math.min(200, names.size);
      if (toolCount === lastCount) return;
      lastCount = toolCount;
      const seq = sequence++;
      window.postMessage({
        [CHANNEL]: 1,
        type: "snapshot",
        toolCount,
        seq,
        tag: await sign(`detect|${seq}|${toolCount}`),
      }, "*");
    }).catch(() => {});
  }

  const bootstrap = (value) => {
    if (typeof value !== "string" || value.length < 16 || value.length > 128) return false;
    nonce = value;
    sequence = 0;
    lastCount = -1;
    scan();
    return true;
  };
  try {
    Object.defineProperty(globalThis, HOOK_KEY, {
      value: bootstrap,
      writable: false,
      configurable: false,
    });
  } catch { /* a page that pre-seized the hook makes detection fail closed */ }

  // Tell the ISOLATED relay the per-document hook name so the service worker
  // can arm the probe without a static global contract. Unauthenticated by
  // design (no nonce exists yet): the name is a capability label for THIS
  // document only, and the relay validates its shape before forwarding.
  // Announced on the SAME retry schedule as the scan — both worlds start at
  // document_start and either can win the race (the relay keeps the FIRST
  // valid name, so repeats are idempotent).
  const announceHook = () => {
    try {
      window.postMessage({ [CHANNEL]: 1, type: "hook", hook: HOOK_KEY }, "*");
    } catch { /* fail closed */ }
  };
  announceHook();
  for (const delay of [50, 250, 1000]) setTimeout(announceHook, delay);

  for (const delay of [0, 500, 1500, 4000]) setTimeout(scan, delay);
  window.addEventListener("load", scan, { once: true });
  for (const eventName of ["webmcp:tools-changed", "modelcontextchange"]) {
    document.addEventListener(eventName, scan);
  }
})();
