// lib/agent.js — the agent core, built on the REAL agent-do library.
//
// This imports createAgent from "agent-do" (bundled by esbuild) — not a
// reimplementation. Our `createAgent` wrapper calls agent-do's createAgent.
// memory tools + the onUsage hook (→ usage.js). The hub can fan out to
// per-site sub-agents via delegation tools (the 1-agent vs N-agent flag).

import { createAgent as agentDoCreateAgent } from "agent-do";
import { tool } from "ai";
import { z } from "zod";
import { recordUsage } from "./usage.js";
import { buildSkillsPrompt } from "./skills.js";
import { grepAgentMemory } from "./named-agents.js";
import { assertRunOwned } from "./run-fence.js";
import { MODEL_PRICING } from "./model-prices.js";
import { isToolResultFailure } from "./tool-summary.js";

const DEFAULT_SYSTEM =
  `You are the Chrome Agent Platform hub agent. You help the
user get things done on the web. You can read and write memory, call tools, and
delegate to per-site sub-agents. Be concise; prefer actions over prose.

For REPEATABLE work, write a script (create_script) and run it (run_script) or
schedule it (schedule_task with scriptId) instead of re-reasoning every time — a
script runs the same JavaScript without re-invoking the model (speed, security,
verifiability). A script is an ASYNC function body; it runs SANDBOXED with a
CONTROLLED api: await fetch(url, opts) (reads an http/https page, returns
{status, text}) and log(...). No DOM, no extension APIs, no network of its own.
return the result.`;

export function memoryToolset(memory, enrollmentGuard = null, getRunGen = null, readOnly = false) {
  if (!memory) return {};
  // Reads must be ENROLLMENT-scoped too (the round-24/25 finding: memory_get/
  // memory_list were completely unfenced, so a stale deleted worker could read a
  // re-enrolled origin's memory through the reused origin path). Return an error
  // instead of the value when the run-start generation no longer matches the
  // current enrollment.
  const enrolledGuard = async () => {
    if (!enrollmentGuard) return null;
    const g = await enrollmentGuard();
    const runGen = getRunGen?.() ?? null;
    if (!g?.ok) return { error: g?.error ?? "origin not enrolled" };
    if (runGen != null && (g.gen ?? 0) !== runGen) {
      return { error: "origin re-enrolled during run — memory read rejected" };
    }
    return null;
  };
  const tools = {
    memory_get: tool({
      description: "Read a value from the agent's memory.",
      inputSchema: z.object({ key: z.string() }),
      execute: async ({ key }) => {
        const err = await enrolledGuard();
        if (err) return err;
        const value = await memory.get(key);
        // POST-read generation revalidation (the round-26 blocker): a re-enroll
        // DURING the awaited read must not return the NEW enrollment's data to
        // the stale run. Read into a temp, revalidate the immutable generation,
        // then return — never surface a value read under a fresh enrollment.
        const err2 = await enrolledGuard();
        if (err2) return err2;
        return { key, value };
      },
    }),
    memory_set: tool({
      description:
        "Write a value to the agent's memory. Values are bounded (256 KiB) and reserved registry keys are protected.",
      inputSchema: z.object({ key: z.string().min(1).max(128), value: z.any() }),
      execute: async ({ key, value }) => {
        // memory_set is a durable side-effecting boundary — fence it BEFORE the
        // write (the round-16 fence coverage finding) AND AFTER the awaited OPFS
        // write (the round-18 finding). On abort AFTER a committed overwrite,
        // RESTORE the previous value (or delete a newly-created key) — never
        // delete an existing key wholesale (the round-19 blocker: an overwrite
        // abort deleted the ENTIRE prior key).
        // DUrable ownership must be asserted BEFORE the write (not merely the
        // signal) — the round-20 blocker where a memory_set ownership-only loss
        // threw while the signal was still live and the catch did NOT compensate.
        try {
          await assertRunOwned();
          // A WORKER's memory write must revalidate the IMMUTABLE run-start
          // generation — NOT merely "currently enrolled" (the round-22 ABA
          // blocker: delete→re-enroll bumps the generation, so a stale run whose
          // guard re-reads "currently enrolled" would pass and write into the
          // NEW enrollment). The guard returns {ok, gen}; the run captured its
          // generation at START (getRunGen), so a re-enrolled origin's fresh gen
          // mismatches and the write is rejected.
          if (enrollmentGuard) {
            const g = await enrollmentGuard();
            const runGen = getRunGen?.() ?? null;
            if (!g?.ok) {
              return { error: g?.error ?? "origin not enrolled — memory not written" };
            }
            if (runGen != null && (g.gen ?? 0) !== runGen) {
              return { error: "origin re-enrolled during run — memory not written" };
            }
          }
        } catch {
          return { error: "run aborted — memory not written" };
        }
        let prev = undefined;
        let existed = false;
        let committed = false;
        let wroteVersion = null; // the durable version token `set` returns (round-27)
        try {
          // Existence must be checked via `has`, NOT via `get` returning
          // non-null: a legitimate stored `null` value is indistinguishable from
          // an absent key through `get` alone, so the old `existed = prev !==
          // undefined && prev !== null` classified a stored null as absent and
          // DELETED it on compensation (the round-22 null-compensation bug).
          existed = typeof memory.has === "function"
            ? await memory.has(key)
            : (await memory.get(key)) !== undefined;
          prev = await memory.get(key);
          await assertRunOwned();
          // Re-validate the IMMUTABLE run-start generation IMMEDIATELY before
          // the write (adjacent to set): the gen check at the top ran several
          // awaits ago (memory.has + memory.get), and a delete→re-enroll in that
          // gap would otherwise let a stale run write under the NEW enrollment
          // (the round-23 gen-adjacency finding — the gen was checked only before
          // has/get, not adjacent to set).
          if (enrollmentGuard) {
            const g = await enrollmentGuard();
            const runGen = getRunGen?.() ?? null;
            if (!g?.ok) {
              return { error: g?.error ?? "origin not enrolled — memory not written" };
            }
            if (runGen != null && (g.gen ?? 0) !== runGen) {
              return { error: "origin re-enrolled during run — memory not written" };
            }
          }
          // `set` returns the durable VERSION token for THIS write (the round-27
          // value-CAS ABA blocker). Capture it directly (not via a separate
          // getVersion read, which could observe a later concurrent write's
          // version). Compensation below targets this exact write.
          wroteVersion = await memory.set(key, value);
          committed = true;
          await assertRunOwned();
          // Re-validate the IMMUTABLE run-start generation AFTER the awaited set:
          // the gen check above ran BEFORE the OPFS write, so a delete→re-enroll
          // DURING the write would otherwise leave stale data committed under the
          // NEW enrollment (the round-24 gen-threading blocker — the gen was
          // checked adjacent to `set`, never AFTER it). A mismatch here throws so
          // the catch below compensates (restores prev / deletes the new key).
          if (enrollmentGuard) {
            const g = await enrollmentGuard();
            const runGen = getRunGen?.() ?? null;
            if (!g?.ok || (runGen != null && (g.gen ?? 0) !== runGen)) {
              throw new Error("origin re-enrolled during run — memory write compensated");
            }
          }
          return { ok: true, key };
        } catch (e) {
          // A bounded/reserved-key rejection is surfaced honestly, never thrown
          // into the agent loop. An abort/ownership loss AFTER the write (the
          // `committed` flag) compensates by restoring the prior value (or removing
          // a new key), not deleting an existing key's history. Ownership-only loss
          // (durable owner gone while the signal is still live) is compensated here
          // too — `committed` is set on ANY post-write fence failure, not just a
          // signal abort (the round-20 finding).
          //
          // Compensation must be ENROLLMENT-GENERATION-scoped (the round-25
          // blocker): only restore the previous value when the origin is STILL the
          // SAME enrollment (same run-start generation). A delete→re-enroll during
          // the awaited write means the NEW enrollment owns the store, and a stale
          // run must NOT overwrite/delete the new value.
          if (committed && typeof memory.set === "function") {
            try {
              let sameEnrollment = true;
              if (enrollmentGuard) {
                const g = await enrollmentGuard();
                const runGen = getRunGen?.() ?? null;
                if (!g?.ok || (runGen != null && (g.gen ?? 0) !== runGen)) {
                  sameEnrollment = false;
                }
              }
              const casDelete = typeof memory.compareAndDelete === "function";
              const casRestore = typeof memory.compareAndRestore === "function";
              if (sameEnrollment) {
                // VERSION-scoped CAS restore (the round-26/27 blockers): only
                // restore/delete if the key's CURRENT VERSION is still the version
                // THIS run wrote — a concurrent legitimate write by the SAME
                // enrollment (a parallel tool call in the same run) bumps the
                // version, so it is never clobbered, and an identical-value ABA
                // (a new write of the same JSON value) is distinguished by its
                // version. `wroteVersion` is the token `set` returned.
                if (existed) {
                  if (casRestore && wroteVersion != null) await memory.compareAndRestore(key, wroteVersion, prev);
                  else await memory.set(key, prev);
                } else {
                  if (casDelete && wroteVersion != null) await memory.compareAndDelete(key, wroteVersion);
                  else await memory.delete(key);
                }
              } else {
                // Generation mismatch (delete→re-enroll): REMOVE this run's
                // forbidden write from the NEW reused store via VERSION-scoped CAS
                // (only if the version is still this write's). Never restore the
                // OLD enrollment's `prev` into the new store, and never delete a
                // new-enrollment value that already replaced ours (the round-26/27
                // stale-write-survives-re-enrollment + value-CAS blockers).
                if (casDelete && wroteVersion != null) await memory.compareAndDelete(key, wroteVersion);
                else await memory.delete(key);
              }
            } catch { /* best-effort */ }
          }
          return { error: String(e?.message ?? e) };
        }
      },
    }),
    memory_list: tool({
      description: "List memory keys.",
      inputSchema: z.object({}),
      execute: async () => {
        const err = await enrolledGuard();
        if (err) return err;
        const keys = await memory.keys();
        // POST-read generation revalidation (the round-26 blocker): a re-enroll
        // DURING the awaited keys() read must not return the NEW enrollment's
        // keys to the stale run.
        const err2 = await enrolledGuard();
        if (err2) return err2;
        return { keys };
      },
    }),
    memory_grep: tool({
      description:
        "Search this agent's own memory (key-value store) AND run history (journal) for a substring. Returns matching keys + a bounded excerpt of each match, never the full store.",
      inputSchema: z.object({
        query: z.string().min(1).max(200).describe("the substring to search for"),
      }),
      execute: async ({ query }) => {
        const err = await enrolledGuard();
        if (err) return err;
        const result = await grepAgentMemory(memory, query);
        // POST-read generation revalidation (the sol addendum): a re-enroll
        // DURING the multi-key grep must not return the NEW enrollment's memory
        // to the stale run. Match memory_get/list — revalidate, then return.
        const err2 = await enrolledGuard();
        if (err2) return err2;
        return result;
      },
    }),
  };
  // SCOPED (hook) runs are side-effect-free: no memory_set. Untrusted event
  // data must never persist state to the hub/worker memory.
  if (readOnly) delete tools.memory_set;
  return tools;
}

/**
 * Wrap agent-do's createAgent with our conventions.
 * `model` is the resolved { model: LanguageModel, modelId, providerName } from provider.js.
 */
// A safe, bounded summary of a tool result for the LIVE progress stream. Full
// tool results can be huge (file contents, page HTML); the progress events must
// never leak large bodies into logs/ports. Truncate strings, stringify + cap
// objects, and never surface secrets.
function summarizeToolResult(result) {
  try {
    if (result == null) return "";
    if (typeof result === "string") return result.slice(0, 300);
    const s = JSON.stringify(result);
    return s.length > 300 ? s.slice(0, 300) + "…" : s;
  } catch {
    return "(unserializable result)";
  }
}

export function createAgent({
  model,
  id = "hub",
  name = "hub",
  system = DEFAULT_SYSTEM,
  tools = {},
  memory = null,
  skills = [],
  taskId = "adhoc",
  maxIterations = 12,
  enrollmentGuard = null,
  // `onProgress` receives normalized progress events (thinking / tool-call /
  // tool-result / text / done) from the agent-do loop, so the UI can show LIVE
  // progress as the agent works. Optional (the SW threads its broadcast through
  // it); null means no progress stream (the legacy request/response path).
  onProgress = null,
  // `disposable` marks a per-origin WORKER agent: abort() (agent.delete →
  // abortWorker) permanently disables it so a stale in-flight delegation can
  // never start a new run (the round-22 check→start blocker). The hub/master is
  // NOT disposable — its abort() cancels the current run only, and it is reused
  // across subsequent runs.
  disposable = false,
  // `readOnlyMemory` (SCOPED hook runs): memory_set is omitted — untrusted
  // event data must never persist state.
  readOnlyMemory = false,
}) {
  // The worker's immutable run identity, captured at run START. Because master
  // runs are serialized (withRunLock), at most one run is active per agent, so a
  // single slot is safe. `gen` is the enrollment generation the CALLER captured
  // at delegation start (or, for a direct run, captured here) — every worker
  // commit revalidates THAT generation, never "currently enrolled" (the round-22
  // ABA blocker).
  let activeRun = null; // { gen: number|null, controller: AbortController }
  let aborted = false;
  let lastRunAborted = false; // the DURABLE per-run abort flag (read after activeRun is cleared)
  // A per-worker RUN QUEUE serializes concurrent `a.run` calls. The AI SDK
  // executes a step's tool calls with Promise.all, so two delegate_task calls
  // for the SAME worker can invoke the same a.run CONCURRENTLY. The shared
  // `activeRun` slot + agent-do's single mutable abort controller are unsafe
  // under concurrency (the second run overwrites the first's identity; the first
  // `finally` clears the second's; abort() only reaches whichever controller is
  // currently stored) — the round-23 parallel-tool-call blocker. Queuing each
  // run behind the prior guarantees at most one run is active at a time, so the
  // shared slot + controller are always the CURRENT run's.
  let runQueue = Promise.resolve();
  // The progress callback is MUTABLE: the orchestrator (and its cached agents)
  // are REUSED across runs, but the callback is per-run (each run's caller is
  // the page that started it). The hooks below read this binding at emit time,
  // so a later run's setProgress() rebinds the LIVE stream without rebuilding
  // the cached agent.
  let progressCb = onProgress;

  const getRunGen = () => activeRun?.gen ?? null;

  const allTools = { ...memoryToolset(memory, enrollmentGuard, getRunGen, readOnlyMemory), ...tools };
  const systemPrompt = system + buildSkillsPrompt(skills);

  const agent = agentDoCreateAgent({
    id,
    name,
    model: model.model,
    systemPrompt,
    tools: allTools,
    maxIterations,
    usage: { pricing: MODEL_PRICING },
    hooks: {
      // LIVE progress hooks — forward the agent-do step/tool lifecycle to the
      // UI as normalized events. onProgress may be async (the SW broadcast is a
      // fire-and-forget postMessage), but the hooks are awaited by agent-do, so
      // they must never throw (a progress-emit failure must not kill the run).
      onStepStart: async (e) => {
        try { progressCb?.({ type: "thinking", step: e.step, totalSteps: e.totalSteps, tokensSoFar: e.tokensSoFar, costSoFar: e.costSoFar }); } catch { /* ignore */ }
      },
      onStepComplete: async (e) => {
        try { progressCb?.({ type: "text", text: e.text, step: e.step, hasToolCalls: e.hasToolCalls }); } catch { /* ignore */ }
      },
      onPreToolUse: async (e) => {
        try { progressCb?.({ type: "tool-call", toolName: e.toolName, toolArgs: e.args, step: e.step }); } catch { /* ignore */ }
      },
      onPostToolUse: async (e) => {
        try { progressCb?.({ type: "tool-result", toolName: e.toolName, step: e.step, durationMs: e.durationMs, result: summarizeToolResult(e.result), ok: !isToolResultFailure(e.result) }); } catch { /* ignore */ }
      },
      onComplete: async (e) => {
        try { progressCb?.({ type: "done", text: e.result, totalSteps: e.totalSteps, aborted: e.aborted }); } catch { /* ignore */ }
      },
      onUsage: async (record) => {
        // Worker usage is ENROLLMENT-scoped: a stale run must not append a usage
        // row under a re-enrolled origin. The IMMUTABLE run-start generation is
        // threaded INTO recordUsage (as the `guard`), which re-validates it
        // BEFORE and AFTER its commit + compensates on mismatch — not merely a
        // single pre-check that a re-enroll during recordUsage's awaits could
        // bypass (the round-22 + round-24 gen-threading findings).
        await recordUsage({
          agentId: id,
          taskId,
          provider: model.providerName,
          model: model.modelId,
          inputTokens: record.inputTokens ?? 0,
          outputTokens: record.outputTokens ?? 0,
          estimatedCost: record.estimatedCost ?? 0,
        }, enrollmentGuard
          ? { genGuard: enrollmentGuard, getRunGen }
          : null);
      },
    },
  });

  return {
    id,
    name,
    // Expose the worker's CURRENT run generation (the immutable run-start gen,
    // or null when no run is active). The SW threads this into the site-tool
    // invocation + the provider/usage boundaries so a stale run can never operate
    // under a re-enrolled origin's generation (the round-24 gen-threading blocker).
    getRunGen: () => activeRun?.gen ?? null,
    // agent-do's run(task, context, history) -> string. Our wrapper accepts a
    // FOURTH `runGen` argument: the immutable enrollment generation the caller
    // captured at delegation start. The run + its worker commits revalidate THAT
    // generation (delete→re-enroll ABA), and abort() before the run prevents the
    // start (the check→start gap where agent-do's own controller is null until
    // run() begins).
    run: async (task, context, history, runGen) => {
      // Serialize the run behind any prior run of THIS worker (see runQueue above).
      // `execute` carries the full original body; the queue always advances even
      // if a run rejects, so a failed run can never poison later runs.
      const execute = async () => {
      let gen = runGen ?? null;
      if (enrollmentGuard && gen == null) {
        // No caller-supplied generation (a direct worker run) — capture it now.
        const g = await enrollmentGuard();
        if (!g?.ok) return { error: g?.error ?? "origin not enrolled" };
        gen = g.gen ?? 0;
      }
      // PRE-START abort check: abort() may have been called while the guard await
      // above was in flight (agent.delete → abortWorker), and agent-do's own
      // abort() before run() is a no-op (its controller is null until run starts).
      // A disposable worker that was aborted must never begin a new run.
      if (aborted) return { error: "run aborted before start" };
      const controller = new AbortController();
      activeRun = { gen, controller };
      if (aborted || controller.signal.aborted) {
        activeRun = null;
        return { error: "run aborted before start" };
      }
      // Wire the run-scoped controller to agent-do so abort() during the run
      // cancels the model loop (agent-do's own abort() only works after its run()
      // started). The listener is removed in finally so a post-run abort can
      // never leak into a queued next run (the round-16 cross-run abort blocker).
      const onAbort = () => {
        try {
          agent.abort();
        } catch { /* no active run */ }
      };
      lastRunAborted = false; // per-run reset
      controller.signal.addEventListener("abort", onAbort);
      try {
        // Provider execution boundary: re-validate the IMMUTABLE run-start
        // generation IMMEDIATELY before the model loop starts (a re-enroll during
        // the queue await or the guard await above must not start a stale run —
        // the round-24 gen-threading blocker: the provider received no gen check
        // before agent.run).
        if (enrollmentGuard && gen != null) {
          const g = await enrollmentGuard();
          if (!g?.ok || (g.gen ?? 0) !== gen) {
            return { error: "origin re-enrolled before run — task not started" };
          }
        }
        const result = await agent.run(task, context, history);
        // Post-run generation revalidation: a re-enroll DURING the model loop
        // must discard the result rather than return it to the caller under a
        // stale enrollment (the round-24 finding — the provider path had no
        // post-run gen check).
        if (enrollmentGuard && gen != null) {
          const g = await enrollmentGuard();
          if (!g?.ok || (g.gen ?? 0) !== gen) {
            return { error: "origin re-enrolled during run — result discarded" };
          }
        }
        return result;
      } finally {
        // DURABLE per-run outcome: capture the abort state BEFORE activeRun is
        // cleared (the SW's isAborted() check runs after orch.run resolves —
        // activeRun is null by then, so the controller signal alone is lost).
        lastRunAborted = controller.signal.aborted;
        controller.signal.removeEventListener("abort", onAbort);
        activeRun = null;
      }
      };
      const result = runQueue.then(execute, execute);
      runQueue = result.then(() => {}, () => {});
      return result;
    },
    abort: () => {
      if (disposable) aborted = true;
      activeRun?.controller.abort();
      try {
        agent.abort();
      } catch { /* no active run */ }
    },
    // Rebind the live progress callback without rebuilding the cached agent.
    // The SW calls this per-run (the orchestrator is reused across runs).
    setProgress: (cb) => { progressCb = cb; },
    // Whether THIS agent's run was aborted (a disposable pre-start abort or a
    // mid-run controller abort) — the DURABLE per-run flag survives the
    // activeRun cleanup, so the SW can read it after orch.run resolves and
    // propagate it in the run response (an aborted run is never a success).
    isAborted: () => aborted || lastRunAborted,
  };
}

/**
 * Hub + per-site sub-agents. The hub is a single agent-do agent with delegation
 * tools; each worker is an agent-do agent for one site origin. `multiAgent`
 * toggles between the full fan-out and a solo hub agent.
 */
export function createOrchestrator({
  model,
  system = DEFAULT_SYSTEM,
  masterSystem = null,
  masterMemory,
  workers = [], // [{ origin, memory, skills, tools }]
  multiAgent = true,
  taskId = "adhoc",
  extraTools = {}, // browser-control + management tools (chrome.* — SW context)
  delegateGuard = null, // async (origin) => { ok, error } — revalidates live
                        // enrollment/generation before a delegated worker runs
  scoped = false, // SCOPED (hook) runs: the master gets read-only memory (no
                  // memory_set) — the extraTools caller already supplies the
                  // read-only browser set, so the master cannot persist state.
  onProgress = null, // async (event) => void — the live progress stream, threaded
                     // into BOTH the master agent and every delegated worker.
}) {
  const workerAgents = new Map();
  for (const w of workers) {
    const a = createAgent({
      model,
      id: w.origin,
      name: w.origin,
      system: w.system ?? system,
      memory: w.memory,
      skills: w.skills ?? [],
      tools: w.tools ?? {},
      taskId,
      // Thread the delegateGuard into each worker's memory tools so a worker's
      // memory_set revalidates its IMMUTABLE run-start generation before
      // committing (the round-21 blocker: worker tools got no enrollment token;
      // the round-22 ABA: revalidating "currently enrolled" instead of the
      // run-start generation let a delete→re-enroll stale write pass). The guard
      // already revalidates enrollment + generation; reuse it per-origin.
      enrollmentGuard: delegateGuard
        ? async () => delegateGuard(w.origin)
        : null,
      // Workers are DISPOSABLE: agent.delete → abortWorker permanently disables
      // the agent so a stale in-flight delegation cannot start a new run in the
      // check→start gap.
      disposable: true,
      // SCOPED (hook) runs are TRANSITIVELY side-effect-free (the sol addendum):
      // a delegated worker must ALSO get read-only memory (no memory_set) —
      // otherwise an untrusted hook payload could delegate into a worker that
      // writes site memory / invokes page tools, defeating the scoping.
      readOnlyMemory: scoped,
      onProgress,
    });
    workerAgents.set(w.origin, a);
  }

  // SCOPED (hook) runs must not delegate (the sol addendum): a hook-invoked
  // run is side-effect-free, so it gets NO delegate_task — an untrusted event
  // payload must not fan out into site workers that invoke page tools.
  const delegate = (multiAgent && !scoped)
    ? {
      list_agents: tool({
        description: "List the available site sub-agents.",
        inputSchema: z.object({}),
        execute: async () => ({ agents: [...workerAgents.keys()] }),
      }),
      delegate_task: tool({
        description:
          "Delegate a task to a site sub-agent and return its result.",
        inputSchema: z.object({ agentId: z.string(), task: z.string() }),
        execute: async ({ agentId, task }) => {
          // The model-facing delegate path must be fenced like every other
          // side-effecting tool (the round-15 finding: a cached deleted worker
          // could still run via delegate_task). An aborted run must not start a
          // delegated worker's side effects. DUrable ownership must be asserted
          // BEFORE starting the worker (not just the signal — the round-20
          // durable-ownership-before-commit finding).
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — delegation not started" };
          }
          const a = workerAgents.get(agentId);
          if (!a) return { error: `no agent for ${agentId}` };
          // Revalidate LIVE enrollment/generation before the worker runs: a
          // worker deleted AFTER the orchestrator was built must not run (the
          // internal delegate path previously bypassed the lifecycle gate).
          let gen = 0;
          if (delegateGuard) {
            const g = await delegateGuard(agentId);
            if (!g?.ok) {
              return {
                error: g?.error ?? `agent ${agentId} is not enrolled`,
              };
            }
            gen = g.gen ?? 0;
          }
          // Re-check the fence AFTER the guard await: an abort during the
          // delegateGuard await must still prevent the worker from starting
          // (the round-16 blocker: delegate_task could abort during the guard
          // then still start the worker).
          await assertRunOwned();
          // Thread the captured generation into a.run so the worker's memory/
          // usage commits revalidate THAT immutable identity, not the current
          // enrollment (the round-22 ABA blocker).
          const result = await a.run(task, undefined, undefined, gen);
          // Post-run generation revalidation: a delete DURING the worker run
          // tombstones + bumps the generation, so the result must be discarded
          // rather than returned to the model (the round-17 blocker: delegateGuard
          // returned {gen} but delegate_task ignored it).
          if (delegateGuard && gen) {
            const after = await delegateGuard(agentId);
            if (!after?.ok || (after.gen ?? 0) !== gen) {
              return {
                error: `agent ${agentId} was disenrolled during the task`,
              };
            }
          }
          return { agentId, result };
        },
      }),
    }
    : {};

  const master = createAgent({
    model,
    system: masterSystem ?? system,
    memory: masterMemory,
    tools: { ...delegate, ...extraTools },
    taskId,
    onProgress,
    // SCOPED (hook) runs: the master's memory is READ-ONLY (no memory_set) —
    // untrusted event data must never persist hub state.
    readOnlyMemory: scoped,
  });

  return {
    master,
    workers: workerAgents,
    async run(task, context, history) {
      // Solo mode REUSES the master agent (which carries the non-delegation
      // browser/management tools); it must NOT build a fresh agent that loses
      // those capabilities. Multi-agent mode adds the delegate tools on top.
      return await master.run(task, context, history);
    },
    abort() {
      master.abort();
    },
    // Whether the CURRENT run was aborted (the master's controller) — the SW
    // propagates it in the run response.
    isAborted: () => (typeof master.isAborted === "function" ? master.isAborted() : false),
    // Rebind the live progress callback on the master + every worker. The SW
    // calls this per-run; the cached orchestrator's agents are reused.
    setProgress(cb) {
      master.setProgress?.(cb);
      for (const a of workerAgents.values()) a.setProgress?.(cb);
    },
    addWorker(config) {
      const a = createAgent({
        model,
        id: config.origin,
        name: config.origin,
        system: config.system ?? system,
        memory: config.memory,
        skills: config.skills ?? [],
        tools: config.tools ?? {},
        taskId,
        enrollmentGuard: delegateGuard
          ? async () => delegateGuard(config.origin)
          : null,
        disposable: true,
        onProgress,
      });
      workerAgents.set(config.origin, a);
      return a;
    },
  };
}
