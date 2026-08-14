// lib/skills.js — browser-adapted skills (agent-do pattern).
//
// Skills are per-site procedural knowledge: a name, a description, and steps.
// In the hosted version a site can declare skills via `<link rel="skills">`
// (or an agent.md); here the content script surfaces them and the hub stores
// them per origin. Skills become agent tools when injected as a system prompt
// or as explicit callable procedures.

import { siteMemory, masterMemory } from "./memory.js";

export async function setSkills(origin, skills) {
  await siteMemory(origin).set("skills", skills);
  return skills;
}

export async function getSkills(origin) {
  return (await siteMemory(origin).get("skills")) ?? [];
}

/**
 * Build the skills portion of the system prompt (agent-do buildSkillsPrompt).
 */
export function buildSkillsPrompt(skills) {
  if (!skills?.length) return "";
  const lines = skills.map((s) => `- ${s.name}: ${s.description ?? ""}`).join("\n");
  return `\n## Available skills\n${lines}\n`;
}

export async function allSkills() {
  const origins = (await masterMemory().get("origins")) ?? [];
  const out = {};
  for (const o of origins) {
    const s = await getSkills(o);
    if (s.length) out[o] = s;
  }
  return out;
}
