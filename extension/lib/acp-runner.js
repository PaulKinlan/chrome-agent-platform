// extension/lib/acp-runner.js — Coordinates ACP harness task runs for the UI surfaces (NTP, Side Panel).
// CAP-FB-20260912-ACP-INTEGRATION-01 (tracking epic chrome-agent-platform-qlho)
//
// Drives an external agent harness (e.g. pi via pi-acp) over the loopback ACP WebSocket bridge,
// streaming thoughts, tool progress, and message chunks into the conversation surface.

import { AcpClient, acpAllowOptionId, acpDenyOptionId } from "./acp-client.js";
import { AcpNativeTransport, DEFAULT_NATIVE_HOST } from "./acp-native.js";


// ── CAP skill context on the harness turn (chrome-agent-platform-etdn) ──────
// Paul's directive: skills defined in CAP must reach the harness when a
// prompt calls them, and the composer's /skill: and @ pickers must be the
// entry. The composer inserts `/skill:<refId>` references; a harness run
// receives the raw text only — the harness has no idea what the skill says.
// So the turn payload carries a delimited skill-context block built from the
// Chrome skill store (skill.list rows are the FULL records: prompt body
// included), while the conversation keeps showing the owner's own text.

const SKILL_REF_RE = /\/skill:(builtin|imported|custom)?:?([A-Za-z0-9_-]+)/g;

/** The /skill:<refId> references in a prompt, deduped, in first-appearance
 *  order. Pure. */
export function extractSkillRefs(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(SKILL_REF_RE)) {
    const refId = `${m[1] ? m[1] + ":" : ""}${m[2]}`;
    if (!out.includes(refId)) out.push(refId);
  }
  return out;
}

/** Resolve /skill: references against the Chrome skill store (ONE skill.list
 *  read; rows are the full records — prompt body included). Unknown refs are
 *  skipped. `runtimeSend` is injectable for tests. */
export async function resolveSkillContext(text, { runtimeSend = null } = {}) {
  const refs = extractSkillRefs(text);
  if (!refs.length) return [];
  const send = runtimeSend ?? ((type, body) =>
    globalThis.chrome?.runtime?.sendMessage?.({ type, ...body }));
  const res = await send("skill.list", {}).catch(() => null);
  const rows = Array.isArray(res?.skills) ? res.skills : [];
  return refs
    .map((refId) => {
      const id = refId.includes(":") ? refId.split(":").slice(1).join(":") : refId;
      return rows.find((r) => r.refId === refId || r.id === id) ?? null;
    })
    .filter(Boolean)
    .map((r) => ({ refId: r.refId ?? r.id, name: r.name ?? r.id, description: r.description ?? "", prompt: r.prompt ?? "" }));
}

/** The harness turn payload: the skill context block, then the owner's own
 *  text. Unchanged when there is nothing to inject. Pure. */
export function buildPromptWithSkillContext(task, skills) {
  const list = Array.isArray(skills) ? skills.filter((s) => s && (s.prompt || s.description)) : [];
  if (!list.length) return String(task ?? "");
  const block = list.map((s) =>
    `<cap-skill ref="${s.refId}" name="${s.name}">\n` +
    (s.description ? `<description>${s.description}</description>\n` : "") +
    `<instructions>\n${s.prompt}\n</instructions>\n` +
    `</cap-skill>`
  ).join("\n");
  return `<cap-skills>\n${block}\n\n${String(task ?? "")}`;
}

/**
 * Extract browser/call_tool JSON-RPC blocks from model text output, and return
 * the cleaned display text with the raw tool-call JSON stripped. Pure.
 *
 * @param {string} rawText
 * @returns {{ calls: Array<{ id: string, name: string, args: Record<string, unknown>, raw: object }>, cleanText: string }}
 */
export function extractBrowserToolCalls(rawText) {
  const text = String(rawText ?? "");
  const calls = [];
  const removals = [];

  let searchIndex = 0;
  while (searchIndex < text.length) {
    const methodIdx = text.indexOf('"browser/call_tool"', searchIndex);
    if (methodIdx === -1) break;

    // Scan backwards to find the start of the JSON object
    let startIdx = -1;
    let depth = 0;
    for (let i = methodIdx; i >= 0; i--) {
      if (text[i] === "}") depth++;
      else if (text[i] === "{") {
        if (depth === 0) {
          startIdx = i;
          break;
        }
        depth--;
      }
    }

    if (startIdx === -1) {
      searchIndex = methodIdx + 19;
      continue;
    }

    // Scan forwards from startIdx to find the matching closing }
    let endIdx = -1;
    depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = startIdx; i < text.length; i++) {
      const ch = text[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            endIdx = i + 1;
            break;
          }
        }
      }
    }

    if (endIdx === -1) {
      searchIndex = methodIdx + 19;
      continue;
    }

    const jsonStr = text.slice(startIdx, endIdx);
    try {
      const parsed = JSON.parse(jsonStr);
      if (parsed && parsed.method === "browser/call_tool" && parsed.id !== undefined) {
        calls.push({
          id: String(parsed.id),
          name: String(parsed.params?.name ?? ""),
          args: parsed.params?.args ?? {},
          raw: parsed,
        });

        let removeStart = startIdx;
        let removeEnd = endIdx;

        // Check if wrapped in markdown code fence: ```(json)? ... ```
        const before = text.slice(0, startIdx);
        const fenceBeforeMatch = /```(?:json)?\s*$/i.exec(before);
        if (fenceBeforeMatch) {
          removeStart = before.length - fenceBeforeMatch[0].length;
          const after = text.slice(endIdx);
          const fenceAfterMatch = /^\s*```/.exec(after);
          if (fenceAfterMatch) {
            removeEnd = endIdx + fenceAfterMatch[0].length;
          }
        }

        removals.push({ start: removeStart, end: removeEnd });
        searchIndex = removeEnd;
        continue;
      }
    } catch {
      // not valid JSON
    }

    searchIndex = methodIdx + 19;
  }

  removals.sort((a, b) => b.start - a.start);
  let cleaned = text;
  for (const { start, end } of removals) {
    cleaned = cleaned.slice(0, start) + cleaned.slice(end);
  }
  cleaned = cleaned.replace(/\n\s*\n\s*\n/g, "\n\n").trim();

  return { calls, cleanText: cleaned };
}


/**
 * Browser tools that require in-conversation owner approval when called by a harness (chrome-agent-platform-f3n2).
 * Mirrors HARNESS_GATED_BROWSER_TOOLS in browser-tools.js without creating a direct module dependency.
 */
export const ACP_GATED_BROWSER_TOOLS = new Set([
  "close_tab",
  "close_window",
  "wipe_browsing_data",
  "remove_bookmark",
  "set_cookie",
  "remove_cookie",
  "write_file",
  "schedule_task",
  "get_cookie",
]);

/** Format the human-readable approval title and detail for an in-conversation approval card. */
export function formatBrowserToolApproval(name, args = {}) {
  switch (name) {
    case "close_tab":
      return {
        title: `Close browser tab #${args.tabId ?? ""}`,
        detail: `The external agent requested to close tab ${args.tabId ?? ""}.`,
      };
    case "close_window":
      return {
        title: `Close browser window #${args.windowId ?? ""}`,
        detail: `The external agent requested to close window ${args.windowId ?? ""}.`,
      };
    case "wipe_browsing_data":
      return {
        title: `Wipe browsing data (${Array.isArray(args.dataTypes) ? args.dataTypes.join(", ") : "all"})`,
        detail: "The external agent requested to wipe browsing data.",
      };
    case "remove_bookmark":
      return {
        title: `Remove bookmark #${args.id ?? ""}`,
        detail: `The external agent requested to delete bookmark ${args.id ?? ""}.`,
      };
    case "set_cookie":
      return {
        title: `Set cookie "${args.name ?? ""}" on ${args.url ?? ""}`,
        detail: `The external agent requested to set a cookie on ${args.url ?? ""}.`,
      };
    case "remove_cookie":
      return {
        title: `Remove cookie "${args.name ?? ""}" on ${args.url ?? ""}`,
        detail: `The external agent requested to remove a cookie from ${args.url ?? ""}.`,
      };
    case "write_file":
      return {
        title: `Write file "${args.path ?? ""}"`,
        detail: `The external agent requested to write to ${args.path ?? ""}.`,
      };
    case "schedule_task":
      return {
        title: `Schedule task: "${args.task ?? ""}"`,
        detail: "The external agent requested to schedule a future task.",
      };
    case "get_cookie":
      return {
        title: `Read cookie "${args.name ?? ""}" value`,
        detail: `The external agent requested to reveal cookie value on ${args.origin ?? ""}.`,
      };
    default:
      return {
        title: `Execute browser tool "${name}"`,
        detail: `The external agent requested to run ${name}.`,
      };
  }
}

/** Default loopback WebSocket endpoint for the ACP bridge */
export const DEFAULT_ACP_ENDPOINT = "ws://127.0.0.1:3210/acp";

/** Default working directory for summoned harness sessions. EMPTY by design:
 * the working directory is machine-specific, so it resolves HOST-side — the
 * bridge fills a session request that arrives without one ($HOME/journal, or
 * its --cwd). A machine path literal here would be wrong on every other
 * machine (3khn). */
export const DEFAULT_ACP_CWD = "";

/** ACP tool-call statuses mapped to the vocabulary a tool card RENDERS as
 * settled (`running` / `done` / `error`). pi-acp sends `in_progress` /
 * `completed` / `failed`; a card that only knows done/success/error would show
 * `completed` as still running forever. */
const TOOL_STATUS_UI = {
  pending: "running",
  in_progress: "running",
  running: "running",
  completed: "done",
  success: "done",
  failed: "error",
  cancelled: "error",
  canceled: "error",
};
export function acpToolStatusUi(status) {
  const key = String(status ?? "").trim().toLowerCase();
  return TOOL_STATUS_UI[key] ?? (key ? "running" : "running");
}

/** Append a bridge token to an ACP endpoint URL (idempotent, escaped). The
 * bridge's `--token` mode requires `?token=…` on the upgrade; the extension has
 * no settings UI yet, so the operator sets `acp.endpoint` / `acp.token` in kv
 * and this is the piece that carries them onto the wire. */
export function acpEndpointWithToken(endpoint, token) {
  const url = String(endpoint ?? "");
  const secret = String(token ?? "");
  if (!url || !secret) return url;
  if (/[?&]token=/.test(url)) return url; // already carries one
  return `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(secret)}`;
}

/** Append a harness ID to an ACP endpoint URL (idempotent, escaped).
 * The bridge supports per-session harness selection via `?harness=…`. */
export function acpEndpointWithHarness(endpoint, harnessId) {
  const url = String(endpoint ?? "");
  const harness = String(harnessId ?? "").trim();
  if (!url || !harness) return url;
  if (/[?&]harness=/.test(url)) return url; // already carries one
  return `${url}${url.includes("?") ? "&" : "?"}harness=${encodeURIComponent(harness)}`;
}

/** Derive the HTTP health URL for a given ACP WebSocket or HTTP endpoint. */
export function acpHealthUrl(endpoint) {
  const ep = String(endpoint ?? "").trim();
  if (!ep) return "";
  try {
    const url = new URL(ep);
    const protocol = url.protocol === "wss:" ? "https:" : "http:";
    return `${protocol}//${url.host}/health`;
  } catch {
    return "";
  }
}

/** Probe the ACP bridge /health endpoint, optionally probing a specific harness. */
export async function probeAcpBridgeHealth(endpoint = DEFAULT_ACP_ENDPOINT, harnessId = "") {
  const base = acpHealthUrl(endpoint);
  if (!base) return null;
  const url = harnessId ? `${base}?harness=${encodeURIComponent(harnessId)}` : base;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (res.ok) return await res.json();
  } catch { /* bridge down or unreachable */ }
  return null;
}

/** In-memory cache of active ACP sessions by conversation key. A key is the
 * task threadId + harness when the turn runs inside a persisted thread, else
 * `acp:<harnessId>` — so the dedicated harness surface and hub @mention
 * delegations keep ONE pi conversation across turns (pi-acp session/load
 * restores it from pi's on-disk session store even after the adapter process
 * is torn down between turns — proven live in cap-evidence/acp-resume-probe.ts).
 * A SURFACE (not this map) is the durable authority across reloads: the caller
 * passes a sessionStore (kv) and the resume hint is read back from it. */
const threadSessions = new Map();

/** The turn currently running per conversation key. Starting a second turn on
 * one key CANCELS the first before prompting: two concurrent prompts on one
 * host session would interleave on the same pi conversation. */
const activeTurns = new Map();

/**
 * Cancel an in-flight ACP turn for a conversation.
 * Sends `session/cancel` with the active sessionId over the wire to the harness,
 * marks the turn as stopped by the owner, and settles the turn.
 *
 * @param {string|{threadId?: string|null, harnessId?: string, key?: string}} [options]
 * @returns {Promise<{ok: boolean, error?: string, cancelledOnWire?: boolean, sessionId?: string|null}>}
 */
export async function cancelAcpTurn(options = {}) {
  const { threadId = null, harnessId = "pi", key = null } = typeof options === "string" ? { key: options } : options;
  const sessionKey = key || acpSessionKey(threadId, harnessId);
  const active = activeTurns.get(sessionKey);
  if (!active) return { ok: false, error: "no_active_turn" };
  if (active.cancelled) return { ok: false, error: "run_already_terminal" };
  active.cancelled = true;
  active.stoppedByOwner = true;
  let cancelledOnWire = false;
  if (active.client && active.sessionId) {
    try {
      await active.client.cancel(active.sessionId);
      cancelledOnWire = true;
    } catch { /* best effort */ }
  }
  return { ok: true, cancelledOnWire, sessionId: active.sessionId };
}

/** The conversation key a session is cached under (exported for unit tests).
 * A thread key names the harness too: two harnesses in one thread are two
 * conversations, never one colliding key. */
export function acpSessionKey(threadId, harnessId) {
  const harness = String(harnessId || "pi");
  return threadId ? `${threadId}:${harness}` : `acp:${harness}`;
}

/** How long an unanswered permission card stays open before the turn answers
 * DENY. ACP gives a request no deadline of its own, and the harness is blocked
 * for as long as we hold it, so something has to settle it: 2 minutes is long
 * enough to read the card and short enough that a walked-away window does not
 * wedge the conversation. The automatic answer is ALWAYS deny — an unattended
 * window must never grant shell/file access. */
export const ACP_PERMISSION_TIMEOUT_MS = 120_000;

/** The permission posture. "ask" (the default) renders the owner's card; "auto"
 * is the explicit trust-the-harness mode. Anything unrecognised resolves to
 * "ask": a typo must fail closed, never silently auto-grant. */
export function acpPermissionMode(value) {
  return String(value ?? "").trim().toLowerCase() === "auto" ? "auto" : "ask";
}

/** Render the owner's decision card and resolve with the chosen optionId.
 * Reuses the SAME <permission-approval-card> the in-browser approval flow uses
 * (only the element + its approve/deny events — deliberately NOT the
 * `approval-decision` event, which surfaces route to the Chrome-grant channel:
 * an ACP decision is answered to the harness, not granted here). */
export async function requestAcpPermission(prompt, options = {}) {
  const { title = "a tool", toolCall = null, options: acpOptions = [] } = prompt ?? {};
  const timeoutMs = Number(options.timeoutMs ?? ACP_PERMISSION_TIMEOUT_MS);
  const isCancelled = typeof options.isCancelled === "function" ? options.isCancelled : () => false;
  const container = options.container ?? null;

  // createCard is injectable so the decision logic is unit-testable without a
  // DOM; the default is the real <permission-approval-card>.
  const card = (options.createCard ?? createAcpPermissionCard)(container, { title, toolCall, acpOptions });
  if (!card) {
    // No surface to ask on: DENY rather than silently granting.
    settleAcpPermissionCard(null, "denied");
    return { optionId: acpDenyOptionId(acpOptions), answered: false, timedOut: false, reason: "no-surface", title };
  }

  const decision = await new Promise((resolve) => {
    let settled = false;
    const onApprove = () => finish({ approved: true });
    const onDeny = () => finish({ approved: false });
    const cancelPoll = setInterval(() => { if (isCancelled()) finish({ approved: false, cancelled: true }); }, 500);
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(cancelPoll);
      try { card.removeEventListener("approve", onApprove); card.removeEventListener("deny", onDeny); } catch { /* detached */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish({ approved: false, timedOut: true }), timeoutMs);
    card.addEventListener("approve", onApprove);
    card.addEventListener("deny", onDeny);
  });

  const approved = decision.approved === true;
  settleAcpPermissionCard(card, approved ? "granted" : "denied");
  return {
    optionId: approved ? acpAllowOptionId(acpOptions) : acpDenyOptionId(acpOptions),
    answered: !decision.timedOut && !decision.cancelled,
    timedOut: decision.timedOut === true,
    cancelled: decision.cancelled === true,
    title,
  };
}

/** Build the card element and put it in the transcript: the SAME component the
 * in-browser approval flow uses. Returns null when the surface cannot show one
 * (the caller then denies). */
function createAcpPermissionCard(container, { title, toolCall, acpOptions }) {
  try {
    if (typeof document === "undefined" || typeof document.createElement !== "function") return null;
    if (!container || typeof container.appendTranscript !== "function") return null;
    const card = document.createElement("permission-approval-card");
    card.setAttribute("reason", String(title || "run a tool").slice(0, 240));
    const detail = (Array.isArray(acpOptions) ? acpOptions : [])
      .map((o) => String(o?.name || o?.optionId || "").trim())
      .filter(Boolean)
      .join(" · ");
    if (detail) card.setAttribute("detail", detail.slice(0, 240));
    card.setAttribute("state", "pending");
    return container.appendTranscript(card);
  } catch {
    return null;
  }
}

function settleAcpPermissionCard(card, state) {
  try { card?.setAttribute?.("state", state); } catch { /* detached */ }
}

/**
 * Execute an ACP task turn on a conversation container.
 *
 * @param {Object} options
 * @param {any} options.container - The `<agent-conversation>` DOM element
 * @param {string} options.task - User prompt text
 * @param {Array<any>} [options.attachments] - User attachments
 * @param {string|null} [options.threadId] - Task thread ID
 * @param {string} [options.harnessId] - Target harness ID (e.g. 'pi')
 * @param {string} [options.endpoint] - Custom WebSocket URL
 * @param {string} [options.cwd] - Custom working directory
 * @param {(state: any) => void} [options.onStatus] - Status update callback
 * @param {(id: string) => void} [options.onRunRegistered] - Run registered callback
 * @param {string} [options.executionId] - Execution ID override
 * @param {() => boolean} [options.isStale] - Run-lifecycle fence
 * @param {{get: (key: string) => Promise<string|null>, set: (key: string, sessionId: string) => Promise<void>}} [options.sessionStore] - Durable session-id store (kv), so a reload resumes instead of forking
 * @param {{get: (key: string) => Promise<string|null>}} [options.settings] - kv reader for `acp.endpoint` / `acp.token` / `acp.transport` / `acp.permissions`
 * @param {(prompt: any, opts?: any) => Promise<any>} [options.permissionPrompter] - the owner gate (default: the inline Allow/Deny card); injectable for tests
 * @param {number} [options.permissionTimeoutMs] - how long an unanswered card waits before the turn denies (default 120s)
 * @returns {Promise<{ok: boolean, result?: string, stopReason?: string, sessionId?: string, resumed?: boolean, resumeFailed?: boolean, resumeError?: string|null, error?: string, requestedHarness?: string, startedHarness?: string}>}
 */
export async function runAcpTaskTurn(options) {
  const {
    container,
    task,
    attachments = [],
    threadId = null,
    harnessId = "pi",
    endpoint = DEFAULT_ACP_ENDPOINT,
    cwd = DEFAULT_ACP_CWD,
    onStatus = null,
    onRunRegistered = null,
    isStale = () => false,
    sessionStore = null,
    settings = null,
    executionId = null,
    /** chrome-agent-platform-etdn: pre-resolved CAP skill definitions to
     *  inject into the harness turn (tests / callers that already resolved).
     *  When absent, /skill: references in the task are resolved against the
     *  Chrome skill store via runtimeSend. */
    skills = null,
    runtimeSend = null,
    onEvent = null,
  } = options;

  const sessionKey = acpSessionKey(threadId, harnessId);
  const currentExecutionId = executionId || `acp:${sessionKey}:${Date.now()}`;
  onRunRegistered?.(currentExecutionId);

  const stale = () => {
    try { return typeof isStale === "function" && !!isStale(); }
    catch { return false; }
  };

  const status = (s) => {
    if (!stale()) onStatus?.({ executionId: currentExecutionId, ...s });
  };

  status({ state: "running", activity: `Connecting to ${harnessId} harness…` });

  // Operator settings (Settings UI pending): a configured endpoint replaces the
  // default, and a configured token rides the upgrade query — the bridge's
  // --token mode refuses a connection without it.
  let effectiveEndpoint = endpoint;
  let effectiveCwd = cwd;
  if (typeof settings?.get === "function") {
    try {
      const configuredEndpoint = await settings.get("acp.endpoint");
      if (typeof configuredEndpoint === "string" && configuredEndpoint.trim()) effectiveEndpoint = configuredEndpoint.trim();
      const token = await settings.get("acp.token");
      effectiveEndpoint = acpEndpointWithToken(effectiveEndpoint, token);
      const configuredCwd = await settings.get("acp.cwd");
      if (!effectiveCwd && typeof configuredCwd === "string" && configuredCwd.trim()) effectiveCwd = configuredCwd.trim();
    } catch { /* fall back to the built-in default */ }
  }
  effectiveEndpoint = acpEndpointWithHarness(effectiveEndpoint, harnessId);

  // TRANSPORT: prefer the Chrome native-messaging host — Chrome launches it on
  // demand, so there is no bridge process, no port and nothing to keep running.
  // When the host is not installed (or the operator pinned `acp.transport=ws`),
  // fall back to the loopback WebSocket bridge. `acp.transport` in kv overrides
  // the choice explicitly: "native" | "ws".
  let transportMode = "";
  let permissionsMode = acpPermissionMode(null); // "ask" unless kv says otherwise
  if (typeof settings?.get === "function") {
    try { transportMode = String(await settings.get("acp.transport") || ""); } catch { transportMode = ""; }
    try { permissionsMode = acpPermissionMode(await settings.get("acp.permissions")); } catch { permissionsMode = "ask"; }
  }
  const nativeHost = DEFAULT_NATIVE_HOST;
  let nativeTransport = null;
  let nativeError = "";
  if (transportMode !== "ws") {
    nativeTransport = new AcpNativeTransport({ hostName: nativeHost });
    try {
      await nativeTransport.connect();
    } catch (err) {
      nativeError = String(err?.message ?? err);
      nativeTransport = null; // not installed — the WebSocket bridge may be
    }
  }

  if (nativeTransport) {
    status({ state: "running", activity: `Connecting to the local ${harnessId} host…` });
  }

  // THE OWNER GATE: in "ask" (the default) every harness permission request is
  // rendered as an inline Allow/Deny card and the turn waits for the click, so
  // the harness runs shell/file commands with the owner's consent or not at all.
  // "auto" keeps the auto-grant and must be set deliberately in kv. The
  // cancellation check is late-bound: the claim it reads is created below.
  let permissionCancelled = () => false;
  // permissionPrompter is injectable for tests (the real one renders the card).
  const permissionPrompter = options.permissionPrompter ?? requestAcpPermission;
  const permissionHandler = permissionsMode === "auto"
    ? null
    // The client's contract is an OPTION ID (a string) — a prompter that
    // resolves to a richer decision object must never put that object on the
    // wire (the fixture caught exactly that: "permission: [object Object]").
    : async (request) => {
        const decision = await permissionPrompter(request, {
          container,
          isCancelled: () => permissionCancelled(),
          timeoutMs: options.permissionTimeoutMs ?? ACP_PERMISSION_TIMEOUT_MS,
        });
        return typeof decision?.optionId === "string" && decision.optionId ? decision.optionId : null;
      };

  const client = (typeof options.clientFactory === "function")
    ? options.clientFactory({ url: effectiveEndpoint, defaultCwd: cwd, transport: nativeTransport || null })
    : new AcpClient({
      url: effectiveEndpoint,
      defaultCwd: cwd,
      transport: nativeTransport || null,
      ...(permissionHandler ? { permissionHandler } : {}),
    });

  // CLAIM the conversation BEFORE ANY await — synchronously. A second (or
  // third) send while this turn is still connecting has to SEE this turn and
  // supersede it; if the claim were installed after `await prior.cancel(...)`,
  // a third send would still read the OLD claim and overwrite the second one,
  // leaving two turns unnotified and both prompting. `cancelled` makes the
  // newer turn's intent visible even before this turn reaches the wire.
  const claim = { client: null, sessionId: null, cancelled: false, stoppedByOwner: false };
  const prior = activeTurns.get(sessionKey);
  if (prior) prior.cancelled = true;
  activeTurns.set(sessionKey, claim);
  const releaseClaim = () => { if (activeTurns.get(sessionKey) === claim) activeTurns.delete(sessionKey); };
  /** This turn no longer owns the conversation (superseded, or its surface left). */
  const superseded = () => claim.cancelled || stale();
  // The gate above was built before this turn's claim existed; from here on it
  // can see whether this turn still owns the conversation.
  permissionCancelled = superseded;

  // The prior turn's host prompt is stopped after the claim is installed (the
  // claim is what makes a LATER send able to stop US).
  if (prior?.client) {
    try { await prior.client.cancel(prior.sessionId); } catch { /* best effort */ }
    try { prior.client.close(); } catch { /* best effort */ }
  }

  if (nativeTransport) {
    nativeTransport.onMessage = (raw) => client._receiveRaw(raw);
    nativeTransport.onClose = (reason) => { client.connected = false; client._abortPending(new Error(reason)); };
  }

  try {
    await client.connect();
  } catch (err) {
    releaseClaim();
    const errorMsg = `Cannot connect to ACP harness (${harnessId}) at ${effectiveEndpoint}.`;
    // Name EVERY transport that was unavailable, so the fix is one command away
    // whichever way the operator wants to run it.
    const fixes = [];
    if (nativeError) fixes.push("install the local host: npm run acp:native:install");
    else if (nativeTransport) fixes.push("the local host is not answering: npm run acp:native:install");
    fixes.push("or run the bridge: npm run acp:bridge");
    const actionMsg = `${fixes.join(" — ")} (both in the CAP repo)`;
    if (!stale()) {
      if (typeof container.appendError === "function") {
        container.appendError(errorMsg, {
          reason: String(err?.message ?? err),
          action: actionMsg,
          category: "harness-connection",
          requestedHarness: harnessId,
        });
      } else if (typeof container.appendSystem === "function") {
        container.appendSystem(`${errorMsg} ${actionMsg}`);
      }
      status({ state: "failed", errorReason: errorMsg, errorAction: actionMsg });
    }
    return { ok: false, error: `${errorMsg} ${actionMsg}`, requestedHarness: harnessId };
  }

  if (superseded()) {
    releaseClaim();
    client.close();
    return { ok: false, error: "Task was superseded" };
  }

  // Resume bookkeeping lives OUTSIDE the try: the turn's catch has to report
  // whether this turn already fell back to a fresh session (u0cc).
  let resumed = false;
  // A failed session/load falls back to a fresh session — a dead adapter must
  // not block the turn — but the fallback is NEVER silent: the user is told the
  // previous conversation could not be restored (and why), and the result marks
  // it so a surface can tell a restored conversation from a new one.
  // `resumeFailed` stays false when there was nothing to resume: a first turn is
  // not a failure.
  let resumeFailed = false;
  let resumeError = null;

  try {
    status({ state: "running", activity: `Initializing ${harnessId}…` });
    await client.initialize();
    if (superseded()) {
      return { ok: false, error: "Task was superseded" };
    }

    // Session resolution: resume the conversation this surface/harness owns.
    // Keyed by threadId+harness inside a persisted thread, else by harness
    // identity — the pi surface and hub @pi delegations are one continuous
    // conversation. A reload recovers the session id from the caller's
    // sessionStore (kv), so continuity survives the page.
    let sessionId = threadSessions.get(sessionKey) ?? null;
    if (!sessionId && typeof sessionStore?.get === "function") {
      try { sessionId = await sessionStore.get(sessionKey) ?? null; } catch { sessionId = null; }
    }

    if (sessionId) {
      try {
        await client.loadSession({ sessionId, cwd: effectiveCwd });
        resumed = true;
      } catch (err) {
        // Fall back to new session if resume fails
        sessionId = null;
        resumeFailed = true;
        resumeError = String(err?.message ?? err).replace(/\s+/gu, " ").trim().slice(0, 240)
          || "the harness did not say why";
      }
    }

    if (!sessionId) {
      const sess = await client.newSession({ cwd: effectiveCwd });
      sessionId = sess.sessionId;
    }
    threadSessions.set(sessionKey, sessionId);
    claim.client = client;
    claim.sessionId = sessionId;
    if (typeof sessionStore?.set === "function") {
      try { await sessionStore.set(sessionKey, sessionId); } catch { /* resume hint only */ }
    }

    // Tell the surface BEFORE this fresh conversation streams: the owner must
    // know the conversation they expected is gone, and why, before reading a
    // reply that was written without any of its context. A system line, not an
    // error card — the turn itself is still going to run.
    if (resumeFailed && !superseded() && typeof container.appendSystem === "function") {
      container.appendSystem(`Started a new conversation — the previous session could not be restored (${resumeError}).`);
    }

    if (superseded()) {
      return { ok: false, error: "Task was superseded" };
    }

    // chrome-agent-platform-etdn: forward CAP skill context. The owner's own
    // text stays the conversation surface; the harness payload carries the
    // skill definitions the prompt references (or the caller supplied).
    let harnessPrompt = task;
    try {
      const ctx = Array.isArray(skills) && skills.length
        ? skills
        : await resolveSkillContext(task, { runtimeSend });
      harnessPrompt = buildPromptWithSkillContext(task, ctx);
    } catch { /* a context failure never blocks the turn */ }

    // chrome-agent-platform-2amt: in-turn browser tool execution loop.
    // When the model outputs browser/call_tool JSON-RPC blocks in its text stream,
    // intercept them, clean the chat bubble so raw JSON is not shown, dispatch
    // via browser.callTool, and feed the result back to the harness. Loop bounded to 5 hops.
    let currentPrompt = harnessPrompt;
    let turn = null;
    let finalText = "";
    let streamedAgentBubble = null;
    let streamedText = "";
    let thinkingStarted = false;
    const toolCards = new Map();
    const MAX_TOOL_HOPS = 5;
    let hops = 0;

    while (hops++ < MAX_TOOL_HOPS) {
      if (superseded()) {
        client.close();
        if (claim.stoppedByOwner) status({ state: "cancelled" });
        return { ok: false, error: "Task was cancelled", stopReason: "cancelled", sessionId, resumed, resumeFailed, resumeError };
      }

      status({ state: "running", activity: `${harnessId} is thinking…` });
      streamedText = "";
      thinkingStarted = false;

      turn = await client.prompt(
        sessionId,
        currentPrompt,
        (ev) => {
          if (superseded()) return;
          try { onEvent?.(ev); } catch { /* a consumer's error never fails the turn */ }

          if (ev.kind === "thought" && ev.text) {
            if (typeof container.thinkingDelta === "function") {
              container.thinkingDelta({ delta: ev.text, start: !thinkingStarted });
              thinkingStarted = true;
            }
          } else if (ev.kind === "tool") {
            const cardId = ev.toolCallId || ev.detail || "tool";
            const toolStatus = acpToolStatusUi(ev.status);
            if (typeof container.appendTool === "function") {
              const existing = toolCards.get(cardId);
              if (existing) {
                // The same call progressing: settle the card it already has.
                if (typeof existing.setAttribute === "function") {
                  existing.setAttribute("tool-status", toolStatus);
                  if (ev.detail) existing.setAttribute("tool-detail", ev.detail);
                }
              } else {
                const card = container.appendTool({
                  name: `${harnessId}-tool`,
                  status: toolStatus,
                  detail: ev.detail,
                });
                if (card) toolCards.set(cardId, card);
              }
            }
            if (ev.detail) status({ state: "running", activity: `${harnessId}: ${String(ev.detail).slice(0, 40)}…` });
          } else if (ev.kind === "chunk" && ev.text) {
            if (thinkingStarted && typeof container.collapseThinkingTrace === "function") {
              container.collapseThinkingTrace();
            }
            streamedText += ev.text;
            if (!streamedAgentBubble) {
              if (typeof container.appendAgent === "function") {
                streamedAgentBubble = container.appendAgent(streamedText);
              }
            } else {
              if (typeof streamedAgentBubble.setAttribute === "function") {
                streamedAgentBubble.setAttribute("content", streamedText);
              }
            }
            status({ state: "running", activity: "Writing response…" });
          } else if (ev.kind === "permission") {
            // Honest, in the owner's words: what the harness asked for and what it
            // was told. A denial reads as a denial, never as an ambiguous line.
            if (typeof container.appendSystem === "function") {
              const detail = String(ev.detail ?? "");
              const denied = /deny|declined|not allowed|no\b/i.test(detail);
              container.appendSystem(
                denied ? `Permission denied: ${detail || "the harness was told no"}`
                       : `Permission granted: ${detail || "allowed"}`,
              );
            }
          }
        },
        hops === 1 ? attachments : [],
      );

      if (superseded()) {
        client.close();
        if (claim.stoppedByOwner) status({ state: "cancelled" });
        return { ok: false, error: "Task was cancelled", stopReason: "cancelled", sessionId, resumed, resumeFailed, resumeError };
      }

      // A cancelled turn is NOT a success: the harness reports stopReason
      // "cancelled" when a newer turn (or a cancel request) stopped it.
      if (String(turn?.stopReason ?? "").toLowerCase().startsWith("cancel") || claim.stoppedByOwner) {
        status({ state: "cancelled" });
        return { ok: false, error: "Task was cancelled", stopReason: turn?.stopReason || "cancelled", sessionId, resumed, resumeFailed, resumeError };
      }

      const rawHopOutput = turn?.text || streamedText;
      const { calls, cleanText } = extractBrowserToolCalls(rawHopOutput);

      if (cleanText) {
        finalText = cleanText;
        if (streamedAgentBubble && typeof streamedAgentBubble.setAttribute === "function") {
          streamedAgentBubble.setAttribute("content", cleanText);
        } else if (!streamedAgentBubble && typeof container.appendAgent === "function") {
          streamedAgentBubble = container.appendAgent(cleanText);
        }
      } else if (streamedAgentBubble && calls.length > 0) {
        // If the model ONLY emitted the tool call JSON, remove or clear the empty bubble
        if (typeof streamedAgentBubble.remove === "function") {
          streamedAgentBubble.remove();
        } else if (typeof streamedAgentBubble.setAttribute === "function") {
          streamedAgentBubble.setAttribute("content", "");
        }
        streamedAgentBubble = null;
      }

      if (!calls.length) {
        // No browser tool calls to execute — turn is complete!
        break;
      }

      // Execute extracted browser tool calls
      const toolResults = [];
      const send = runtimeSend ?? ((type, body) => globalThis.chrome?.runtime?.sendMessage?.({ type, ...body }));

      for (const call of calls) {
        if (superseded()) break;

        status({ state: "running", activity: `Running browser tool: ${call.name}…` });

        // Check if this tool is gated and requires in-conversation owner approval (chrome-agent-platform-f3n2)
        let wasApproved = false;
        if (ACP_GATED_BROWSER_TOOLS.has(call.name)) {
          const approvalInfo = formatBrowserToolApproval(call.name, call.args);
          const prompt = {
            title: approvalInfo.title,
            toolCall: { title: approvalInfo.title, detail: approvalInfo.detail },
            options: [
              { optionId: "allow_once", name: "Approve", kind: "allow_once" },
              { optionId: "deny", name: "Deny", kind: "deny" },
            ],
          };

          const decision = await permissionPrompter(prompt, {
            container,
            isCancelled: () => superseded(),
            timeoutMs: options.permissionTimeoutMs ?? ACP_PERMISSION_TIMEOUT_MS,
          });

          const approved = decision && typeof decision.optionId === "string" && /allow/i.test(decision.optionId);

          if (!approved) {
            if (typeof container.appendTool === "function") {
              const card = container.appendTool({
                name: `browser:${call.name}`,
                status: "error",
                detail: `${call.name} (owner denied approval)`,
              });
              if (card && typeof card.setAttribute === "function") {
                card.setAttribute("tool-status", "error");
              }
            }
            toolResults.push({ id: call.id, result: { ok: false, error: "denied" } });
            continue;
          }
          wasApproved = true;
        }

        // Append tool card in container
        let card = null;
        if (typeof container.appendTool === "function") {
          card = container.appendTool({
            name: `browser:${call.name}`,
            status: "running",
            detail: `${call.name}(${Object.keys(call.args || {}).join(", ")})`,
          });
        }

        let reply;
        try {
          reply = await send("browser.callTool", {
            name: call.name,
            args: call.args,
            ...(wasApproved ? { approved: true } : {}),
          });
        } catch (err) {
          reply = { ok: false, error: String(err?.message ?? err) };
        }

        const toolResult = reply && reply.ok === false && reply.error !== undefined
          ? { error: reply.error }
          : reply;

        if (card && typeof card.setAttribute === "function") {
          card.setAttribute("tool-status", toolResult?.error ? "error" : "done");
        }

        toolResults.push({ id: call.id, result: toolResult });
      }

      if (superseded()) {
        client.close();
        if (claim.stoppedByOwner) status({ state: "cancelled" });
        return { ok: false, error: "Task was cancelled", stopReason: "cancelled", sessionId, resumed, resumeFailed, resumeError };
      }

      // Format response back to the harness.
      if (toolResults.length === 1) {
        currentPrompt = JSON.stringify({
          jsonrpc: "2.0",
          id: toolResults[0].id,
          result: toolResults[0].result,
        });
      } else {
        currentPrompt = toolResults.map((r) =>
          JSON.stringify({ jsonrpc: "2.0", id: r.id, result: r.result })
        ).join("\n");
      }

      streamedAgentBubble = null;
    }

    status({ state: "completed" });
    return {
      ok: true,
      result: finalText || turn?.text || streamedText,
      stopReason: turn?.stopReason,
      sessionId,
      resumed,
      resumeFailed,
      resumeError,
    };
  } catch (err) {
    let errorDetail = String(err?.message ?? err);

    // Identify which harness was actually started from bridge close/spawn error
    const startedMatch = errorDetail.match(/adapter(?: spawn failed)? for harness "([^"]+)"/i);
    let startedHarness = startedMatch ? startedMatch[1] : null;
    if (!startedHarness && errorDetail.includes("Could not start pi") && harnessId !== "pi") {
      startedHarness = "pi";
    }

    if (startedHarness && startedHarness !== harnessId) {
      errorDetail = `Harness mismatch: requested "${harnessId}", but running bridge started "${startedHarness}". `
        + `To reconfigure the background service: npm run acp:service install --harness ${harnessId}. (${errorDetail})`;
    } else if (/executable not found|not found \(command:/i.test(errorDetail)) {
      errorDetail += " — the harness CLI is not on the PATH of the process that started the adapter. "
        + "If the bridge was auto-started (service or native host), reinstall the launcher so it captures "
        + "your shell PATH (npm run acp:service install), or install the CLI it names.";
    }
    // A SUPERSEDED or STOPPED turn renders nothing: the socket close / prompt rejection a
    // successor or stop caused is not this surface's error to show (and would land
    // over the successor's own output). Surfaces without an isStale fence (the
    // side panel) depend on this check, not on stale() alone.
    if (claim.stoppedByOwner) {
      status({ state: "cancelled" });
      return { ok: false, error: "Task was cancelled", stopReason: "cancelled", sessionId: claim.sessionId, resumed: false, resumeFailed, resumeError };
    }
    if (claim.cancelled) {
      return { ok: false, error: "Task was superseded" };
    }
    if (!stale()) {
      if (typeof container.appendError === "function") {
        container.appendError(`ACP turn error: ${errorDetail}`, {
          category: "harness-error",
          reason: errorDetail,
          requestedHarness: harnessId,
          startedHarness: startedHarness || harnessId,
        });
      }
      status({ state: "failed", errorReason: errorDetail });
    }
    return {
      ok: false,
      error: errorDetail,
      requestedHarness: harnessId,
      startedHarness: startedHarness || harnessId,
      resumed: false,
      resumeFailed,
      resumeError,
    };
  } finally {
    // This turn is no longer the active one for the key (a newer turn may own
    // it already — never clear a successor's registration).
    releaseClaim();
    client.close();
    try { nativeTransport?.close(); } catch { /* already gone */ }
  }
}
