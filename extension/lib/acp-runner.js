// extension/lib/acp-runner.js — Coordinates ACP harness task runs for the UI surfaces (NTP, Side Panel).
// CAP-FB-20260912-ACP-INTEGRATION-01 (tracking epic chrome-agent-platform-qlho)
//
// Drives an external agent harness (e.g. pi via pi-acp) over the loopback ACP WebSocket bridge,
// streaming thoughts, tool progress, and message chunks into the conversation surface.

import { AcpClient, acpAllowOptionId, acpDenyOptionId } from "./acp-client.js";
import { AcpNativeTransport, DEFAULT_NATIVE_HOST } from "./acp-native.js";

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
 * @param {() => boolean} [options.isStale] - Run-lifecycle fence
 * @param {{get: (key: string) => Promise<string|null>, set: (key: string, sessionId: string) => Promise<void>}} [options.sessionStore] - Durable session-id store (kv), so a reload resumes instead of forking
 * @param {{get: (key: string) => Promise<string|null>}} [options.settings] - kv reader for `acp.endpoint` / `acp.token` / `acp.transport` / `acp.permissions`
 * @param {(prompt: any, opts?: any) => Promise<any>} [options.permissionPrompter] - the owner gate (default: the inline Allow/Deny card); injectable for tests
 * @param {number} [options.permissionTimeoutMs] - how long an unanswered card waits before the turn denies (default 120s)
 * @returns {Promise<{ok: boolean, result?: string, stopReason?: string, sessionId?: string, resumed?: boolean, error?: string}>}
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
    isStale = () => false,
    sessionStore = null,
    settings = null,
  } = options;

  const stale = () => {
    try { return typeof isStale === "function" && !!isStale(); }
    catch { return false; }
  };

  const status = (s) => {
    if (!stale()) onStatus?.(s);
  };

  status({ state: "running", activity: `Connecting to ${harnessId} harness…` });

  // Operator settings (Settings UI pending): a configured endpoint replaces the
  // default, and a configured token rides the upgrade query — the bridge's
  // --token mode refuses a connection without it.
  let effectiveEndpoint = endpoint;
  if (typeof settings?.get === "function") {
    try {
      const configuredEndpoint = await settings.get("acp.endpoint");
      if (typeof configuredEndpoint === "string" && configuredEndpoint.trim()) effectiveEndpoint = configuredEndpoint.trim();
      const token = await settings.get("acp.token");
      effectiveEndpoint = acpEndpointWithToken(effectiveEndpoint, token);
    } catch { /* fall back to the built-in default */ }
  }

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

  const client = new AcpClient({
    url: effectiveEndpoint,
    defaultCwd: cwd,
    transport: nativeTransport || null,
    ...(permissionHandler ? { permissionHandler } : {}),
  });

  /** The conversation key, owned by this turn (the finally clears it). */
  const sessionKey = acpSessionKey(threadId, harnessId);

  // CLAIM the conversation BEFORE ANY await — synchronously. A second (or
  // third) send while this turn is still connecting has to SEE this turn and
  // supersede it; if the claim were installed after `await prior.cancel(...)`,
  // a third send would still read the OLD claim and overwrite the second one,
  // leaving two turns unnotified and both prompting. `cancelled` makes the
  // newer turn's intent visible even before this turn reaches the wire.
  const claim = { client: null, sessionId: null, cancelled: false };
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
    const errorMsg = `Cannot connect to ACP harness (${harnessId}) at ${endpoint}.`;
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
        });
      } else if (typeof container.appendSystem === "function") {
        container.appendSystem(`${errorMsg} ${actionMsg}`);
      }
      status({ state: "failed", errorReason: errorMsg, errorAction: actionMsg });
    }
    return { ok: false, error: `${errorMsg} ${actionMsg}` };
  }

  if (superseded()) {
    releaseClaim();
    client.close();
    return { ok: false, error: "Task was superseded" };
  }

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
    let resumed = false;

    if (sessionId) {
      try {
        await client.loadSession({ sessionId, cwd });
        resumed = true;
      } catch {
        // Fall back to new session if resume fails
        sessionId = null;
      }
    }

    if (!sessionId) {
      const sess = await client.newSession({ cwd });
      sessionId = sess.sessionId;
    }
    threadSessions.set(sessionKey, sessionId);
    claim.client = client;
    claim.sessionId = sessionId;
    if (typeof sessionStore?.set === "function") {
      try { await sessionStore.set(sessionKey, sessionId); } catch { /* resume hint only */ }
    }

    if (superseded()) {
      return { ok: false, error: "Task was superseded" };
    }

    status({ state: "running", activity: `${harnessId} is thinking…` });

    let thinkingStarted = false;
    let streamedAgentBubble = null;
    let streamedText = "";
    /** toolCallId → the card this turn appended, so updates SETTLE it instead
     * of appending a second permanently-running card per update. */
    const toolCards = new Map();

    const turn = await client.prompt(
      sessionId,
      task,
      (ev) => {
        if (superseded()) return;

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
      attachments,
    );

    if (superseded()) {
      client.close();
      return { ok: false, error: "Task was superseded" };
    }

    // A cancelled turn is NOT a success: the harness reports stopReason
    // "cancelled" when a newer turn (or a cancel request) stopped it.
    if (String(turn.stopReason ?? "").toLowerCase().startsWith("cancel")) {
      return { ok: false, error: "Task was cancelled", stopReason: turn.stopReason, sessionId, resumed };
    }

    // Ensure complete response rendered
    if (!streamedAgentBubble && turn.text) {
      if (typeof container.appendAgent === "function") {
        container.appendAgent(turn.text);
      }
    }

    status({ state: "completed" });
    return {
      ok: true,
      result: turn.text || streamedText,
      stopReason: turn.stopReason,
      sessionId,
      resumed,
    };
  } catch (err) {
    let errorDetail = String(err?.message ?? err);
    // The adapter says "executable not found" when IT cannot see the harness
    // CLI — the usual cause is the launcher's PATH (a launchd/systemd service or
    // a Chrome-spawned native host inherits a minimal environment, not the
    // shell's), and that cause is not obvious from the adapter's wording.
    if (/executable not found|not found \(command:/i.test(errorDetail)) {
      errorDetail += " — the harness CLI is not on the PATH of the process that started the adapter. "
        + "If the bridge was auto-started (service or native host), reinstall the launcher so it captures "
        + "your shell PATH (npm run acp:service install), or install the CLI it names.";
    }
    // A SUPERSEDED turn renders nothing: the socket close / prompt rejection a
    // successor caused is not this surface's error to show (and would land
    // over the successor's own output). Surfaces without an isStale fence (the
    // side panel) depend on this check, not on stale() alone.
    if (claim.cancelled) {
      return { ok: false, error: "Task was superseded" };
    }
    if (!stale()) {
      if (typeof container.appendError === "function") {
        container.appendError(`ACP turn error: ${errorDetail}`, {
          category: "harness-error",
          reason: errorDetail,
        });
      }
      status({ state: "failed", errorReason: errorDetail });
    }
    return { ok: false, error: errorDetail };
  } finally {
    // This turn is no longer the active one for the key (a newer turn may own
    // it already — never clear a successor's registration).
    releaseClaim();
    client.close();
    try { nativeTransport?.close(); } catch { /* already gone */ }
  }
}
