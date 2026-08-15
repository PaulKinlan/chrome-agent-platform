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
import { assertRunOwned } from "./run-fence.js";

const DEFAULT_SYSTEM =
  `You are the Chrome Agent Platform hub agent. You help the
user get things done on the web. You can read and write memory, call tools, and
delegate to per-site sub-agents. Be concise; prefer actions over prose.`;

function memoryToolset(memory, enrollmentGuard = null) {
  if (!memory) return {};
  return {
    memory_get: tool({
      description: "Read a value from the agent's memory.",
      inputSchema: z.object({ key: z.string() }),
      execute: async ({ key }) => ({ key, value: await memory.get(key) }),
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
          // A WORKER's memory write must also revalidate LIVE enrollment: a
          // worker deleted mid-run must not recreate its tombstoned OPFS store
          // through a lingering memory_set (the round-21 blocker: worker tools
          // got no enrollment token, so already-running worker side effects
          // continued after delete). The guard returns {ok, gen}; a stale/
          // missing generation aborts the write.
          if (enrollmentGuard) {
            const g = await enrollmentGuard();
            if (!g?.ok) {
              return { error: g?.error ?? "origin not enrolled — memory not written" };
            }
          }
        } catch {
          return { error: "run aborted — memory not written" };
        }
        let prev = undefined;
        let existed = false;
        let committed = false;
        try {
          prev = await memory.get(key);
          existed = prev !== undefined && prev !== null;
          await assertRunOwned();
          await memory.set(key, value);
          committed = true;
          await assertRunOwned();
          return { ok: true, key };
        } catch (e) {
          // A bounded/reserved-key rejection is surfaced honestly, never thrown
          // into the agent loop. An abort/ownership loss AFTER the write (the
          // `committed` flag) compensates by restoring the prior value (or removing
          // a new key), not deleting an existing key's history. Ownership-only loss
          // (durable owner gone while the signal is still live) is compensated here
          // too — `committed` is set on ANY post-write fence failure, not just a
          // signal abort (the round-20 finding).
          if (committed && typeof memory.set === "function") {
            try {
              if (existed) await memory.set(key, prev);
              else await memory.delete(key);
            } catch { /* best-effort */ }
          }
          return { error: String(e?.message ?? e) };
        }
      },
    }),
    memory_list: tool({
      description: "List memory keys.",
      inputSchema: z.object({}),
      execute: async () => ({ keys: await memory.keys() }),
    }),
  };
}

/**
 * Wrap agent-do's createAgent with our conventions.
 * `model` is the resolved { model: LanguageModel, modelId, providerName } from provider.js.
 */
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
}) {
  const allTools = { ...memoryToolset(memory, enrollmentGuard), ...tools };
  const systemPrompt = system + buildSkillsPrompt(skills);

  const agent = agentDoCreateAgent({
    id,
    name,
    model: model.model,
    systemPrompt,
    tools: allTools,
    maxIterations,
    hooks: {
      onUsage: async (record) => {
        await recordUsage({
          agentId: id,
          taskId,
          provider: model.providerName,
          model: model.modelId,
          inputTokens: record.inputTokens ?? 0,
          outputTokens: record.outputTokens ?? 0,
          estimatedCost: record.estimatedCost ?? 0,
        });
      },
    },
  });

  return {
    id,
    name,
    // agent-do's run(task, context, history) -> string
    run: (task, context, history) => agent.run(task, context, history),
    abort: () => agent.abort(),
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
  masterMemory,
  workers = [], // [{ origin, memory, skills, tools }]
  multiAgent = true,
  taskId = "adhoc",
  extraTools = {}, // browser-control + management tools (chrome.* — SW context)
  delegateGuard = null, // async (origin) => { ok, error } — revalidates live
                        // enrollment/generation before a delegated worker runs
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
      // memory_set revalidates LIVE enrollment before committing (the round-21
      // blocker: worker tools got no enrollment token). The guard already
      // revalidates enrollment + generation; reuse it per-origin.
      enrollmentGuard: delegateGuard
        ? async () => delegateGuard(w.origin)
        : null,
    });
    workerAgents.set(w.origin, a);
  }

  const delegate = multiAgent
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
          const result = await a.run(task);
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
    system,
    memory: masterMemory,
    tools: { ...delegate, ...extraTools },
    taskId,
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
      });
      workerAgents.set(config.origin, a);
      return a;
    },
  };
}
