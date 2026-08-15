// lib/pure.js — pure, dependency-free helpers (no chrome.*, no AI SDK) so the
// security-critical logic can be unit-tested in Deno without a browser.

/** Convert a reviewed JSON-schema descriptor into a bounded zod schema. */
export function schemaToZod(z, schema) {
  if (!schema || typeof schema !== "object") return z.record(z.any());
  const t = schema.type;
  if (t === "string") return z.string();
  if (t === "number") return z.number();
  if (t === "integer") return z.number().int();
  if (t === "boolean") return z.boolean();
  if (t === "array") return z.array(schemaToZod(z, schema.items)).max(100);
  if (t === "object") {
    const props = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
    const required = Array.isArray(schema.required) ? new Set(schema.required) : new Set();
    const shape = {};
    for (const [key, sub] of Object.entries(props)) {
      const subZod = schemaToZod(z, sub);
      shape[key] = required.has(key) ? subZod : subZod.optional();
    }
    return z.object(shape).passthrough();
  }
  return z.record(z.any());
}

/** Sanitize a tool name to a valid AI-SDK tool id (no URL punctuation). */
export function sanitizeToolName(origin, name) {
  const safe = String(name).replace(/[^a-zA-Z0-9_-]/g, "_");
  return `site_${safe}`;
}

/**
 * Classify a runtime message sender + derive/validate the tool-report origin.
 * Pure: takes a sender-shaped object, returns a decision. This is the sender
 * authorization boundary — a content script may only report tools for ITS OWN
 * page origin, never a message-supplied one.
 *
 * Returns: { kind: "content-script"|"extension"|"unmatched", origin?, error? }
 */
export function authorizeToolReport(sender, messageOrigin, canonicalOrigin, extensionId) {
  const senderUrl = sender?.url ?? "";
  const senderTabUrl = sender?.tab?.url ?? "";
  const isContentScript = Boolean(
    sender?.id === extensionId &&
    senderTabUrl &&
    !senderUrl.startsWith("chrome-extension://") &&
    !senderUrl.startsWith("moz-extension://") &&
    sender?.frameId === 0,
  );
  if (!isContentScript) {
    // A non-top-frame or unmatched page sender must not report tools.
    if (!senderUrl.startsWith("chrome-extension://") && senderTabUrl) {
      return { kind: "unmatched", error: "tool reports must come from the page's top frame" };
    }
    return { kind: "extension" };
  }
  const senderOrigin = canonicalOrigin(senderTabUrl);
  if (!senderOrigin) return { kind: "content-script", error: "invalid sender origin" };
  if (messageOrigin && canonicalOrigin(messageOrigin) !== senderOrigin) {
    return { kind: "content-script", error: "origin mismatch — tool report rejected" };
  }
  return { kind: "content-script", origin: senderOrigin };
}
