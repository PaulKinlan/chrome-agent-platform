// Lightweight MAIN-world capability probe. Detection only: no enrollment,
// bridge arming, descriptor transport, or invocation surface.
(() => {
  const CHANNEL = "__cap_webmcp_detect";
  let lastCount = -1;
  let scans = Promise.resolve();

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
      const names = new Set([...(await declaredNames()), ...exposedNames()]);
      const toolCount = Math.min(200, names.size);
      if (toolCount === lastCount) return;
      lastCount = toolCount;
      window.postMessage({ [CHANNEL]: 1, type: "snapshot", toolCount }, "*");
    }).catch(() => {});
  }

  for (const delay of [0, 500, 1500, 4000]) setTimeout(scan, delay);
  window.addEventListener("load", scan, { once: true });
  for (const eventName of ["webmcp:tools-changed", "modelcontextchange"]) {
    document.addEventListener(eventName, scan);
  }
})();
