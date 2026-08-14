// content/content-script.js — WebMCP bridge + tool inference (runs in page context).
//
// 1. Collects declared WebMCP tools (document.modelContext) + linked agent.md /
//    skills (future) + inferred window.* functions, and reports them to the
//    background worker so the hub can build its per-site tool directory.
// 2. Handles "invoke-tool" messages: calls a page function / WebMCP tool.

const origin = location.origin;

function isDomOwned(name) {
  // Heuristic: a DOM-owned global is a known platform object/property.
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
  ]);
  return platform.has(name);
}

function paramNames(fn) {
  const src = Function.prototype.toString.call(fn);
  const m = src.match(/^(?:async\s+)?(?:function\s*[^(]*)?\(([^)]*)\)/);
  if (!m) return [];
  return m[1].split(",").map((p) => p.trim()).filter((p) => p && !p.includes("=")).map((p) => p.replace(/\/\*.*?\*\//g, "").trim()).filter(Boolean);
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
    } catch { /* not a callable we can inspect */ }
  }
  return out.slice(0, 200); // cap inferred surface
}

function declaredTools() {
  const mc = document.modelContext;
  const tools = mc?.tools ?? mc?.getTools?.() ?? null;
  const out = [];
  if (tools instanceof Map) {
    for (const [name, t] of tools) {
      out.push({
        name,
        source: "declared",
        description: t.description ?? "",
        inputSchema: t.inputSchema ?? { type: "object", properties: {} },
      });
    }
  } else if (Array.isArray(tools)) {
    for (const t of tools) out.push({ name: t.name, source: "declared", description: t.description ?? "", inputSchema: t.inputSchema ?? {} });
  }
  return out;
}

// Report tools to the background worker.
async function reportTools() {
  const declared = declaredTools();
  const inferred = declared.length ? [] : inferTools(); // declared wins; infer as fallback
  const tools = [...declared, ...inferred];
  if (!tools.length) return;
  try {
    await chrome.runtime.sendMessage({ type: "tools.upsert", origin, tools });
  } catch { /* background not ready */ }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "invoke-tool") {
    const { name, args } = message;
    try {
      const fn = window[name];
      if (typeof fn === "function") {
        const params = paramNames(fn);
        const ordered = params.map((p) => args?.[p]);
        const result = fn.apply(window, ordered);
        Promise.resolve(result).then((r) => sendResponse({ ok: true, result: r })).catch((e) => sendResponse({ ok: false, error: String(e) }));
        return true;
      }
      // WebMCP path: call the registered tool.
      const mc = document.modelContext;
      if (mc?.callTool) {
        mc.callTool(name, args).then((r) => sendResponse({ ok: true, result: r })).catch((e) => sendResponse({ ok: false, error: String(e) }));
        return true;
      }
      sendResponse({ ok: false, error: `no such function/tool: ${name}` });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
    return true;
  }
  if (message?.type === "collect-tools") {
    reportTools().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

// Collect once on load (after the page settles).
if (document.readyState === "complete") setTimeout(reportTools, 500);
else window.addEventListener("load", () => setTimeout(reportTools, 500));
