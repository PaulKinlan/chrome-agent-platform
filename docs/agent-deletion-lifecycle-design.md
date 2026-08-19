# DESIGN — Agent deletion lifecycle (research → product decision)

Status: DESIGN RESEARCH ONLY (no implementation, no product-byte changes).
Public-safe: no local paths, session/relay identifiers, credentials, or
personal data. All references are repository-relative to public `origin/main`
commit `5e5c81e` unless explicitly marked as belonging to the unshipped
artifact-transaction lane (`CAP-FB-20260818-ARTIFACT-TX-01`).

## 1. Store map (what a named agent touches on disk)

Exact keys/paths verified against public source `5e5c81e`:

| Store | Key / path | Content | Deletion-relevant? |
|---|---|---|---|
| chrome.storage | `cap:namedAgents` | Named-agent registry (name/role/prompt/model/**embedded `coreAssets`**) — `extension/lib/named-agents.js:20` | YES — authority |
| chrome.storage | `cap:promptOverrides` + `cap:promptOverrides:quarantine` | Prompt-override audit/quarantine (`extension/lib/system-prompts.js:192-193`) — the delete gate scans these fail-closed | YES — dependency check |
| chrome.storage | `cap:scheduledTasks` | Scheduled-task payloads (background/recipe runs) — `extension/lib/scheduler.js:8` | recipe lifecycle only |
| OPFS `memory/master/` (master-memory store: versioned per-key files) | `journal.json` (versioned envelope), `customRecipes.json` (user recipe copies — built-in recipes are code; **no `cap:recipes` key exists**), `threads.json`, `screenshots/*` | master journal + recipes + thread index | threads are agent-agnostic |
| OPFS `memory/agents/<encodeURIComponent(slug)>/` (`memory.js:454`) | per-agent store: own versioned `journal.json`, memory keys, threads when scoped | agent-owned | YES — disposal candidate |
| OPFS `memory/origins/<origin>/` | site memory/tools/journal | site-agent-owned | site `agent.delete` pattern exists |
| OPFS `memory/master/` | `asset:<id>.json` + `assets.json` | artifact bodies + index | NO ownership link today |
| chrome.alarms | `task:…`, `recipe:<id>` | scheduled/background runs | recipes only |

## 2. Current deletion semantics (exact)

- **Named agent** (`extension/lib/named-agents.js:254` `deleteNamedAgent`):
  owner-approval gate → prompt-override scan (fail-closed) → registry row
  removed (`cap:namedAgents`) → per-agent `memory.clear()` best-effort. One
  method, synchronous, **no rollback, no in-flight handling, no artifact
  handling** — and the registry row carries **embedded `coreAssets`
  (`{name,type,content}` copies) that die with the row today**.
- **Site agent** (`service-worker.js` `agent.delete`): the strongest existing
  pattern — tombstone-first (disenrolled+revoked committed before teardown) →
  `abortWorker` → bridge notify → `allSettled` scripts + memory.
- **Background agent** (recipe): `task.cancel` clears alarm + payload; the
  registry derives enabled-state from the schedule store.
- **In-flight executions** (exact gap): `named-agent.run`
  (service-worker.js:2475-2513) resolves the agent, gets its memory, calls
  `runTask` — it registers **no agent-bound execution record**, no deletion
  generation, no abort controller addressable by deletion. `runTask` uses the
  module-global serialized run fence (`lib/run-fence.js`) only; the per-worker
  `runGenCell` generation fence (line ~794) covers **site-tool** staleness,
  not named agents. `activeExecutions` is an in-memory `Set` — lost on SW
  restart, and keyed by execution, not by agent.

## 3. Gaps

1. **No durable deletion intent**: a crash between gate and registry write
   leaves the outcome ambiguous (no marker).
2. **No in-flight run settlement**: a `named-agent.run` can outlive the
   registry row and commit its journal/memory afterwards.
3. **No artifact disposition**: registry row embeds `coreAssets`; produced
   artifacts (unshipped lane) have no ownership attribution. **Deleting the
   registry row today silently destroys the embedded core assets — real user
   data (`{name,type,content}` copies).**
4. **No deletion evidence**: no record of what was disposed, failed, or kept.
5. **No transactional substrate on public main**: the artifact-transaction WAL
   lives on the unshipped lane; public `memory.js` offers single-key atomic
   writes with version envelopes + `getVersion`, but no multi-key transaction.

## 4. Design — lifecycle state machine (owner-only)

### 4.1 Transaction authority (explicit, honest)

This design **requires a durable multi-step intent/reconcile mechanism that
does not exist on public `5e5c81e`**. Two routes, stated explicitly — the
implementation must pick one before any code lands:

- **(A) Dependency on `CAP-FB-20260818-ARTIFACT-TX-01`** (currently
  `READY_FOR_BROWSER`, unshipped): its WAL/`__tx` primitive in the OPFS
  master store provides exactly the durable-intent + recover-on-startup
  semantics this lifecycle needs. If the implementation lands after the
  artifact transaction, deletion intent records ride the same WAL discipline
  (begin → steps → commit marker, fail-closed on corrupt WAL, recovery sweep
  on startup). **This is a hard ordering dependency: deletion implementation
  MUST NOT land before the transaction primitive.**
- **(B) Self-contained minimal protocol** (if the artifact lane does not
  land): deletion intent as a **single atomic master-store write**
  (`delete-intent:<agentId>` — one file write is the atomic boundary), all
  subsequent steps journaled as monotonic step markers, lock ordering fixed
  (intent lock → per-agent store lock → registry lock, never reversed),
  reconcile-on-startup: an intent without a `committed` marker resumes at its
  last journaled step (every step idempotent; artifact disposition re-runs
  safely because disposition decisions are recorded before execution).
  Corruption behavior: a corrupt intent record fails closed (deletion does
  not proceed; the agent remains) — mirroring the fail-closed philosophy
  without importing unshipped code.

A durable master-store value surviving restart is NOT a transaction; the
state machine below only becomes transactional via (A) or (B).

### 4.2 NEW durable agent-bound execution registry (prerequisite)

The settlement gap (§2) requires a **new durable execution registry**
(`agent-exec:<agentId>` in the master store), written by `named-agent.run`
before the model call starts: `{ agentId, executionId, generation, startedAt,
heartbeatAt, state: running|settling|terminal|aborted }`. A deletion:

1. writes the **deletion tombstone** `{ deletedAt, generation: G }` onto the
   agent's registry record FIRST (durable, single-key atomic);
2. reads the execution registry, requests abort of each `running` execution
   (the run loop checks the abort controller between model/tool steps — the
   cooperative-cancellation limit is inherited: a started page side effect
   cannot be unwound);
3. **awaits acknowledgement** (bounded): each execution either reaches
   `terminal|aborted` or its heartbeat goes stale, at which point the
   reconcile sweep treats it as dead;
4. every **journal/memory commit inside a named-agent run revalidates the
   agent's registry record before AND after the durable write**: the agent id
   must still exist AND its `generation` must equal the execution's
   generation; a tombstoned/deleted record makes the commit fail closed and
   the run aborts. This is the named-agent analogue of the existing
   `runGenCell` site-tool fence, extended across restarts by being durable.

Registry rows are folded (bounded retention) once `terminal|aborted` ages
past a cap; the tombstone outlives all executions of that generation.

### 4.3 States

`ALIVE → DELETE_REQUESTED (gate passed) → INTENT_DURABLE →
RUNS_SETTLED (via §4.2) → ARTIFACTS_DISPOSED (per the OPEN policy decision,
incl. embedded coreAssets) → MEMORY_DISPOSED (named store, idempotent; any cleanup failure → durable retryable CLEANUP_FAILED, never continuing to removal) →
REGISTRY_REMOVED (LAST — the row, and with it any coreAssets bytes still
embedded, is removed only after artifact disposition is recorded) →
COMMITTED (marker + evidence) → [reconcile sweep clears intent]`.

Each transition is a durable step (via §4.1). FAILURE POLICY IS FAIL-CLOSED:
any memory/prompt/dependency cleanup failure STOPS the state machine BEFORE
`REGISTRY_REMOVED` in a durable RETRYABLE state (`CLEANUP_FAILED`) — the
failure is recorded in evidence, the authority row is NEVER removed while
cleanup is incomplete (removing the authority row with cleanup outstanding is
exactly the orphan/recovery defect this task exists to prevent), and the
reconcile sweep resumes the failed step on restart or owner retry.
`REGISTRY_REMOVED` is always last, always requires the gate, and always
requires every prior step's success marker. (This deliberately departs from
the site-agent pattern's best-effort `allSettled` teardown: site stores are
re-derivable via re-enrollment; named-agent stores and the registry authority
are not.)

### 4.4 Dependency preview (must include embedded core assets)

Before the gate, the owner sees: schedules referencing the agent (recipes —
currently none for named agents), threads mentioning it (informational),
**the embedded `coreAssets` list (name/type/size)** under the registry row,
and (once the artifact lane lands) artifacts attributed to the agent. The
preview states the disposition that the SELECTED policy will apply to each
class. Deletion without a decided artifact policy is not permitted.

### 4.5 Evidence

A deletion record (`deletedAt`, agent id, steps with ok/failure, artifact
disposition applied including each embedded core asset's fate, gate id)
persisted in the master store — the audit trail the gap analysis found
missing.

## 5. Artifact policy — EXPLICITLY OPEN

The product decision required before implementation, applied to **BOTH**
artifact classes: (1) **embedded `coreAssets`** under `cap:namedAgents`
(exist TODAY — real user data) and (2) produced artifacts under
`memory/master/` (ownership attribution lands with the artifact lane). Same
option set for both classes:

| Option | Semantics |
|---|---|
| A. Block on artifacts | deletion refuses while any artifact of the class exists |
| B. Export-then-delete | owner exports/downloads, then deletion proceeds |
| C. Orphan with tombstone | artifacts survive, attributed to a tombstone marker |
| D. Owner-explicit cascade | separate approval phrase; deletes artifacts |
| E. Archive | move to an archived namespace, restorable |

No silent cascade is acceptable for EITHER class: the registry row must not
be removed (destroying embedded `coreAssets`) until the selected option has
dispositioned them. Fixtures must cover both classes.

## 6. Acceptance criteria (for the future implementation)

1. Deleting an agent with no artifacts: all states transition durably; a kill
   between any two steps reconciles to completion or fails closed with the
   agent intact; evidence exists.
2. Deleting with an in-flight `named-agent.run`: the run aborts (or
   completes) BEFORE `REGISTRY_REMOVED`; no post-delete journal/memory commit
   from the deleted generation (pre/post-write revalidation proven by kill
   injection at each commit boundary).
3. Deleting with embedded `coreAssets` and/or produced artifacts follows the
   selected policy exactly (fixture per option A–E, each fixture containing
   BOTH classes); none is silently dropped.
4. Registry removal is provably last: no registry mutation before runs
   settled + artifacts disposed; embedded coreAssets bytes exist until
   disposition.
5. An SW crash immediately after gate (before intent) loses nothing; after
   intent, restart resumes reconciliation idempotently.

## 7. Acceptance fixtures

- `fixture-delete-clean` — no runs, no artifacts; kill at each step boundary.
- `fixture-delete-inflight` — a run mid-flight; kill injection at each
  journal/memory commit boundary; abort + settlement + revalidation asserted.
- `fixture-delete-artifacts-<option>` — per policy A–E; each fixture carries
  embedded coreAssets AND produced artifacts.
- `fixture-delete-restart` — kill after intent durable; restart reconciles.
- `fixture-delete-gate-deny` — approval denied; nothing changes.

## 8. Explicitly out of scope

Implementation; changes to site-agent deletion (pattern source only);
thread/history deletion (agent-agnostic by design); the artifact-policy
decision itself (owner's); the transaction-substrate choice (A vs B —
decided before implementation, not here).
