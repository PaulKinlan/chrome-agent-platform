// A bounded, declared-only read of one Chrome-attested attached document.
// Importing this module does NOT publish descriptors or create a callable tool.
import { fenceUntrustedText, isUntrustedToken } from "./untrusted-fence.js";

const MAX_TOOLS = 64;
const MAX_NAME = 128;
const MAX_DESCRIPTION_BYTES = 2048;
const MAX_SCHEMA_BYTES = 8192;
const MAX_TOTAL_BYTES = 65536;
const MAX_DOCUMENT_ID = 200;
const NAME_RE = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;
const encoder = new TextEncoder();
const empty = () => Object.freeze([]);
const bytes = (value) => encoder.encode(value).byteLength;

/** A self-contained Chrome MAIN-world injection function. No closure/module
 * symbols are available when Chrome serializes `func`; do not read page JS
 * globals or `modelContext.tools` as a fallback. The getTools return value
 * is still UNTRUSTED page content, never an invocation authority. */
export async function readDeclaredWebmcpFromPage() {
  let timer;
  try {
    const mc = document.modelContext;
    if (!mc || typeof mc.getTools !== "function") return [];
    const result = await Promise.race([
      Promise.resolve().then(() => mc.getTools()),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("getTools timeout")), 3000); }),
    ]);
    let tools;
    if (Array.isArray(result)) tools = result;
    else if (result && typeof result.values === "function" &&
      typeof result.entries === "function" && typeof result.get === "function") {
      tools = [];
      for (const value of result.values()) {
        if (tools.length >= 64) return [];
        tools.push(value);
      }
    } else if (result && typeof result === "object") {
      const keys = Object.keys(result);
      if (keys.length > 64) return [];
      tools = keys.map((key) => result[key]);
    } else return [];
    if (tools.length > 64) return [];
    const out = [];
    let size = 0;
    for (const tool of tools) {
      if (!tool || typeof tool.name !== "string" || typeof tool.description !== "string") return [];
      const name = tool.name;
      const description = tool.description;
      const schema = tool.inputSchema == null
        ? '{"type":"object","properties":{}}'
        : typeof tool.inputSchema === "string" ? tool.inputSchema : JSON.stringify(tool.inputSchema);
      if (typeof schema !== "string" || name.length > 128 || description.length > 2048 ||
        schema.length > 8192) return [];
      size += name.length + description.length * 3 + schema.length * 3;
      if (size > 65536) return [];
      out.push({ name, description, inputSchema: schema, source: "declared" });
    }
    return out;
  } catch { return []; }
  finally { if (timer) clearTimeout(timer); }
}

function sameTopFrame(results, documentId, read = false) {
  if (!Array.isArray(results) || results.length !== 1) return null;
  const frame = results[0];
  if (frame?.frameId !== 0 || frame.documentId !== documentId ||
    (!read && frame.result !== true)) return null;
  return frame;
}

function validOrigin(value) {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.origin === value;
  } catch { return false; }
}

/**
 * The caller must supply Chrome-owned getTab/executeScript/permission operations
 * and a live in-process run guard. `executeTopFrame(tabId, 'attest'|'read')`
 * performs ISOLATED true probes before/after and the self-contained MAIN-world
 * `readDeclaredWebmcpFromPage` between them. Every await rechecks run authority;
 * read-back documentId and URL are Chrome-owned, never page text.
 */
export async function readAttachedDeclaredWebmcpTools(binding, {
  getTab, executeTopFrame, livePermission, runActive,
} = {}) {
  const { origin, tabId, documentId } = binding ?? {};
  if (!validOrigin(origin) || !Number.isSafeInteger(tabId) || tabId < 0 ||
    typeof documentId !== "string" || !documentId || documentId.length > MAX_DOCUMENT_ID ||
    typeof getTab !== "function" || typeof executeTopFrame !== "function" ||
    typeof livePermission !== "function" || typeof runActive !== "function") return empty();
  try {
    if (!runActive() || !await livePermission(origin, tabId) || !runActive()) return empty();
    const before = await getTab(tabId);
    if (!runActive() || before?.id !== tabId || new URL(before.url).origin !== origin) return empty();
    if (!sameTopFrame(await executeTopFrame(tabId, "attest"), documentId) || !runActive()) return empty();
    const read = sameTopFrame(await executeTopFrame(tabId, "read"), documentId, true);
    if (!read || !runActive() || !Array.isArray(read.result) || read.result.length > MAX_TOOLS) return empty();
    const after = await getTab(tabId);
    if (!runActive() || after?.id !== tabId || new URL(after.url).origin !== origin) return empty();
    if (!sameTopFrame(await executeTopFrame(tabId, "attest"), documentId) || !runActive() ||
      !await livePermission(origin, tabId) || !runActive()) return empty();

    const seen = new Set();
    const descriptors = [];
    let total = 0;
    for (const tool of read.result) {
      if (!tool || tool.source !== "declared" || typeof tool.name !== "string" ||
        !tool.name || tool.name.length > MAX_NAME || !NAME_RE.test(tool.name) || seen.has(tool.name) ||
        typeof tool.description !== "string") return empty();
      const schemaText = tool.inputSchema;
      if (typeof schemaText !== "string" || bytes(tool.description) > MAX_DESCRIPTION_BYTES ||
        bytes(schemaText) > MAX_SCHEMA_BYTES) return empty();
      let inputSchema;
      try { inputSchema = JSON.parse(schemaText); } catch { return empty(); }
      if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema) ||
        (inputSchema.type !== undefined && inputSchema.type !== "object")) return empty();
      total += bytes(tool.name) + bytes(tool.description) + bytes(schemaText);
      if (total > MAX_TOTAL_BYTES) return empty();
      seen.add(tool.name);
      descriptors.push(Object.freeze({ origin, name: tool.name,
        description: tool.description, inputSchema, source: "declared" }));
    }
    return Object.freeze(descriptors);
  } catch { return empty(); } // navigation, permission revocation, malformed page data
}

/** ONLY this fenced projection may become model-facing later. The registry and
 * passive chip remain count-only; no call site is wired until the D1/D3 gate. */
export function projectAttachedDeclaredToolsForModel(descriptors, token) {
  if (!isUntrustedToken(token) || !Array.isArray(descriptors) || descriptors.length > MAX_TOOLS) return empty();
  return Object.freeze(descriptors.map((tool) => fenceUntrustedText(JSON.stringify({
    origin: tool.origin, name: tool.name, description: tool.description,
    inputSchema: tool.inputSchema, source: "declared",
  }), token)));
}
