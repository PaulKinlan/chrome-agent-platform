// Page-local authority for reconciling a live completion with an authoritative
// thread.get projection. The persisted thread remains the only message source;
// this tracker records which immutable execution results that source already
// rendered into a particular owned surface.

const projections = new WeakMap();

function validIdentity(value) {
  return typeof value === "string" && value.length > 0;
}

function validContainer(value) {
  return value !== null && ["object", "function"].includes(typeof value);
}

function terminalMessages(messages) {
  const byExecution = new Map();
  for (const message of (Array.isArray(messages) ? messages : [])) {
    if (
      !validIdentity(message?.executionId) ||
      !["assistant", "error"].includes(message?.role) ||
      typeof message?.content !== "string" ||
      Number.isInteger(message?.step) // an interim per-step row is not the terminal
    ) continue;
    byExecution.set(
      message.executionId,
      Object.freeze({
        role: message.role,
        content: message.content,
      }),
    );
  }
  return byExecution;
}

/** Record one owner- and generation-fenced authoritative thread projection. */
export function recordAuthoritativeThreadProjection(container, {
  threadId,
  owner,
  generation,
  messages,
} = {}) {
  if (
    !validContainer(container) ||
    !validIdentity(threadId) ||
    owner == null ||
    !Number.isSafeInteger(generation) ||
    generation < 1
  ) return false;

  const prior = projections.get(container);
  if (
    prior?.threadId === threadId &&
    prior?.owner === owner &&
    prior.generation > generation
  ) return false;

  projections.set(
    container,
    Object.freeze({
      threadId,
      owner,
      generation,
      terminals: terminalMessages(messages),
    }),
  );
  return true;
}

export function clearAuthoritativeThreadProjection(container) {
  if (!validContainer(container)) return false;
  return projections.delete(container);
}

/**
 * Whether this exact immutable execution's byte-identical assistant result is
 * already present in the authoritative projection owned by this turn.
 * Different executions and revised content are intentionally never suppressed.
 */
export function isAuthoritativeThreadResultProjected(container, {
  threadId,
  executionId,
  owner,
  content,
} = {}) {
  if (
    !validContainer(container) ||
    !validIdentity(threadId) ||
    !validIdentity(executionId) ||
    owner == null ||
    typeof content !== "string"
  ) return false;
  const projection = projections.get(container);
  if (
    !projection ||
    projection.threadId !== threadId ||
    projection.owner !== owner
  ) return false;
  const terminal = projection.terminals.get(executionId);
  return terminal?.role === "assistant" && terminal.content === content;
}

// ── the ONE run-state projection (chrome-agent-platform-716s.1) ─────────────
// Three surfaces describe the same thread's run: the Tasks sidebar dot, the hub
// timeline row ("Running…" / "Waiting for you") and the conversation's pinned
// status row. They used to read three different inputs (thread.status, the
// durable run phase, and whichever live event the open tab happened to see),
// so a run paused on an approval card read "Working — run in progress…" in a
// reopened tab while the first tab still showed the card. Every consumer now
// reads `projectThreadRunState()` — one function, the durable run record plus
// the still-unanswered approval requests — so the three cannot disagree.

const ACTIVE_RUN_PHASES = new Set(["running", "settling", "resume-dispatching", "cancel-requested"]);

function boundedText(value, max) {
  const s = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** The first still-unanswered approval request bound to this run, or null.
 * Matches on the immutable execution id first, then the client's per-attempt
 * run id (events for a hub-started run carry that as `runId`). */
export function pendingApprovalForRun(run, pendingApprovals) {
  if (!run || typeof run !== "object") return null;
  const list = Array.isArray(pendingApprovals) ? pendingApprovals : [];
  const executionId = typeof run.executionId === "string" ? run.executionId : "";
  const clientRunId = typeof run.clientCorrelationId === "string" ? run.clientCorrelationId : "";
  for (const ev of list) {
    if (!ev || typeof ev !== "object" || ev.type !== "approval-request") continue;
    if (executionId && ev.executionId === executionId) return ev;
    if (clientRunId && ev.runId === clientRunId) return ev;
  }
  return null;
}

function approvalReason(event) {
  const req = event?.result?.permissionRequirement ?? event?.permissionRequirement ?? null;
  const first = Array.isArray(req?.approvals) ? req.approvals[0] : null;
  if (first?.detail?.kind === "webmcp-tool" && first.detail.tool && first.detail.origin) {
    return boundedText(`use ${first.detail.tool} on ${first.detail.origin}`, 240);
  }
  return boundedText(req?.reason, 240) || "perform this action";
}

function pauseCategory(run) {
  const kind = String(run?.pause?.kind ?? "");
  if (kind === "provider-change") return "provider-config";
  if (kind === "permission") return "host-permission";
  return "permission";
}

/**
 * Project a thread's run into the one state its surfaces share.
 *
 * @param {{ thread?: object|null, run?: object|null, pendingApprovals?: object[] }} input
 *   `run` is the thread's latest durable registry record (or null);
 *   `pendingApprovals` the page's still-unanswered `approval-request` events.
 * @returns {{
 *   state: "waiting"|"working"|"done"|"failed"|"cancelled"|"idle",
 *   dot: "paused"|"running"|"error"|"done"|"",
 *   timeline: "paused"|"running"|"failed"|"done"|"",
 *   outcome: string,
 *   status: object|null,
 *   card: object|null,
 * }}
 *   `dot` is the sidebar dot class, `timeline` the hub-timeline status word,
 *   `outcome` the timeline row's outcome text, `status` the conversation
 *   status-row input (null = no live row), `card` the approval-request event
 *   the reopened surface must re-mount (null = nothing to answer).
 */
export function projectThreadRunState({ thread = null, run = null, pendingApprovals = [] } = {}) {
  const phase = run && typeof run === "object" ? String(run.phase ?? "") : "";
  const terminalFailed = Boolean(run?.terminal && run.terminal.ok === false);
  const waiting = (outcome, status, card = null) =>
    Object.freeze({ state: "waiting", dot: "paused", timeline: "paused", outcome, status, card });
  const working = () => Object.freeze({
    state: "working", dot: "running", timeline: "running", outcome: "Running…",
    status: { state: "running", activity: "run in progress" }, card: null,
  });
  const failed = (outcome) => Object.freeze({ state: "failed", dot: "error", timeline: "failed", outcome, status: null, card: null });
  const done = (outcome) => Object.freeze({ state: "done", dot: "done", timeline: "done", outcome, status: null, card: null });
  const failedOutcome = () => boundedText(run?.terminal?.summary, 90) || "Didn’t finish";
  const doneOutcome = () => boundedText(run?.terminal?.summary, 90);

  if (phase) {
    if (ACTIVE_RUN_PHASES.has(phase)) {
      const card = pendingApprovalForRun(run, pendingApprovals);
      if (card) {
        const reason = approvalReason(card);
        return waiting("Waiting for you", {
          state: "waiting-for-permission",
          message: `approval needed: ${reason}`,
          errorReason: `the agent needs approval to ${reason}`,
          errorAction: "use the approval card in the conversation to allow it",
          errorCategory: "permission",
          ...(typeof run.executionId === "string" && run.executionId ? { executionId: run.executionId } : {}),
        }, card);
      }
      return working();
    }
    if (phase.startsWith("paused")) {
      const reason = boundedText(run?.pause?.reason, 90);
      return waiting(reason || "Waiting for you", {
        state: "waiting-for-permission",
        ...(reason ? { message: reason, errorReason: reason } : {}),
        errorCategory: pauseCategory(run),
        ...(typeof run.executionId === "string" && run.executionId ? { executionId: run.executionId } : {}),
      });
    }
    if (phase === "failed") return failed(failedOutcome());
    if (phase === "cancelled") {
      return Object.freeze({ state: "cancelled", dot: "error", timeline: "failed", outcome: failedOutcome(), status: null, card: null });
    }
    if (phase === "done" || phase === "terminal") return terminalFailed ? failed(failedOutcome()) : done(doneOutcome());
  }
  if (terminalFailed) return failed(failedOutcome());
  const threadStatus = thread && typeof thread === "object" ? String(thread.status ?? "") : "";
  if (threadStatus === "running") return working();
  if (threadStatus === "error") return failed("Didn’t finish");
  if (threadStatus) return done("");
  if (phase) return done(doneOutcome());
  return Object.freeze({ state: "idle", dot: "", timeline: "", outcome: "", status: null, card: null });
}

/** The thread title from ONE source for the live and the reopened view: the
 * persisted thread's name, else the placeholder. The live view used to hold
 * "New task" until its run settled while a reopened tab already showed the
 * name the store had given the thread the moment it was created. */
export function projectThreadTitle(thread, { placeholder = "Task" } = {}) {
  const name = typeof thread?.name === "string" ? thread.name.trim() : "";
  return name || placeholder;
}
