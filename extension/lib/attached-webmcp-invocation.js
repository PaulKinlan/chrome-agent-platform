// D3 building block for a future consent-gated attached declared tool route.
// This file is NOT called from the Service Worker until D1 consent + required
// WAL are wired. It never arms the enrolled content-script bridge.
const NAME_RE = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;
const errorResult = (error) => Object.freeze({ ok: false, error });

/** Self-contained Chrome MAIN-world injection. `executeScript` serializes this
 * function WITHOUT module bindings. Target ONLY the exact Chrome documentId;
 * the page itself cannot attest a Chrome document ID. Never scan window
 * globals, retry a thrown call, or fall back to the inferred exposure list. */
export async function invokeAttachedDeclaredFromPage(name, args, expectedSchemaJson) {
  let timer;
  try {
    if (typeof name !== "string" || name.length > 128 ||
      !/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(name) ||
      !args || typeof args !== "object" || Array.isArray(args) ||
      typeof expectedSchemaJson !== "string" || new TextEncoder().encode(expectedSchemaJson).byteLength > 8192) {
      return { ok: false, error: "declared_tool_invalid" };
    }
    const mc = document.modelContext;
    if (!mc || typeof mc.getTools !== "function") return { ok: false, error: "declared_tool_unavailable" };
    const result = await Promise.race([
      Promise.resolve().then(() => mc.getTools()),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error("getTools timeout")), 3000); }),
    ]);
    let tools;
    if (Array.isArray(result)) tools = result;
    else if (result && typeof result.values === "function" &&
      typeof result.entries === "function" && typeof result.get === "function") {
      tools = [];
      for (const value of result.values()) {
        if (tools.length >= 64) return { ok: false, error: "declared_tool_unavailable" };
        tools.push(value);
      }
    } else if (result && typeof result === "object") {
      const keys = Object.keys(result);
      if (keys.length > 64) return { ok: false, error: "declared_tool_unavailable" };
      tools = keys.map((key) => result[key]);
    } else return { ok: false, error: "declared_tool_unavailable" };
    if (tools.length > 64) return { ok: false, error: "declared_tool_unavailable" };
    const matching = tools.filter((tool) => tool?.name === name);
    if (matching.length !== 1) return { ok: false, error: "declared_tool_unavailable" };
    const tool = matching[0];
    let schema = tool.inputSchema;
    if (schema == null) schema = { type: "object", properties: {} };
    if (typeof schema === "string") {
      if (new TextEncoder().encode(schema).byteLength > 8192) return { ok: false, error: "declared_tool_changed" };
      try { schema = JSON.parse(schema); } catch { return { ok: false, error: "declared_tool_changed" }; }
    }
    if (!schema || typeof schema !== "object" || Array.isArray(schema) ||
      (schema.type !== undefined && schema.type !== "object") ||
      JSON.stringify(schema) !== expectedSchemaJson) return { ok: false, error: "declared_tool_changed" };
    const jsonArgs = JSON.stringify(args);
    if (typeof jsonArgs !== "string" || new TextEncoder().encode(jsonArgs).byteLength > 8192) return { ok: false, error: "declared_tool_invalid" };
    let value;
    // One attempt ONLY: a thrown page handler may have already produced an
    // effect. The enrolled bridge's accepted retry-on-throw tradeoff must not
    // silently carry into this distinct unenrolled principal.
    if (typeof mc.executeTool === "function") value = await mc.executeTool(tool, jsonArgs);
    else if (typeof tool.execute === "function") value = await tool.execute(args);
    else return { ok: false, error: "declared_tool_unavailable" };
    const serialized = JSON.stringify(value ?? null);
    if (typeof serialized !== "string" || new TextEncoder().encode(serialized).byteLength > 16384) {
      return { ok: false, error: "declared_tool_result_unavailable" };
    }
    return { ok: true, result: JSON.parse(serialized) };
  } catch { return { ok: false, error: "declared_tool_result_unavailable" }; }
  finally { if (timer) clearTimeout(timer); }
}

/** Await the REQUIRED audit append before the ONLY page-effect call. Chrome
 * injects by documentIds (not frameIds) and returns Chrome-owned frameId/docId;
 * the caller must provide that exact-target implementation. The repeated
 * preflight after the awaited WAL covers navigation/reset while OPFS writes. */
export async function auditedAttachedDeclaredCall(binding, descriptor, args, {
  runActive, livePermission, getTab, attestTopFrame, requiredAudit, executeExactDocument,
} = {}) {
  const { origin, tabId, documentId } = binding ?? {};
  if (typeof origin !== "string" || !/^https?:\/\//.test(origin) ||
    !Number.isSafeInteger(tabId) || tabId < 0 ||
    typeof documentId !== "string" || !documentId || documentId.length > 200 ||
    descriptor?.origin !== origin || descriptor?.source !== "declared" ||
    typeof descriptor?.name !== "string" || !descriptor.name ||
    descriptor.name.length > 128 || !NAME_RE.test(descriptor.name) ||
    !descriptor.inputSchema || typeof descriptor.inputSchema !== "object" ||
    !args || typeof args !== "object" || Array.isArray(args) ||
    [runActive, livePermission, getTab, attestTopFrame, requiredAudit, executeExactDocument]
      .some((f) => typeof f !== "function")) return errorResult("attached_tool_invalid");
  const preflight = async () => {
    try {
      if (!runActive() || !await livePermission(origin, tabId) || !runActive()) return false;
      const tab = await getTab(tabId);
      if (!runActive() || tab?.id !== tabId || new URL(tab.url).origin !== origin) return false;
      const frame = await attestTopFrame(tabId);
      return runActive() && Array.isArray(frame) && frame.length === 1 &&
        frame[0]?.frameId === 0 && frame[0].documentId === documentId &&
        frame[0].result === true && await livePermission(origin, tabId) && runActive();
    } catch { return false; }
  };
  if (!await preflight()) return errorResult("attached_tool_authority_changed");
  try { await requiredAudit(binding, descriptor, args); }
  catch { return errorResult("site_tool_audit_unavailable"); }
  if (!await preflight()) return errorResult("attached_tool_authority_changed");
  let injected;
  try { injected = await executeExactDocument(tabId, documentId, descriptor.name,
    args, JSON.stringify(descriptor.inputSchema)); }
  catch { return errorResult("attached_tool_invoke_failed"); }
  if (!Array.isArray(injected) || injected.length !== 1 ||
    injected[0]?.frameId !== 0 || injected[0].documentId !== documentId ||
    !await preflight()) return errorResult("attached_tool_authority_changed");
  const result = injected[0].result;
  return result && typeof result === "object" && typeof result.ok === "boolean"
    ? result : errorResult("attached_tool_invoke_failed");
}
