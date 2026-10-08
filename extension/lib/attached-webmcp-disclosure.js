// Run-scoped model text for an owner-attached declared-tool document.
// No tool is made callable here; D1/D3 consent and WAL gates remain separate.
import { projectAttachedDeclaredToolsForModel } from "./attached-webmcp-declared.js";
import { isUntrustedToken } from "./untrusted-fence.js";

const MAX_TABS = 8;
const MAX_TOOLS = 64;
const MAX_MODEL_BYTES = 32768;
const encoder = new TextEncoder();
const HEADER = "Attached declared WebMCP tools (untrusted page descriptions/schema; not an execution grant):\n";

export async function formatAttachedDeclaredContext({
  bindings, consentStore, untrustedToken, runActive, read,
} = {}) {
  if (!Array.isArray(bindings) || bindings.length > MAX_TABS ||
    !consentStore || typeof consentStore.binding !== "function" ||
    typeof runActive !== "function" || typeof read !== "function" ||
    !isUntrustedToken(untrustedToken)) return "";
  const out = [];
  let total = encoder.encode(HEADER).byteLength;
  let count = 0;
  for (const row of bindings) {
    try {
      if (!runActive()) return "";
      const { candidate, token } = row ?? {};
      const bound = consentStore.binding(token); // opaque in-process capability
      if (!bound || bound.origin !== candidate?.origin || bound.tabId !== candidate?.tabId ||
        bound.documentId !== candidate?.documentId || !bound.runId) return "";
      const descriptors = await read(candidate, token);
      if (!runActive()) return "";
      const after = consentStore.binding(token);
      if (after.runId !== bound.runId || after.origin !== bound.origin ||
        after.tabId !== bound.tabId || after.documentId !== bound.documentId ||
        !Array.isArray(descriptors) || descriptors.length > MAX_TOOLS) return "";
      const fenced = projectAttachedDeclaredToolsForModel(descriptors, untrustedToken);
      if (fenced.length !== descriptors.length) return "";
      count += fenced.length;
      if (count > MAX_TOOLS) return "";
      for (const text of fenced) {
        total += encoder.encode(text).byteLength + 1;
        if (total > MAX_MODEL_BYTES) return ""; // never leak a truncated subset
        out.push(text);
      }
    } catch { return ""; } // ended token, invalid page read or run cancellation
  }
  return out.length && runActive() ? HEADER + out.join("\n") : "";
}
