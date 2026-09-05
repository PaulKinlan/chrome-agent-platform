// lib/skills.js — browser-adapted skills (agent-do pattern).
//
// Skills are per-site procedural knowledge: a name, a description, and steps.
// In the hosted version a site can declare skills via `<link rel="skills">`
// (or an agent.md); here the content script surfaces them and the hub stores
// them per origin. Skills become agent tools when injected as a system prompt
// or as explicit callable procedures.

import { listOrigins, siteMemory } from "./memory.js";
import { skillMatchesUrl } from "../shared/match-patterns.js";

export async function setSkills(origin, skills) {
  await siteMemory(origin).set("skills", skills);
  return skills;
}

export async function getSkills(origin) {
  return (await siteMemory(origin).get("skills")) ?? [];
}

/* ── Site notes (CAP-FB-20260830-SITE-PLAYBOOKS-01) ──────────────────────────
 * An owner-written per-origin note ("On this site, always …") composed into
 * the skills boundary layer for runs whose active tab matches the origin.
 * Bounded to SITE_NOTE_MAX_CHARS; stored under the SAME origin key as the
 * site's skills, so origin-keyed isolation is inherited, never re-implemented.
 */
export const SITE_NOTE_MAX_CHARS = 2000;

export async function setSiteNote(origin, notes) {
  const text = String(notes ?? "").slice(0, SITE_NOTE_MAX_CHARS);
  await siteMemory(origin).set("notes", text);
  return text;
}

export async function getSiteNote(origin) {
  return String((await siteMemory(origin).get("notes")) ?? "");
}

/** The origin-bound skills (records whose `origins` match) plus the origin's
 * site note, for ONE origin. A non-matching origin gets the globals filtered
 * out by the caller — this helper returns ONLY the origin-bound matches, never
 * another origin's note (the cross-origin isolation invariant).
 */
export async function sitePlaybookForOrigin(origin, skills) {
  const bound = (Array.isArray(skills) ? skills : []).filter(
    (s) => Array.isArray(s?.origins) && s.origins.length > 0 && skillMatchesUrl(s, origin),
  );
  const note = await getSiteNote(origin);
  return { skills: bound, note };
}

/**
 * Build the skills portion of the system prompt (agent-do buildSkillsPrompt).
 */
export function buildSkillsPrompt(skills) {
  if (!skills?.length) return "";
  const lines = skills.map((s) => `- ${s.name}: ${s.description ?? ""}`).join(
    "\n",
  );
  return `\n## Available skills\n${lines}\n`;
}

export async function allSkills() {
  const origins = await listOrigins();
  const out = {};
  for (const o of origins) {
    const s = await getSkills(o);
    if (s.length) out[o] = s;
  }
  return out;
}
