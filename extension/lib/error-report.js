// lib/error-report.js — comprehensive, understandable, actionable errors.
//
// Paul 2026-08-17: "No output generated. Check the stream for errors" is
// useless — there is no way to check the stream, and the wrapper hides the
// actual cause. Every error the system surfaces must unwrap the AI SDK
// wrapper, extract the UNDERLYING reason (the API status/body, the network
// error, the provider message), categorize it, and say WHAT TO DO.
//
// MV3-CSP-safe: no eval / new Function. Defensive: this module never throws —
// a malformed error falls back to a generic but still-actionable description.

import { safeProviderError } from "./pure.js";

/** Error categories — a stable tag the UI can style + group. */
export const ERROR_CATEGORY = {
  NETWORK: "network",
  HOST_PERMISSION: "host-permission",
  AUTH: "provider-auth",
  RATE_LIMIT: "provider-rate-limit",
  SERVER: "provider-server",
  MODEL_CONFIG: "model-config",
  NO_OUTPUT: "model-no-output",
  TOOL: "tool-failure",
  PERMISSION: "permission",
  TIMEOUT: "timeout",
  ABORTED: "aborted",
  UNKNOWN: "unknown",
};

const ACTION = {
  [ERROR_CATEGORY.NETWORK]: "Check your network connection, then retry.",
  [ERROR_CATEGORY.HOST_PERMISSION]:
    'Grant network access in Settings — click "Use" or "Test connection" on the provider (the extension needs host permission for the provider URL).',
  [ERROR_CATEGORY.AUTH]:
    "Check the API key in Settings — it is missing, invalid, or revoked.",
  [ERROR_CATEGORY.RATE_LIMIT]:
    "The provider is rate-limiting you — wait a moment and retry (or check your plan's limits).",
  [ERROR_CATEGORY.SERVER]:
    "The provider's servers are having an issue — retry in a moment.",
  [ERROR_CATEGORY.MODEL_CONFIG]:
    "Check the model id in Settings — it may not exist for this provider.",
  [ERROR_CATEGORY.NO_OUTPUT]:
    "The model returned no content (possibly overloaded, or the prompt/tool loop stopped early) — retry, or try a different model.",
  [ERROR_CATEGORY.TOOL]:
    "A tool call failed — check the tool's arguments and the permissions it needs.",
  [ERROR_CATEGORY.PERMISSION]:
    "A required permission is not granted — enable it in Settings.",
  [ERROR_CATEGORY.TIMEOUT]:
    "The request timed out — retry, or the provider is slow right now.",
  [ERROR_CATEGORY.ABORTED]:
    "The run was cancelled.",
  [ERROR_CATEGORY.UNKNOWN]:
    "Something went wrong — see the detail below.",
};

/** Extract the deepest cause message from an Error's `cause` chain. */
function causeMessage(e, depth = 0) {
  if (!e || depth > 4) return "";
  const c = e.cause;
  if (!c) return "";
  if (typeof c === "string") return c;
  if (c instanceof Error || (typeof c === "object" && c !== null)) {
    const m = c.message || c.reason || "";
    const deeper = causeMessage(c, depth + 1);
    return deeper || m;
  }
  return "";
}

/** Parse a provider JSON error body into a short, readable reason. */
function parseResponseBody(body) {
  if (!body) return "";
  if (typeof body === "string") {
    try {
      const j = JSON.parse(body);
      const msg =
        j?.error?.message ||
        j?.message ||
        j?.error?.code ||
        j?.code ||
        "";
      return String(msg ?? "");
    } catch {
      // Not JSON — use a trimmed raw slice (never the full body; it may be huge).
      return body.slice(0, 300);
    }
  }
  if (typeof body === "object") {
    const msg = body?.error?.message || body?.message || body?.error?.code || body?.code || "";
    return String(msg ?? "");
  }
  return String(body).slice(0, 300);
}

/** The AI SDK markers (vercel.ai.error.*). */
function isAiSdkError(e) {
  if (!e || typeof e !== "object") return false;
  return typeof e.message === "string" && /^\[?AI_/i.test(e.message || e.name || "");
}

/**
 * Unwrap the AI SDK wrapper + produce a comprehensive description.
 *
 * Returns:
 *   { category, reason, action, message, detail }
 * - category: a stable ERROR_CATEGORY tag.
 * - reason: the underlying cause, human-readable (e.g. "the provider returned
 *   401 (invalid API key)").
 * - action: what the user should DO.
 * - message: a single-line summary for the console + thread preview.
 * - detail: the full context (status, body, url, model) for the expandable view.
 */
export function describeError(error, context = {}) {
  const e = error;
  const name = e?.name || (e instanceof Error ? "Error" : "");
  const raw = String(e?.message ?? e ?? "unknown error");
  const ctx = context || {};
  const provider = ctx.provider || "";
  const model = ctx.model || "";
  const tool = ctx.tool || "";
  const cause = causeMessage(e);

  // Build a detail bag once.
  const detailParts = [];
  if (provider) detailParts.push(`provider: ${provider}`);
  if (model) detailParts.push(`model: ${model}`);
  if (tool) detailParts.push(`tool: ${tool}`);
  if (e?.url) detailParts.push(`url: ${e.url}`);
  if (e?.statusCode != null) detailParts.push(`status: ${e.statusCode}`);
  const body = parseResponseBody(e?.responseBody ?? e?.data?.responseBody ?? "");
  if (body) detailParts.push(`body: ${body}`);

  // 0. The provider RUN GATE refusal (ProviderUnavailableError) — the
  //    host permission for the provider origin is not granted. This is the
  //    HOST_PERMISSION category (the UI shows a "Grant network access"
  //    button), NOT the generic PERMISSION/NETWORK category. Check FIRST so
  //    the gate's "not granted" phrasing never falls through to NETWORK.
  if (
    e?.name === "ProviderUnavailableError" ||
    /network access to the provider .* is not granted/i.test(raw)
  ) {
    return build(
      ERROR_CATEGORY.HOST_PERMISSION,
      provider
        ? `network access to ${provider} is not granted`
        : (raw || "the provider host permission is not granted"),
      ACTION[ERROR_CATEGORY.HOST_PERMISSION],
      raw,
      detailParts,
    );
  }

  // 1. Host-permission / network (the "Failed to fetch" class).
  if (/failed to fetch/i.test(raw + " " + cause) || /networkerror/i.test(raw + " " + cause)) {
    const reason = provider
      ? `could not reach ${provider} (a network request failed)`
      : "a network request failed";
    return build(ERROR_CATEGORY.NETWORK, reason, ACTION[ERROR_CATEGORY.NETWORK],
      raw, [...detailParts, "cause: the provider fetch could not complete (network offline, or the provider host permission is not granted)"]);
  }

  // 2. RetryError → unwrap the lastError (the underlying API error).
  if (/AI_RetryError/i.test(name + " " + raw) && e?.lastError) {
    const inner = describeError(e.lastError, context);
    return build(inner.category, inner.reason, inner.action,
      `retried and still failed: ${inner.reason}`, [...detailParts, inner.detail]);
  }

  // 3. APICallError → the status code + the provider's response body.
  const sc = e?.statusCode;
  if (/AI_APICallError/i.test(name) || (sc != null && isAiSdkError(e))) {
    let reason = body
      ? `the provider returned ${sc ?? ""} ${sc ? `(${body})` : body}`.trim()
      : `the provider returned ${sc ?? "an error"}`;
    if (cause && !body) reason += ` (${cause})`;
    if (sc === 401 || sc === 403) {
      return build(ERROR_CATEGORY.AUTH, reason, ACTION[ERROR_CATEGORY.AUTH], raw, detailParts);
    }
    if (sc === 429) {
      return build(ERROR_CATEGORY.RATE_LIMIT, reason, ACTION[ERROR_CATEGORY.RATE_LIMIT], raw, detailParts);
    }
    if (sc >= 500) {
      return build(ERROR_CATEGORY.SERVER, reason, ACTION[ERROR_CATEGORY.SERVER], raw, detailParts);
    }
    if (sc === 400 || sc === 404) {
      return build(ERROR_CATEGORY.MODEL_CONFIG, reason, ACTION[ERROR_CATEGORY.MODEL_CONFIG], raw, detailParts);
    }
    return build(ERROR_CATEGORY.SERVER, reason, ACTION[ERROR_CATEGORY.SERVER], raw, detailParts);
  }

  // 4. No-output / no-content / empty-response — the model produced nothing.
  if (/AI_NoOutputGeneratedError|AI_NoContentGeneratedError|AI_EmptyResponseBodyError|no output generated|no content generated|check the stream/i.test(name + " " + raw)) {
    const reason = model
      ? `the model (${model}) returned no content`
      : "the model returned no content";
    return build(ERROR_CATEGORY.NO_OUTPUT, reason, ACTION[ERROR_CATEGORY.NO_OUTPUT],
      raw, [...detailParts, "cause: the provider sent an empty/terminated stream (the model may be overloaded, the prompt may have stopped early, or a tool loop ended without a final answer)"]);
  }

  // 5. Explicitly categorized by raw text (covers wrapped messages).
  const low = (raw + " " + cause).toLowerCase();
  if (/unauthorized|invalid api key|invalid.*key|api key|401|403|authentication|credential/i.test(low)) {
    return build(ERROR_CATEGORY.AUTH, raw || "authentication failed", ACTION[ERROR_CATEGORY.AUTH], raw, detailParts);
  }
  if (/rate limit|too many|429|quota/i.test(low)) {
    return build(ERROR_CATEGORY.RATE_LIMIT, raw, ACTION[ERROR_CATEGORY.RATE_LIMIT], raw, detailParts);
  }
  if (/timeout|timed out|etimedout|408/i.test(low)) {
    return build(ERROR_CATEGORY.TIMEOUT, raw, ACTION[ERROR_CATEGORY.TIMEOUT], raw, detailParts);
  }
  if (/permission|not granted|denied/i.test(low)) {
    return build(ERROR_CATEGORY.PERMISSION, raw, ACTION[ERROR_CATEGORY.PERMISSION], raw, detailParts);
  }
  if (/abort|cancelled|canceled/i.test(low)) {
    return build(ERROR_CATEGORY.ABORTED, raw, ACTION[ERROR_CATEGORY.ABORTED], raw, detailParts);
  }
  if (/not found|unknown model|model.*not|invalid model/i.test(low)) {
    return build(ERROR_CATEGORY.MODEL_CONFIG, raw, ACTION[ERROR_CATEGORY.MODEL_CONFIG], raw, detailParts);
  }
  if (/failed to fetch|network|enotfound|econnrefused|dns/i.test(low)) {
    return build(ERROR_CATEGORY.NETWORK, raw, ACTION[ERROR_CATEGORY.NETWORK], raw, detailParts);
  }

  // 6. A tool failure (the run's lastTool is set + no provider marker).
  if (tool && !isAiSdkError(e)) {
    return build(ERROR_CATEGORY.TOOL, `${tool}: ${raw || "failed"}`, ACTION[ERROR_CATEGORY.TOOL], raw, detailParts);
  }

  // 7. Fallback.
  const reason = raw || "unknown error";
  return build(ERROR_CATEGORY.UNKNOWN, reason, ACTION[ERROR_CATEGORY.UNKNOWN], raw,
    detailParts.length ? detailParts : []);
}

function build(category, reason, action, message, detailParts) {
  // SECRET-SAFE CHOKE POINT (the final review's HIGH): EVERY describeError
  // output — reason/message/detail — is redacted (pattern-embedded
  // credentials: Bearer/Basic, URL passwords, key:value assignments) and
  // bounded BEFORE it leaves this module. These strings flow into route
  // responses, the console, thread messages, lastError storage, and
  // diagnostics — none of them may ever carry a credential a hostile endpoint
  // echoed into its error body/URL. Known-secret exact masking happens earlier
  // (the model adapter threads the configured key); this is the structural
  // backstop for everything else.
  const safe = (s) => safeProviderError(s);
  const safeUrl = (s) => {
    // URLs: keep scheme+host+path, mask any userinfo, DROP the query (a
    // reflected credential can hide in a query param).
    let out = safe(String(s ?? ""));
    try {
      const u = new URL(out);
      if (u.username) u.username = "[REDACTED]";
      if (u.password) u.password = "";
      u.search = "";
      out = u.toString();
    } catch { /* not a URL — already redacted above */ }
    return out;
  };
  const detail = detailParts
    .filter(Boolean)
    .map((p) => {
      const s = String(p);
      return /^url: /i.test(s) ? `url: ${safeUrl(s.slice(5))}` : safe(s);
    })
    .join(" · ");
  const safeReason = safe(reason || "");
  const safeAction = action || ACTION[ERROR_CATEGORY.UNKNOWN];
  return {
    category,
    reason: safeReason || "unknown",
    action: safeAction,
    message: safe(`${safeReason} — ${safeAction}`),
    detail,
  };
}

/** A one-line actionable summary (for console.error + the thread preview). */
export function formatError(error, context = {}) {
  const d = describeError(error, context);
  return `${d.category}: ${d.reason}. ${d.action}`;
}

/** The structured detail for the expandable thread/console error view. */
export function errorDetail(error, context = {}) {
  return describeError(error, context);
}
