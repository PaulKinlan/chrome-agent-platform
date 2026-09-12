// extension/lib/acp-runner.js — Coordinates ACP harness task runs for the UI surfaces (NTP, Side Panel).
// CAP-FB-20260912-ACP-INTEGRATION-01 (tracking epic chrome-agent-platform-qlho)
//
// Drives an external agent harness (e.g. pi via pi-acp) over the loopback ACP WebSocket bridge,
// streaming thoughts, tool progress, and message chunks into the conversation surface.

import { AcpClient } from "./acp-client.js";

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
  } = options;

  const stale = () => {
    try { return typeof isStale === "function" && !!isStale(); }
    catch { return false; }
  };

  const status = (s) => {
    if (!stale()) onStatus?.(s);
  };

  status({ state: "running", activity: `Connecting to ${harnessId} harness…` });

  const client = new AcpClient({
    url: endpoint,
    defaultCwd: cwd,
  });

  /** The conversation key, owned by this turn (the finally clears it). */
  const sessionKey = acpSessionKey(threadId, harnessId);

  // CLAIM the conversation BEFORE any await. A second send while this turn is
  // still connecting has to SEE this turn and supersede it — otherwise both
  // turns read no prior owner, both connect, and two host prompts run
  // concurrently on one session. `cancelled` makes the newer turn's intent
  // visible even when the older one has not reached `session/prompt` yet.
  const claim = { client: null, sessionId: null, cancelled: false };
  const prior = activeTurns.get(sessionKey);
  if (prior) {
    prior.cancelled = true;
    const priorClient = prior.client;
    if (priorClient) {
      try { await priorClient.cancel(prior.sessionId); } catch { /* best effort */ }
      try { priorClient.close(); } catch { /* best effort */ }
    }
  }
  activeTurns.set(sessionKey, claim);
  const releaseClaim = () => { if (activeTurns.get(sessionKey) === claim) activeTurns.delete(sessionKey); };
  /** This turn no longer owns the conversation (superseded, or its surface left). */
  const superseded = () => claim.cancelled || stale();

  try {
    await client.connect();
  } catch (err) {
    releaseClaim();
    const errorMsg = `Cannot connect to ACP harness (${harnessId}) at ${endpoint}.`;
    const actionMsg = "Start the local ACP bridge with: npm run acp:bridge (in the CAP repo)";
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
          if (typeof container.appendSystem === "function") {
            container.appendSystem(`Harness permission: ${ev.detail || "granted"}`);
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
    const errorDetail = String(err?.message ?? err);
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
  }
}
