// lib/skill-catalog.js — THE single skill catalog (CAP-FB-20260831-SKILL-LIST-SYNC-01).
//
// Every user-facing skill surface reads THIS one query:
//   - the /skill command popup (shared/composer-commands.js)
//   - the @-mention popup (shared/components.js mentionCandidates)
//   - the agent-config dialog skills section (ntp/ntp.js buildAgentConfigDialog)
//   - Settings → Skills (skills/skills-panel.js)
//
// The catalog is: built-in ON-DEMAND recipes + imported skills (bodies in OPFS).
// BACKGROUND recipes are NOT skills — they are scheduled agents surfaced through
// background-agent.list (an on-demand /skill: invocation of a background recipe
// errors at run time, which is the owner-reported "sorting hat" mismatch: the
// Sorting Hat is `auto-group-by-domain`, mode background, and used to appear in
// /skill while Settings correctly filtered it out).
//
// Corruption rule: a skill whose body migration to OPFS failed (migrationFailed)
// is NEVER offered by a picker (its skill_read loader would be dead), is kept
// OUT of the catalog, and is reported in the `broken` list so Settings can show
// the owner exactly what failed and why — never silently.
//
// No chrome.*, no DOM — Deno-testable pure store read.

import { onDemandRecipes, intentOf } from "./recipes.js";

/** Source labels for honest grouping in the UI. */
export const SKILL_SOURCE_LABEL = Object.freeze({
  builtin: "built-in",
  imported: "imported",
});

/**
 * Build the ONE skill catalog.
 *
 * @param {object} opts
 * @param {import("./memory.js").MemoryLike} opts.memory            master memory (importedSkills index lives here)
 * @param {{ writeSkillFiles: Function, removeSkillFiles: Function }} opts.fileStore OPFS skill-file store
 * @returns {Promise<{ skills: object[], broken: {id: string, reason: string}[] }>}
 *   skills: on-demand built-ins + healthy imported skills, each carrying
 *     `source` ("builtin" | "imported") and `intent` for grouping.
 *   broken: imported rows that failed to load/migrate, with the reason.
 */
export async function skillCatalog({ memory, fileStore = null }) {
  const { loadAllImportedSkills } = await import("./skill-import.js");
  const importedRows = await loadAllImportedSkills(memory, fileStore).catch(() => []);
  const skills = [];
  const broken = [];
  for (const r of importedRows) {
    if (!r || typeof r !== "object") {
      broken.push({ id: String(r?.id ?? "unknown"), reason: "unreadable skill record" });
      continue;
    }
    if (r.migrationFailed === true) {
      broken.push({ id: r.id, reason: "body migration to OPFS failed — skill_read cannot serve it until storage recovers" });
      continue;
    }
    // Collision-proof identity (r2 review P1): every catalog row carries a
    // source-qualified refId. An imported skill whose id collides with a
    // built-in recipe id (e.g. an import named `auto-group-by-domain`) is
    // offered as `imported:<id>` and resolves ONLY to the imported row — it
    // can never resolve to the built-in BACKGROUND recipe (the owner bug
    // returning through a different door).
    skills.push({ ...r, refId: `imported:${r.id}`, source: r.source ?? "imported", intent: intentOf(r) });
  }
  for (const r of onDemandRecipes()) {
    skills.push({ ...r, refId: `builtin:${r.id}`, source: "builtin", intent: intentOf(r) });
  }
  return { skills, broken };
}
