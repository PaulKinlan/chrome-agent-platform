# Agent Execution Architecture — Feasibility Deep-Dive

**Status:** design proposal (no code changes). Owner question: should each agent be its own isolated worker instead of everything running in the MV3 service worker?

**Verdict (TL;DR):** Feasible and worthwhile — but recommend **per-agent DEDICATED workers hosted by the single existing offscreen document**, with the service worker as the durable coordinator/launcher — **not shared workers**. Shared workers are workable but buy nothing over dedicated workers given the extension's existing service-worker-routed message model, while adding naming/discovery complexity. The real win is **fault + memory isolation** (one crashed/leaky agent no longer kills the router + every other agent), not raw throughput.

---

## 1. Current state — what actually runs in the service worker

The agent-do loop runs **inside** the MV3 service worker:

- `extension/background/service-worker.js` → `runTask()` → `withRunLock` → `admitDurableRun` → `lib/agent.js` → `createAgent()` → `agentDoCreateAgent()` (the real `agent-do` library). `agent-do`'s loop (step → model call → tool use → step-complete) runs its state machine in the SW realm.
- Scheduled/background runs enter through `chrome.alarms` → `handleAlarm` → `runTask(...)` — **also in the SW**.
- Tool dispatch, memory reads/writes, the run-fence/in-flight machinery, durable-runs journal, and the orchestrator all share that one realm and one thread.

### What is already offloaded (important — the SW is not monolithic today)

- **Bundled Wasm tools already run in dedicated workers.** `lib/wasm-executor.js` `defaultCreateWorker` does `new Worker(workerUrl, {type:"module"})` → `lib/wasm-execution-worker.js` instantiates the Wasm and runs it. So the single most CPU-heavy work (Wasm compile/execute, WASI runtime) is already out of the SW's thread. Note the worker is constructed in a **non-SW** context (the tool preview / options page / offscreen path), consistent with the constraint below.
- **An offscreen document already exists** as a singleton host (`service-worker.js` `ensureOffscreen()`, reasons `["WORKERS","DOM_SCRAPING"]`) for sandboxed agent-script execution. The launch/check/mutex/justification pattern we need is already proven in this codebase.
- **Durability already spans realm death.** `lib/durable-runs.js` persists the journal/thread/registry triple (chrome.storage kv + OPFS); `lib/memory.js` is OPFS-backed (origin-keyed + per-named-agent sandbox). Run state, logs, and memory survive the SW being killed — this is the foundation any worker migration builds on.

### The real ceilings (honest)

1. **One realm, one thread.** All agents interleave on one JS event loop. Async streaming (provider `fetch` streams) is cheap and keeps the SW alive, so *throughput* is not the hard limit — dozens of concurrent streaming loops can interleave. The hard limits are:
2. **Fault containment.** An uncaught error in one agent's loop (or a tool bug that throws at the top level) can fault the shared SW realm → **every** agent and **every** message route dies until Chrome restarts the SW. This is the strongest architectural argument for isolation.
3. **Memory.** One realm accumulates every agent's history, model buffers, and in-flight state. A single leaky/large agent degrades all others; there's no per-agent memory bound enforced by the runtime.
4. **CPU.** Remaining sync work in the loop (history projection/JSON parsing, large tool results, memory serialization) blocks the thread and stalls concurrent agents + routing. Wasm is already offloaded; this residual is modest but real.
5. **The 30s-idle rule.** Long runs keep the SW alive via active streams, but the *interaction* between many long-lived streams and Chrome's SW lifecycle is the operational fragility the owner has already seen ("killed worker → every surface blanks", fixed with bounded loads at 0.2.302).

**Net:** the concurrency ceiling is not "N agents can't run" — it's "one bad agent or one memory spike degrades/kills the router that everything else depends on."

---

## 2. Can a service worker create/maintain SharedWorkers?

**No.** `SharedWorker` (and the dedicated `Worker`) constructor are not available in the `ServiceWorkerGlobalScope` — they exist on `Window` and `WorkerGlobalScope`. The service worker cannot construct either. The codebase is consistent with this: the SW never calls `new Worker`/`new SharedWorker`.

The established pattern is:

```
service worker ──chrome.offscreen.createDocument(reason:"WORKERS")──▶ offscreen document ──new SharedWorker()/new Worker()──▶ worker(s)
```

The **offscreen document is a page-like (Window) context**, so it *can* create and hold both dedicated and shared workers. This is exactly the pattern the extension already uses (`ensureOffscreen()`).

### Offscreen lifetime constraints (the crux)

- **One offscreen document per extension profile at a time.** All agents' workers must live in that ONE doc (already the case for the script sandbox).
- **Chrome may close the offscreen document** when it's idle or its declared reasons are no longer satisfied; lifetime is not indefinite. A `justification` string is required at creation.
- Therefore the offscreen doc is **disposable**, not a permanent host. The service worker must treat it as "create-on-demand, recreate-on-wake."

### SharedWorker lifetime

- A shared worker lives **while at least one `MessagePort` is connected**; it is destroyed when the last port closes.
- It is **named** (`new SharedWorker(url, {name})`) and the same `url + name` returns the **same** instance.
- **There is no enumeration API.** You can only "find" a shared worker by constructing one with the same URL+name (deduplication), never by listing instances.

---

## 3. Shared worker per agent vs dedicated worker per agent

Given the constraints above, compare the two candidates (both hosted by the offscreen doc):

| | Shared worker per agent | Dedicated worker per agent (recommended) |
|---|---|---|
| **Isolation** | same | same |
| **Multi-client ports** | NTP + sidepanel + SW can each hold a raw `MessagePort` to the *same* live worker | one port to its creator (offscreen doc); UI talks via the SW/BroadcastChannel |
| **Discovery** | convention name (`{name: agentId}`) — no enumeration; a late joiner must reconstruct the exact URL+name | no naming needed — the offscreen doc is the authoritative creator and holds the only port |
| **Lifetime** | dies when the *last* port closes → the offscreen doc must hold a port per agent anyway | dies when the offscreen doc's single port closes → same reconciliation |
| **Migration cost** | higher (naming, port fan-out, client reconnection) | lower (one creator, one owner) |

**Recommendation: per-agent DEDICATED workers.** The shared worker's only real advantage is multiple *simultaneous raw ports* from the UI — but the extension's message model deliberately routes **everything** through the service worker's validated routes (auth, grant-lock, redaction, permission gating). The UI does not need a raw port to the agent; it posts messages via the SW and subscribes to state via `BroadcastChannel`. Shared workers therefore add naming/discovery complexity for a benefit we don't use. If we later want the UI to hold a live low-latency stream directly to an agent, shared workers become the right tool — but that's a follow-on, not the first step.

---

## 4. Discovery & coordination

Because there's no enumeration API, discovery is **convention-based + SW-as-authority**:

- **Deterministic identity:** worker URL `workers/agent-executor.js` + the agent's durable id threaded through the worker's bootstrap message (not a shared-worker name). The offscreen doc is the **only** creator and holds the one authoritative port map `agentId → { worker, port }`.
- **BroadcastChannel** `cap:agent:<agentId>` for **state broadcast** (run phase, latest progress, logs cursor) so the NTP/sidepanel/any surface can render live state without a raw port. BroadcastChannel is connectionless and available across all contexts in the extension origin — but note it does **not** keep a worker alive; only a port does.
- **SW is the rendezvous/launcher:** a surface that wants an agent asks the SW; the SW ensures the offscreen doc + that agent's worker exist, then the worker streams progress via BroadcastChannel and returns results via the SW's durable-runs journal. Late joiners read the journal + subscribe to the channel — they never need to "find" the worker.

---

## 5. Lifetime & reconciliation (the part that must be right)

Authoritative state — **"which agents should be alive"** — lives in the **service worker**, durably (chrome.storage), not in any worker.

Reconciliation loop (all idempotent):

1. **Wake:** `chrome.alarms` (persist across browser restart) wakes the SW for a background agent's scheduled run.
2. **Ensure host:** SW calls `ensureOffscreen()` (reuse the existing singleton logic).
3. **Ensure agent worker:** SW asks the offscreen doc for `agentId`'s worker; if absent, the offscreen doc creates it and posts the run's durable context (executionId, resume token, memory origin, provider binding — all from the SW's stored state).
4. **Dispatch:** the worker runs the agent-do loop, streaming progress via `cap:agent:<agentId>` and committing via the durable-runs journal (which already survives death).
5. **On any death** (SW killed, offscreen closed, worker faulted): the next alarm/wake re-runs the reconcile. Because the journal + resume tokens are durable, a crashed worker resumes from its last committed state instead of re-running side effects (the round-26 class of guarantees carries over).
6. **Foreground agents** (named/site, launched from the NTP): same worker host, but the run is triggered by the UI via the SW rather than an alarm; "alive" state is still SW-authoritative.

**Background agents survive zero visible pages** because nothing in the chain depends on a page: alarms wake the SW, the SW creates the offscreen doc, the offscreen doc creates the worker, the worker runs independently. NTP/sidepanel can be fully closed.

---

## 6. Migration phasing

**Phase 0 — keep the loop in the SW, harden the blast radius** (smallest risk): make every agent loop's top-level `catch` a hard fault boundary (no uncaught rejection escapes to the SW realm), and cap per-agent in-flight memory. Low effort, partial isolation.

**Phase 1 — move the agent-do run loop into the offscreen host** (the core move): add an agent-executor worker entry, have the SW dispatch `runTask`'s loop to the offscreen-hosted worker instead of running it inline, while keeping routing/auth/storage/grant-lock/durability in the SW. Reuse the existing `ensureOffscreen()` + claim protocol already used for the script sandbox.

**Phase 2 — per-agent dedicated worker + BroadcastChannel state** (the isolation payoff): one worker per live agent, `cap:agent:<id>` state channel, the SW's reconcile-on-wake manager.

**Stays in the SW (forever, by design):** message routing + auth (`requireSettingsSender` et al.), the browser-control grant lock + permissions authority, alarm scheduling, durable-runs journal authority, provider/credential authority, the run fence. The SW remains the *single message and authority chokepoint* — it just stops *executing* the loop.

**Concurrency win:** the SW is freed to route while each agent runs on its own thread (dedicated worker) in its own realm. One agent's crash/memory blowup is contained to that worker (and recoverable via the durable journal) instead of taking down the router.

---

## 7. Risks & open questions

- **Offscreen doc is a single point of failure for all workers** (one doc hosts all agents). If Chrome closes it, every live agent dies together — mitigated by the SW reconcile-on-wake, but a *visible-page-less* long-running agent could be interrupted by offscreen reclamation mid-run. Need to verify the actual reclamation behaviour in a real build (the existing sandbox already depends on this doc, so the exposure is pre-existing and observable).
- **The `chrome.offscreen` API requires no manifest permission** — confirmed by this codebase: `ensureOffscreen()` calls `chrome.offscreen.createDocument(...)` and works with `permissions: []` and no `offscreen` entry. The only requirement is that the offscreen document URL is inside the extension.
- **MessagePort fan-out latency:** routing a run's streaming progress through BroadcastChannel + the SW (vs. a raw port) adds a hop; acceptable for our UI, but confirm the transcript stays near-real-time.
- **Provider credentials never cross into the worker** (same invariant as today: the worker gets a *binding* (resolved model) not the raw key; credentials stay SW-only). Must be preserved when moving the loop.
- **Open:** whether Chrome's offscreen `WORKERS` reason tolerates long-lived workers or reaps them aggressively; whether a single offscreen doc can host N workers without throttle; whether `BroadcastChannel` fan-out to many surfaces scales.

---

*Sources: codebase evidence (service-worker.js `runTask`/`ensureOffscreen`, lib/agent.js `agentDoCreateAgent`, lib/wasm-executor.js `defaultCreateWorker`, lib/durable-runs.js, lib/memory.js OPFS) + Chrome MV3/offscreen/SharedWorker lifecycle facts. The offscreen `reason` enum (`WORKERS`), one-doc-per-profile, shared-worker port-lifetime and no-enumeration are documented Chrome/MDN behaviours consistent with this codebase's own offscreen singleton.*
