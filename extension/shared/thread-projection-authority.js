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
      typeof message?.content !== "string"
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
