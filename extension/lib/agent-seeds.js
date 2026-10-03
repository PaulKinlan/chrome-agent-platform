// lib/agent-seeds.js — built-in background agents as named-agent SEED records
// (chrome-agent-platform-wz6i: merge the recipe-backed background agents into
// the named-agent store — the docs/AGENT-PRODUCT-GAPS.md §5 follow-on).
//
// The unified agent model (owner directive 2026-08-28) made an agent persona +
// skills + memory + an OPTIONAL schedule, with ONE list UI and ONE schedule
// path. What stayed split was the RECORD store: built-in background agents
// (the Sorting Hat and friends) were still skill-registry entries projected
// into the agents list, their enabled state keyed to `recipe:<id>` scheduled
// tasks. This module derives a named-agent SEED record for every built-in
// background skill, so the agent store is the ONE record authority:
//
//   - Seeds are DERIVED, never persisted. A persisted record with the same id
//     always wins the overlay (seedOverlay), so a future "customize the
//     built-in" gesture can materialize a real record without a migration.
//   - A DISABLED seed is a template, not an agent row (isVisibleAgentRow) —
//     the same contract the hub already applies to background rows
//     (CAP-FB-20260830-FRESH-PROFILE-TEMPLATE-AGENTS-01).
//   - Seeds carry their LEGACY runtime identity (surfaceRef `background:<id>`,
//     memoryKey `recipe:<id>`) so runs, journals, memory and timeline
//     attribution stay byte-identical after the merge. The physical `recipe:`
//     re-key of OPFS dirs + hooks records remains chrome-agent-platform-e5oe.

import { backgroundSkills } from "./skill-registry.js";

/**
 * The seed record for ONE built-in background skill. Pure.
 * Fields mirror a persisted named-agent record so every surface that renders
 * agent records can read a seed without special-casing; the seed-only fields
 * (seeded/builtin/defaultSchedule/surfaceRef/memoryKey) ride alongside.
 */
export function seedRecordForSkill(skill) {
  if (!skill?.id || skill.mode !== "background") return null;
  const periodInMinutes = skill.schedule?.periodInMinutes ?? null;
  return {
    id: skill.id,
    name: skill.name ?? skill.id,
    role: "",
    avatar: null,
    skills: [
      {
        id: skill.id,
        name: skill.name ?? skill.id,
        description: skill.description ?? "",
      },
    ],
    coreAssets: [],
    description: skill.description ?? "",
    // Seed markers: management surfaces refuse mutations on these (a built-in
    // is disabled, never deleted; duplicating is the customize gesture).
    builtin: true,
    seeded: true,
    // The record's LEGACY runtime identity. The run paths honor these
    // overrides (fire branch, runNamedAgentTask, named-agent.history) so the
    // agent's runs keep writing the same OPFS tier and the same
    // `background:<id>` surface attribution they always have.
    surfaceRef: `background:${skill.id}`,
    memoryKey: `recipe:${skill.id}`,
    // The DEFAULT cadence the skill ships with — never a live schedule. The
    // live schedule arrives through the scheduled-task store enrichment
    // (agent:<id>) exactly like a persisted agent's.
    defaultSchedule: periodInMinutes ? { periodInMinutes } : null,
  };
}

/** Seed records for every built-in background skill. Pure. */
export function builtinBackgroundSeeds(skills = backgroundSkills()) {
  return (Array.isArray(skills) ? skills : [])
    .map(seedRecordForSkill)
    .filter(Boolean);
}

/** Is this skill record one of the BUILT-IN background skills (not a custom
 * duplicate)? Custom copies get their own ids (`<id>-custom-<ts>`), so an id
 * match against the built-in registry is exact. Pure. */
export function isBuiltinBackgroundSkill(skill, builtins = backgroundSkills()) {
  return Boolean(
    skill?.id && skill.mode === "background" &&
      (Array.isArray(builtins) ? builtins : []).some((b) => b.id === skill.id),
  );
}

/**
 * Overlay seed records UNDER persisted named-agent records: a persisted record
 * with the same id wins (it carries the owner's real edits); every other seed
 * fills in. Input order is preserved for persisted rows; seeds append after,
 * sorted by name for stability. Pure.
 */
export function seedOverlay(persistedAgents = [], seeds = []) {
  const byId = new Map();
  for (const a of Array.isArray(persistedAgents) ? persistedAgents : []) {
    if (a?.id) byId.set(a.id, a);
  }
  const out = [...byId.values()];
  const fill = [];
  for (const s of Array.isArray(seeds) ? seeds : []) {
    if (s?.id && !byId.has(s.id)) fill.push(s);
  }
  fill.sort((a, b) => String(a.name ?? a.id).localeCompare(String(b.name ?? b.id)));
  return out.concat(fill);
}

/** Is this id one of the built-in background seed ids? Pure. */
export function isSeedId(id, seeds = builtinBackgroundSeeds()) {
  return (Array.isArray(seeds) ? seeds : []).some((s) => s.id === id);
}

/** A seed record is read-only: it exists by derivation, so there is nothing
 * to update or delete (disabling is the schedule path, not a mutation). */
export function isSeedRecord(agent) {
  return agent?.seeded === true;
}

/**
 * The ONE agents-projection row rule for seeds (the hub contract: a disabled
 * built-in background agent is a template, not an agent — it stays reachable
 * through the create dialog / Settings' Configure picker, never as an agent
 * row). Persisted records are always rows; seeds are rows only while enabled.
 * Pure.
 */
export function isVisibleAgentRow(agent) {
  if (isSeedRecord(agent)) return agent.enabled === true;
  return true;
}

/**
 * The `background-agent.set` BUILT-IN branch (wz6i), extracted so tests drive
 * the REAL route logic with fakes. A built-in background agent is a
 * named-agent store record: its enable/disable IS the ONE agent schedule path
 * (`agent:<id>` via applyAgentSchedule — the fire path's real named-agent run
 * with the record's legacy identity overrides). Hooks subscribe/unsubscribe
 * exactly as the legacy path did; any legacy `recipe:<id>` task is cancelled
 * (the startup re-key does this too — this closes the window for a profile
 * that enabled the agent before this build). Custom duplicated skills never
 * reach this branch.
 */
export function createBuiltinBackgroundSet({
  applyAgentSchedule,
  subscribeHook,
  unsubscribeHook,
  cancelScheduledTaskBackground,
}) {
  return async function setBuiltinBackgroundEnabled(skill, enabled) {
    if (!enabled) {
      const r = await applyAgentSchedule(skill.id, null);
      for (const hookId of skill.hooks ?? []) {
        await unsubscribeHook({ hookId, recipeId: skill.id }).catch(() => {});
      }
      // Belt-and-braces: cancel any legacy `recipe:` task the startup re-key
      // has not reached (non-blocking, inert-first as always).
      cancelScheduledTaskBackground(`recipe:${skill.id}`);
      return r.ok
        ? { ok: true, enabled: false, id: skill.id, stopping: r.stopping, name: r.name }
        : r;
    }
    const periodInMinutes = skill.schedule?.periodInMinutes;
    if (!periodInMinutes) {
      return { ok: false, error: `skill ${skill.id} has no schedule` };
    }
    // Subscribe the skill's event triggers (fail-closed: a denied hook, or a
    // hook whose optional permission is absent, is refused — the skill still
    // runs on its schedule, just not on the event).
    for (const hookId of skill.hooks ?? []) {
      await subscribeHook({ hookId, recipeId: skill.id }).catch(() => {});
    }
    // The recurring task text is the skill's prompt — identical to the legacy
    // payload, so a fired run composes the same instructions.
    const r = await applyAgentSchedule(skill.id, periodInMinutes, skill.prompt);
    if (r.ok) cancelScheduledTaskBackground(`recipe:${skill.id}`);
    return r.ok
      ? { ok: true, enabled: true, id: skill.id, name: r.name, periodInMinutes }
      : r;
  };
}

/**
 * The startup re-key, extracted so tests drive the REAL migration with
 * controlled interleavings (wz6i slice 3). For every scheduled task named
 * `recipe:<id>` whose id is a BUILT-IN background skill, mint the unified
 * `agent:<id>` schedule preserving the OLD payload verbatim (same task text,
 * same absolute next-fire `at`, same period, same owner) and only then cancel
 * the legacy task. Mint-then-cancel can never silently disable an agent, and
 * the alarm handler skips `cancelling` payloads, so the overlap cannot
 * double-fire. A failure before the legacy cancel leaves the old task live —
 * the next startup retries; a failure to mint changes nothing at all.
 * Custom duplicated background skills (their ids are not in the built-in
 * registry) keep the `recipe:` path and are never touched here.
 */
export function createBuiltinScheduleRekey({
  listScheduledTasks,
  scheduleTask,
  cancelScheduledTaskBackground,
  isBuiltinBackgroundId,
  log = () => {},
}) {
  return async function rekeyBuiltinBackgroundSchedules() {
    const tasks = await listScheduledTasks().catch(() => []);
    const migrated = [];
    const errors = [];
    for (const t of Array.isArray(tasks) ? tasks : []) {
      const name = t?.name;
      if (typeof name !== "string" || !name.startsWith("recipe:")) continue;
      const id = name.slice("recipe:".length);
      if (!isBuiltinBackgroundId(id)) continue;
      if (t.cancelling) continue; // already inert — nothing to preserve
      const unifiedName = `agent:${id}`;
      try {
        await scheduleTask({
          name: unifiedName,
          task: t.task,
          // Preserve the absolute next-fire: the owner sees the SAME cadence,
          // not a restarted period. `at` wins over delayMs in scheduleTask.
          at: typeof t.at === "number" && t.at > Date.now()
            ? t.at
            : Date.now() + (Number(t.periodInMinutes) > 0 ? Number(t.periodInMinutes) : 60) * 60 * 1000,
          periodInMinutes: t.periodInMinutes,
          attachments: Array.isArray(t.attachments) ? t.attachments : [],
          owner: t.owner ?? null,
        });
      } catch (err) {
        // Minting failed — the legacy task is untouched and still live.
        errors.push({ name, error: err?.message ?? String(err) });
        log(`rekey: mint ${unifiedName} failed (${err?.message ?? err}); legacy ${name} left live`);
        continue;
      }
      try {
        await cancelScheduledTaskBackground(name).marked;
        migrated.push({ from: name, to: unifiedName });
      } catch (err) {
        // The unified schedule is live; the legacy one could not be marked
        // inert. The alarm handler skips cancelling payloads but this one is
        // NOT marked — surface it loudly; the next startup retries the cancel.
        errors.push({ name, error: `cancel failed after mint: ${err?.message ?? String(err)}` });
        log(`rekey: cancel ${name} failed after minting ${unifiedName} (${err?.message ?? err})`);
      }
    }
    return { migrated, errors };
  };
}
