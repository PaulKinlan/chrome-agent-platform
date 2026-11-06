// lib/pure-webmcp.js — the WebMCP status/snapshot seam (lifecycle states, error
// bounding, the discovery-snapshot gate and ordering, invocation-tab planning).
// Extracted from lib/pure.js by chrome-agent-platform-ux4ud; pure.js re-exports it.
/** The exact message types a page's content script is allowed to route. */
// The exact message types a page's content script is allowed to route.
// NOTE: approval is an OWNER security decision and stays extension-only — a
// content script must NEVER be able to approve its own page tools.
export const PAGE_ALLOWED_ROUTES = new Set([
  "webmcp.detect.bootstrap", // extension-private key delivery for passive detection
  "webmcp.detect.arm", // arms the exact MAIN-world document after the relay has its key
  "webmcp.detected", // detection-only capability snapshot; sender origin is browser-derived
  "tools.list",
  "tools.upsert",
  "tools.pending",
  "enrollment.status", // read-only: a freshly-injected bridge syncs the enrollment generation for ITS OWN origin (sender-derived)
]);

// ── WebMCP status bounding + discovery-snapshot ordering (pure, testable) ──
// The SW-attested lifecycle (script registration/injection) is kept STRICTLY
// separate from page-reported tool data: a page can report tools, but it can
// never write the attested lifecycle fields — page reports land in a labeled
// `lastReport` section only.

/** The closed set of SW-attested script lifecycle states. Anything else is
 * coerced to "injection-error" so a caller can never inject a fabricated
 * status string into the attested record. */
export const WEBMCP_SCRIPT_STATUSES = new Set([
  "none",
  "registered",
  "no-open-tabs",
  "no-scripting-permission",
  "injected",
  "injection-partial",
  "injection-failed",
  "injection-error",
]);

// The ONE diagnostics error bound — a UTF-16 CODE-UNIT bound (JS string
// length semantics; NOT a UTF-8 byte bound and NOT a code-point count).
// The persisted cap:webmcpStatus error is bounded in code units.
export const WEBMCP_ERROR_BOUND = 240;

/** Bound a lifecycle error to WEBMCP_ERROR_BOUND UTF-16 code units. The slice
 * is SURROGATE-SAFE: if the truncation would leave a lone high surrogate as
 * the final code unit, that unit is dropped too (a malformed pair must never
 * be persisted). */
export function boundWebmcpError(e, max = WEBMCP_ERROR_BOUND) {
  if (e == null) return null;
  const text = String(e);
  if (text.length <= max) return text;
  const sliced = text.slice(0, max);
  const last = sliced.charCodeAt(sliced.length - 1);
  const drops = last >= 0xd800 && last <= 0xdbff ? 1 : 0;
  return sliced.slice(0, sliced.length - drops);
}

/** Clamp a count to a sane non-negative integer (page-reported counts are
 * untrusted). */
export function clampToolCount(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return 0;
  return Math.min(Math.floor(v), 100000);
}

/** Build the PAGE-REPORTED section of the status record from the SANITIZED
 * (bounded) tool descriptors the SW accepted — never from the raw page
 * payload, so out-of-bounds descriptors cannot inflate the status. */
export function buildWebmcpPageReport(tools, at = Date.now()) {
  const list = Array.isArray(tools) ? tools : [];
  return {
    at,
    declaredCount: clampToolCount(list.filter((t) => t?.source === "declared").length),
    inferredCount: clampToolCount(list.filter((t) => t?.source === "inferred").length),
    toolCount: clampToolCount(list.length),
    toolNames: list
      .map((t) => String(t?.name ?? "").slice(0, 128))
      .filter(Boolean)
      .slice(0, 50),
  };
}

/** Merge an SW-ATTESTED lifecycle patch into the status record. Only the
 * service worker calls this; a page report can never masquerade as an
 * attested lifecycle state. A lifecycle record for a DIFFERENT origin drops
 * the previous origin's page report (the record is a single latest slot). */
export function applyWebmcpLifecycle(prev, patch, at = Date.now()) {
  const origin = String(patch?.origin ?? "");
  const status = WEBMCP_SCRIPT_STATUSES.has(patch?.scriptStatus)
    ? patch.scriptStatus
    : "injection-error";
  const sameOrigin = prev && prev.origin === origin;
  return {
    origin,
    at,
    scriptStatus: status,
    scriptStatusAt: at,
    scriptError: boundWebmcpError(patch?.error),
    injection: patch?.injection ?? null,
    lastReport: sameOrigin ? prev.lastReport ?? null : null,
  };
}

/** Merge a PAGE-REPORTED tool snapshot into the status record. Never touches
 * the SW-attested lifecycle fields. */
export function applyWebmcpPageReport(prev, origin, report) {
  const sameOrigin = prev && prev.origin === origin;
  const base = sameOrigin
    ? prev
    : {
        origin,
        at: report.at,
        scriptStatus: "none",
        scriptStatusAt: null,
        scriptError: null,
        injection: null,
        lastReport: null,
      };
  return { ...base, at: report.at, lastReport: report };
}

/** Summarize per-tab per-role injection results. A tab is READY only when BOTH
 * the MAIN-world and the ISOLATED-world script injected; exactly one world
 * succeeding is a PARTIAL (the bridge without MAIN discovers nothing, MAIN
 * without the bridge reports nowhere) and must be surfaced, never counted as
 * success. */
export function summarizeInjection(results) {
  const list = Array.isArray(results) ? results : [];
  const ready = [];
  const partial = [];
  const failed = [];
  for (const r of list) {
    const main = r?.main === true;
    const bridge = r?.bridge === true;
    if (main && bridge) {
      ready.push(r.tabId);
    } else if (!main && !bridge) {
      failed.push({ tabId: r?.tabId ?? null, error: boundWebmcpError(r?.error) });
    } else {
      partial.push({
        tabId: r?.tabId ?? null,
        missing: [main ? null : "main", bridge ? null : "bridge"].filter(Boolean),
      });
    }
  }
  const scriptStatus = list.length === 0
    ? "no-open-tabs"
    : partial.length === 0 && failed.length === 0
      ? "injected"
      : ready.length === 0
        ? "injection-failed"
        : "injection-partial";
  return { targets: list.length, ready, partial, failed, scriptStatus };
}

// ── Discovery-snapshot ordering: origin / tab / document / navigation epoch ──
// The round-30 blocker: the old gate accepted ANY new random session id
// unconditionally, so a late report from an older session — or from a SECOND
// same-origin tab — could replace a newer snapshot. The gate is now keyed by
// the origin and ordered by BROWSER-ATTESTED identity the page cannot forge:
// the service worker derives `tabId` + `documentId` from the message SENDER
// (never from the message body) and assigns a MONOTONIC navigation epoch per
// origin. A snapshot is accepted only from the bound tab's CURRENT document
// with an advancing per-document sequence.

/** The empty per-origin snapshot gate. `maxEpoch` is monotonic and survives
 * re-enrollment seeding, so a navigation epoch is never reissued. */
export function emptySnapshotGate() {
  return { tabId: null, documentId: null, epoch: -1, maxEpoch: -1, seq: -1 };
}

function validTabId(tabId) {
  return typeof tabId === "number" && Number.isInteger(tabId) && tabId >= 0;
}
function validDocumentId(documentId) {
  return typeof documentId === "string" && documentId.length > 0 && documentId.length <= 128;
}
function validSeq(seq) {
  return typeof seq === "number" && Number.isInteger(seq) && seq >= 0 && seq <= 1e9;
}

/** Seed/rebind the gate at (re-)enrollment. A picker-approved tab becomes the
 * ONLY tab whose reports are accepted (`pickedTabId`); a null pick leaves the
 * gate unbound so the first reporting tab binds. `maxEpoch` is preserved — a
 * re-enrollment must never reissue a stale navigation epoch. */
export function seedSnapshotGate(prev, pickedTabId) {
  const maxEpoch = Number.isInteger(prev?.maxEpoch) ? prev.maxEpoch : -1;
  return {
    tabId: validTabId(pickedTabId) ? pickedTabId : null,
    documentId: null,
    epoch: -1,
    maxEpoch,
    seq: -1,
  };
}

/** A bridge startup sync observed a document on a tab. Advances the gate to
 * that document with a fresh monotonic epoch when the document is NEW on the
 * bound tab (a navigation). Returns { gate, bound } — `bound` is false when
 * the sender is NOT the authoritative tab (a second same-origin tab never
 * displaces the bound tab's document). Pure. */
export function syncSnapshotDocument(prev, tabId, documentId) {
  const gate = prev ?? emptySnapshotGate();
  if (!validTabId(tabId) || !validDocumentId(documentId)) {
    return { gate, bound: false };
  }
  if (gate.tabId == null) {
    const epoch = gate.maxEpoch + 1;
    return { gate: { tabId, documentId, epoch, maxEpoch: epoch, seq: -1 }, bound: true };
  }
  if (tabId !== gate.tabId) return { gate, bound: false };
  if (documentId === gate.documentId) return { gate, bound: true };
  const epoch = gate.maxEpoch + 1;
  return { gate: { tabId, documentId, epoch, maxEpoch: epoch, seq: -1 }, bound: true };
}

/** Accept a complete replacement snapshot ONLY from the current
 * (tab, document, epoch) with an advancing per-document sequence. `report` is
 * { tabId, documentId, epoch, seq } where tabId/documentId are
 * SENDER-DERIVED by the service worker and `epoch` is the epoch the SW issued
 * to that document at its startup sync (echoed by the bridge — a stale
 * document can only echo its own older epoch and is rejected). Returns
 * { accept, gate }. Pure. */
export function acceptToolSnapshot(prev, report) {
  const gate = prev ?? emptySnapshotGate();
  const { tabId, documentId, epoch, seq } = report ?? {};
  if (!validTabId(tabId) || !validDocumentId(documentId) || !validSeq(seq)) {
    return { accept: false, gate };
  }
  // Snapshot reports NEVER establish identity. Only enrollment.status from an
  // active, browser-attested document may bind/advance the gate through
  // syncSnapshotDocument; otherwise a report that raced startup could choose
  // its own identity/epoch.
  if (gate.tabId == null || gate.documentId == null || gate.epoch < 0) {
    return { accept: false, gate };
  }
  if (tabId !== gate.tabId) {
    return { accept: false, gate }; // a second same-origin tab never replaces
  }
  if (documentId !== gate.documentId) {
    return { accept: false, gate }; // a stale document's late report
  }
  if (epoch !== gate.epoch) {
    return { accept: false, gate }; // a wrong/older navigation epoch
  }
  if (seq <= gate.seq) {
    return { accept: false, gate }; // a same-document replay/stale sequence
  }
  return { accept: true, gate: { ...gate, seq } };
}

/** The page-identity seam: whether a tab matches the invocation target.
 * `targetIdentity` is { origin } today (origin equality); the page-scoped
 * identity lane refines it to { origin, path } without touching the SW flow. */
export function matchesPageIdentity(tab, targetIdentity) {
  const t = tab && typeof tab === "object" ? tab : null;
  const target = targetIdentity && typeof targetIdentity === "object" ? targetIdentity : null;
  if (!t || !target) return false;
  if (typeof target.origin !== "string" || !target.origin) return false;
  const tabUrl = typeof t.url === "string" ? t.url : "";
  if (!tabUrl) return false;
  let tabOrigin;
  try {
    const u = new URL(tabUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    tabOrigin = u.origin;
  } catch {
    return false;
  }
  if (tabOrigin !== target.origin) return false;
  if (typeof target.path === "string" && target.path) {
    try {
      const p = new URL(tabUrl).pathname || "/";
      return p === target.path;
    } catch {
      return false;
    }
  }
  return true;
}

/** Pure planner for the invocation tab (CAP-FB-20260824-WEBMCP-EXECUTION-01 /
 * CAP-FB-20260824-WEBMCP-PAGE-IDENTITY-01): the bound tab's binding is resolved
 * if its tab is alive and matches the target identity (origin + optional path);
 * otherwise the planner prefers the active same-identity tab, then the lowest
 * tabId, deterministically. When opening a new tab for a page-scoped tool, the
 * exact page URL is used. Never invents a candidate. */
export function planWebmcpInvocationTab({ canonical, path = null, pageUrl = null, binding, tabs }) {
  if (typeof canonical !== "string" || !canonical) return { kind: "open", url: canonical };
  const list = Array.isArray(tabs) ? tabs : [];
  let targetPath = path;
  if (!targetPath && pageUrl) {
    try { targetPath = new URL(pageUrl).pathname || "/"; } catch { targetPath = null; }
  }
  const target = targetPath ? { origin: canonical, path: targetPath } : { origin: canonical };
  // The BOUND tab: alive and still on the origin/page → the current path.
  if (binding && typeof binding === "object" && typeof binding.tabId === "number") {
    const bound = list.find((t) => t?.id === binding.tabId);
    if (bound && matchesPageIdentity(bound, target)) {
      return {
        kind: "bound",
        tabId: binding.tabId,
        documentId: typeof binding.documentId === "string" ? binding.documentId : "",
      };
    }
  }
  // Reuse an existing matching tab: the ACTIVE one first, else the lowest id.
  const matching = list.filter((t) => t && typeof t.id === "number" && matchesPageIdentity(t, target));
  if (matching.length) {
    const active = matching.find((t) => t?.active === true);
    const pick = active ?? matching.slice().sort((a, b) => a.id - b.id)[0];
    return { kind: "reuse", tabId: pick.id };
  }
  const openUrl = pageUrl || (targetPath && targetPath !== "/" ? `${canonical}${targetPath.startsWith("/") ? targetPath : `/${targetPath}`}` : canonical);
  return { kind: "open", url: openUrl };
}

/** The deliberate re-bind transition (mirrors seedSnapshotGate): replaces a
 * DEAD binding so the resolved tab's bridge re-binds through the existing
 * enrollment.status → tools.upsert flow. `maxEpoch` is preserved (never
 * reissue a stale epoch). NEVER displaces a live binding (the caller proves
 * dead/absent first — the round-30 fence). Pure. */
export function rebindSnapshotGate(prev, tabId) {
  if (!validTabId(tabId)) return prev ?? emptySnapshotGate();
  const maxEpoch = Number.isInteger(prev?.maxEpoch) ? prev.maxEpoch : -1;
  return { tabId, documentId: null, epoch: -1, maxEpoch, seq: -1 };
}

/** Parse an omnibox-entered string into an intent.
 *  - "skill:<id>"   → { kind: "skill", id }
 *  - "recipe:<id>"  → { kind: "recipe", id }  (legacy mint, parsed for compat)
 *  - "thread:<id>"  → { kind: "thread", id }
 *  - anything else   → { kind: "run", query } (the raw text is a task)
 *  Empty/whitespace → { kind: "none" }. */
export function parseOmniboxContent(content) {
  const c = String(content ?? "").trim();
  if (!c) return { kind: "none" };
  if (c.startsWith("skill:")) return { kind: "skill", id: c.slice("skill:".length).trim() };
  if (c.startsWith("recipe:")) return { kind: "recipe", id: c.slice("recipe:".length).trim() };
  if (c.startsWith("thread:")) return { kind: "thread", id: c.slice("thread:".length).trim() };
  return { kind: "run", query: c };
}
