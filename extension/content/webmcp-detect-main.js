// Lightweight MAIN-world capability probe. Detection only: no enrollment,
// bridge arming, descriptor transport, or invocation surface. Snapshots are
// MAC'd with a per-document key delivered out-of-band by the extension.
(() => {
  const CHANNEL = "__cap_webmcp_detect";
  const HOOK_KEY = "__capWebmcpDetectBootstrap";
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

  for (const delay of [0, 500, 1500, 4000]) setTimeout(scan, delay);
  window.addEventListener("load", scan, { once: true });
  for (const eventName of ["webmcp:tools-changed", "modelcontextchange"]) {
    document.addEventListener(eventName, scan);
  }
})();
