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
import { runAborted } from "./run-fence.js";

const DEFAULT_SYSTEM =
  `You are the Chrome Agent Platform hub agent. You help the
user get things done on the web. You can read and write memory, call tools, and
delegate to per-site sub-agents. Be concise; prefer actions over prose.`;

function memoryToolset(memory) {
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
        try {
          await memory.set(key, value);
          return { ok: true, key };
        } catch (e) {
          // A bounded/reserved-key rejection is surfaced honestly, never thrown
          // into the agent loop.
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
}) {
  const allTools = { ...memoryToolset(memory), ...tools };
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
          // delegated worker's side effects.
          if (runAborted()) {
            return { error: "run aborted — delegation not started" };
          }
          const a = workerAgents.get(agentId);
          if (!a) return { error: `no agent for ${agentId}` };
          // Revalidate LIVE enrollment/generation before the worker runs: a
          // worker deleted AFTER the orchestrator was built must not run (the
          // internal delegate path previously bypassed the lifecycle gate).
          if (delegateGuard) {
            const g = await delegateGuard(agentId);
            if (!g?.ok) {
              return {
                error: g?.error ?? `agent ${agentId} is not enrolled`,
              };
            }
          }
          return { agentId, result: await a.run(task) };
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
      });
      workerAgents.set(config.origin, a);
      return a;
    },
  };
}
