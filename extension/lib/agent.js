// lib/agent.js — the agent core (agent-do pattern, browser-adapted, AI SDK).
//
// createAgent: a single agent with a model, system prompt, tools, and memory.
// createOrchestrator: a hub agent + worker agents, with delegation tools
// (delegate_task / list_agents / get_agent_status) so the hub fans out to
// per-site sub-agents. The 1-agent vs multi-agent choice is a config flag.

import { generateText, tool } from "ai";
import { z } from "zod";
import { recordUsage } from "./usage.js";
import { buildSkillsPrompt } from "./skills.js";

// A small async in-memory cache of generated text (no cross-import of agent-do).
const DEFAULT_SYSTEM = `You are the Chrome Agent Platform hub agent. You help the
user get things done on the web. You can read and write memory, call tools, and
delegate to per-site sub-agents. Be concise; prefer actions over prose.`;

export async function createAgent({
  model,            // { provider, model, providerName } from provider.js
  system = DEFAULT_SYSTEM,
  tools = {},
  memory = null,    // a memoryStore() handle
  taskId = "adhoc",
  skills = [],
}) {
  const memoryTools = memory ? {
    memory_get: tool({
      description: "Read a value from the agent's memory.",
      inputSchema: z.object({ key: z.string() }),
      execute: async ({ key }) => ({ key, value: await memory.get(key) }),
    }),
    memory_set: tool({
      description: "Write a value to the agent's memory.",
      inputSchema: z.object({ key: z.string(), value: z.any() }),
      execute: async ({ key, value }) => { await memory.set(key, value); return { ok: true, key }; },
    }),
    memory_list: tool({
      description: "List memory keys.",
      inputSchema: z.object({}),
      execute: async () => ({ keys: await memory.keys() }),
    }),
  } : {};

  async function run(task, { onStep = () => {} } = {}) {
    const { provider, model: modelId, providerName } = model;
    const result = await generateText({
      model: provider,
      system: system + buildSkillsPrompt(skills),
      prompt: task,
      tools: { ...memoryTools, ...tools },
      maxSteps: 12,
      onStepFinish: (e) => {
        onStep(e);
        const u = e.usage;
        if (u) recordUsage({
          taskId, model: modelId, provider: providerName,
          tokensIn: u.promptTokens ?? 0, tokensOut: u.completionTokens ?? 0,
        });
      },
    });
    return result.text;
  }

  return { run, memory, tools: { ...memoryTools, ...tools } };
}

/**
 * Multi-agent orchestrator: a hub (master) agent + per-site workers.
 * `multiAgent: false` runs everything on the master (no workers).
 */
export async function createOrchestrator({
  model,
  system = DEFAULT_SYSTEM,
  masterMemory,
  workers = [], // [{ origin, system, skills, tools }]
  multiAgent = true,
  taskId = "adhoc",
}) {
  const workerAgents = new Map();
  for (const w of workers) {
    workerAgents.set(w.origin, await createAgent({
      model, system: w.system ?? system, memory: w.memory, skills: w.skills ?? [], tools: w.tools ?? {}, taskId,
    }));
  }

  const delegate = multiAgent ? {
    list_agents: tool({
      description: "List the available site sub-agents.",
      inputSchema: z.object({}),
      execute: async () => ({ agents: [...workerAgents.keys()] }),
    }),
    delegate_task: tool({
      description: "Delegate a task to a site sub-agent and return its result.",
      inputSchema: z.object({ agentId: z.string(), task: z.string() }),
      execute: async ({ agentId, task }) => {
        const agent = workerAgents.get(agentId);
        if (!agent) return { error: `no agent for ${agentId}` };
        return { agentId, result: await agent.run(task) };
      },
    }),
    get_agent_status: tool({
      description: "Whether a site sub-agent is available.",
      inputSchema: z.object({ agentId: z.string() }),
      execute: async ({ agentId }) => ({ agentId, available: workerAgents.has(agentId) }),
    }),
  } : {};

  const master = await createAgent({
    model, system, memory: masterMemory, tools: delegate, taskId,
  });

  return {
    master,
    workers: workerAgents,
    async run(task, { onStep } = {}) {
      if (multiAgent) return await master.run(task, { onStep });
      // single-agent mode: no workers, just the master with no delegation tools
      const solo = await createAgent({ model, system, memory: masterMemory, taskId });
      return await solo.run(task, { onStep });
    },
    async addWorker(config) {
      const agent = await createAgent({ model, system: config.system ?? system, memory: config.memory, skills: config.skills ?? [], tools: config.tools ?? {}, taskId });
      workerAgents.set(config.origin, agent);
      return agent;
    },
  };
}
