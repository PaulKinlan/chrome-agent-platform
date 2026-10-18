// extension/background/routes/skills.js — the SKILL family, moved out of the service worker
// (chrome-agent-platform-atxc6 slice 4, designed in zln9d).
//
// Ten routes, one domain: the legacy per-origin skills notes (skills.set/get/all), the imported-skill
// catalog and its import/delete/discover/batch verbs, and the per-origin site playbooks
// (site-skills.set/get). `skill.run` deliberately STAYS in the worker: it resolves a skill and calls
// runTask, so it belongs to the run core, not to skill storage — moving it would drag the orchestrator
// across this seam for no line saving.
//
// The design finding that made this cheap: the map said "6 worker-scope injections", but only THREE are
// real. `masterMemory` is a library import, and `skillFileStore` was a one-line worker constant built from
// two imports of lib/skill-files.js. That constant now lives in lib/skill-files.js itself, so this module and
// the worker's own skillCatalog/loadAllImportedSkills call sites share ONE definition — an injected copy
// would be ceremony that could drift.
//
// NOTE ON THE WRITE PATH: unlike the earlier slices this moves WRITES (installImportedSkill writes files,
// then the memory index). Two things keep it whole: the family moves ENTIRELY (no route can observe a
// half-migrated store) and the store was single-sourced BEFORE any route used it, so there is no window
// with two definitions.
import {
  discoverRepoSkillsAndCommands,
  fetchSkillFromUrl,
  installBatchSkillsAndCommands,
  installImportedSkill,
  loadAllImportedCommands,
  removeImportedSkill,
} from "../../lib/skill-import.js";
import { skillFileStore, removeSkillFiles, writeSkillFiles } from "../../lib/skill-files.js";
import { allSkills, getSiteNote, getSkills, setSiteNote, setSkills } from "../../lib/skills.js";
import { requireSettingsSender } from "./auth.js";

/**
 * @param {{
 *   masterMemory: () => any,
 *   invalidateAgent: () => void,
 *   broadcastRegistryChanged: () => void,
 * }} deps
 * @returns {Readonly<Record<string, Function>>} frozen route map
 */
export function createSkillRoutes({ masterMemory, invalidateAgent, broadcastRegistryChanged }) {
  return Object.freeze({
async "skills.set"({ origin, skills }) {
  const result = await setSkills(origin, skills);
  // Skills feed the orchestrator's system prompt at build time — a skills change
  // must rebuild the running orchestrator, not leave a stale cached prompt.
  invalidateAgent();
  return result;
},
async "skills.get"({ origin }) {
  return await getSkills(origin);
},
async "skills.all"() {
  return await allSkills();
},
async "skill.list"() {
  // THE single catalog (CAP-FB-20260831-SKILL-LIST-SYNC-01; l0r retired the
  // duplicate recipe.list route): built-in on-demand skills + healthy
  // imported skills. Background skills are scheduled agents
  // (background-agent.list), never on-demand skills — Settings and every
  // picker read this SAME route, so no surface can drift. `broken` carries
  // the skills that failed to load so Settings can surface them honestly
  // (never silently offered, never silently hidden).
  const { skillCatalog } = await import("../../lib/skill-catalog.js");
  const { skills, broken } = await skillCatalog({ memory: masterMemory(), fileStore: skillFileStore });
  return { skills, broken };
},
async "skill.import"(m) {
  const url = String(m?.url ?? "").trim();
  if (!url) return { ok: false, error: "no skill URL provided" };
  try {
    const fetched = await fetchSkillFromUrl(url);
    const skill = await installImportedSkill(masterMemory(), fetched, {
      writeSkillFiles,
      removeSkillFiles,
    });
    broadcastRegistryChanged();
    return { ok: true, skill };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
},
async "skill.delete"({ id }) {
  const rid = String(id ?? "").trim();
  if (!rid) return { ok: false, error: "no skill id provided" };
  const out = await removeImportedSkill(masterMemory(), rid, {
    writeSkillFiles,
    removeSkillFiles,
  });
  if (out?.ok) broadcastRegistryChanged();
  return out;
},
async "skill.discover"(m) {
  const url = String(m?.url ?? "").trim();
  if (!url) return { ok: false, error: "no skill URL provided" };
  try {
    return await discoverRepoSkillsAndCommands(url, m?.options);
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
},
async "skill.importBatch"(m) {
  try {
    const res = await installBatchSkillsAndCommands(masterMemory(), m, {
      writeSkillFiles,
      removeSkillFiles,
    });
    broadcastRegistryChanged();
    return res;
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
},
async "site-skills.set"(m, context) {
  // The owner writes a per-origin site note from the Settings surface ONLY
  // (CAP-FB-20260830-SITE-PLAYBOOKS-01). Bounded by setSiteNote itself.
  requireSettingsSender(context);
  const origin = String(m?.origin ?? "").trim();
  if (!origin) return { ok: false, error: "no origin provided" };
  try { new URL(origin); } catch { return { ok: false, error: "origin must be a URL origin" }; }
  const note = await setSiteNote(origin, m?.notes);
  return { ok: true, notes: note };
},
async "site-skills.get"(m) {
  const origin = String(m?.origin ?? "").trim();
  if (!origin) return { ok: false, error: "no origin provided" };
  return { ok: true, notes: await getSiteNote(origin) };
},
  });
}
