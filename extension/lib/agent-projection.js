// lib/agent-projection.js — pure unified agent projection and identity utilities.
//
// Separated from lib/named-agents.js so UI surfaces (Hub/NTP, Options/Settings)
// can project unified agents and normalize agent slugs without bundling
// heavy service-worker-only storage backends (memory, durable-runs, scheduler).

import { isVisibleAgentRow } from "./agent-seeds.js";

/** Normalize an agent id to a kebab-case slug. */
export function slugifyAgentId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/**
 * Project named and background agent stores into a single deduplicated roster.
 *
 * When an agent id exists in both stores (an agent with both a prompt and an
 * alarm recipe), the named-agent persona definition wins the identity fields
 * (name, prompt, model, systemPrompt, memoryMode, workspace) and takes the
 * background agent's active periodic schedule if the named agent definition
 * has none of its own, while both source records remain available to management
 * surfaces. Pure — no store access.
 */
export function projectUnifiedAgents(namedAgents = [], backgroundAgents = []) {
  const byId = new Map();
  for (const a of Array.isArray(namedAgents) ? namedAgents : []) {
    if (!a?.id) continue;
    // Preserve source records so management surfaces can render one conceptual
    // row without losing either store's actions on a same-id collision.
    byId.set(a.id, { ...a, kind: "named", namedAgent: a, backgroundAgent: null });
  }
  for (const b of Array.isArray(backgroundAgents) ? backgroundAgents : []) {
    if (!b?.id) continue;
    const recipeSchedule = b.schedule?.periodInMinutes
      ? { periodInMinutes: b.schedule.periodInMinutes, task: b.schedule?.task ?? "" }
      : null;
    const existing = byId.get(b.id);
    if (existing) {
      existing.backgroundAgent = b;
      if (!existing.schedule?.periodInMinutes && recipeSchedule) {
        existing.schedule = recipeSchedule;
      }
      // wz6i: a seed's live enabled flag rides the named-agent.list enrichment;
      // the background side derives the SAME fact from the task store, so fill
      // it when the named side has not (enrichment order must not flicker a
      // row out of the list).
      if (existing.enabled === undefined && typeof b.enabled === "boolean") {
        existing.enabled = b.enabled;
      }
    } else {
      byId.set(b.id, {
        ...b,
        kind: "background",
        schedule: recipeSchedule,
        namedAgent: null,
        backgroundAgent: b,
      });
    }
  }
  return [...byId.values()].filter(isVisibleAgentRow);
}
