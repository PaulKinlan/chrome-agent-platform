# Agent Delegation Contract (G5)

**Status:** implemented (candidate on branch `cap-agent-delegation`). Any named
agent can be invoked BY another named agent as a tool — "agents invocable as
skills".

## The model

- **Tool surface:** `delegate_to_agent` (management tool, discoverable via
  `search_tools`). Args: `{ agent, task, context? }`. The result returns to the
  calling run as the tool result: `{ ok, agent, childRunId, result }` or a
  structured denial `{ ok: false, code, error }`.
- **Authorization:** per-edge. The agent record carries `canDelegateTo`
  (agent ids; empty = cannot delegate; max 8). Editable in the agent editor
  ("Can delegate to") and bound into the owner-approval payload of
  `named-agent.create`/`named-agent.update` (an edge change can never ride
  unapproved inside another edit).
- **Caller identity:** never a tool argument. The model-facing dispatcher binds
  the run's execution id into the route *context*
  (`bindModelApprovalDispatcher`); `dispatchRoute` strips `__`-prefixed body
  keys, so the model cannot forge a caller. The `named-agent.delegate` route
  resolves the caller from `context.executionId` against the live run registry
  (`activeDelegationRuns`) — a stale or foreign execution id fails closed.

## Loop guards (all in `extension/lib/agent-delegation.js`, pure + KAT-driven)

- **Depth:** ≤ 2 (root run = 0; a depth-2 run cannot delegate).
- **Cycles:** the target must not appear in the delegation path (A→B→A denied;
  self-delegation denied).
- **Descendant cap:** ≤ 4 child runs per root run (in-memory registry,
  released when the root settles, bounded + evicting).
- **Budget:** the child's iteration cap is `min(parentRemaining, 6)`; fewer
  than 2 remaining parent iterations denies the delegation. The parent's
  consumed iterations are tracked from the live progress stream.

## Execution

- The child runs through the SAME named-agent run pipeline
  (`runNamedAgentTask`, factored verbatim from `named-agent.run`): its own OPFS
  sandbox, prompt scope (`agent:<slug>`), role, provider override, journal.
- `skipRunLock: true` on the child — the run mutex is not re-entrant and the
  parent holds it while awaiting the tool result. This is safe because a named
  run always builds a FRESH orchestrator (own memory + abort controller); depth
  + descendant caps bound the concurrency this opens (≤ 1 top-level run plus a
  bounded descendant tree, strictly nested: the parent is suspended while the
  child runs).
- The shared run-context singleton is saved/restored around the child (the
  parent is parked, so nesting is exact; if the parent settled first, the child
  clears instead of restoring a stale stamp).
- The run fence needs no save/restore: delegation-capable (named) runs are
  never fenced.
- A child that needs a *browser-destructive* tool while the parent's run holds
  the browser-command lease gets the honest single-driver refusal ("another
  surface is driving the browser") — two agents never drive the browser
  concurrently.

## Permissions

- The child inherits NO approvals from the parent (`approvalBinding: null`,
  fresh execution id). Its tool approvals go through the normal owner-approval
  flow under its own identity. A permission resume of a child run resumes it as
  a top-level run of that agent (delegation context is not resumed).

## Audit + UI

- Every completed/failed delegation is a durable record in the bounded audit
  log (`cap:delegation-log` in the master store, cap 100): parent/child run
  ids, agent names, a 140-char task summary, outcome. Read route:
  `named-agent.delegations`.
- In the parent's run view the delegation is the `delegate_to_agent` tool card
  (call + result, including the child run id). The child's progress events
  carry `parentRunId`; the child's journal entries live in its own history.

## Verification

- `tests/agent-delegation.test.ts` — 16 KATs (guards, registry, record
  persistence through the real named-agents layer, tool wiring incl. the
  forgery pin, audit bounding, SW source pins). Falsification-verified: the
  file fails against pre-change code (module import) and the SW pins fail
  against the pre-change service worker.
- `scripts/kat-agent-delegation.ts` — 15-check real-browser KAT (loaded
  extension, demo provider): allowed delegation runs the child in its own
  sandbox and returns its result; audit entry written; parent journal links
  the child run id; edge-less agent gets the structured denial; the agent-chat
  surface renders the delegation (screenshot).
- Demo model marker: `@demo-delegate-agent <id-or-name>` drives a real
  `delegate_to_agent` call deterministically.
