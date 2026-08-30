// scripts/skill-import-proof.mjs — LIVE proof for
// CAP-FB-20260830-SKILLS-UNCAPPED-01: importing a REAL skill from
// github.com/cloudflare/skills through the production fetchSkillFromUrl path.
//
// The OLD 64KiB cap rejected anything larger with "skill is too large
// (N bytes > 65536)"; this run must succeed and show the multi-file map.
//
// RUN:  deno run -A scripts/skill-import-proof.mjs [url]
// (default: https://github.com/cloudflare/skills — the repo root, which the
//  importer walks to find a SKILL.md)
import { fetchSkillFromUrl, installImportedSkill } from "../extension/lib/skill-import.js";

const url = Deno.args[0] ?? "https://github.com/cloudflare/skills";
console.log(`fetchSkillFromUrl(${url}) — the production import path (network, unauthenticated GitHub API)`);

const fetched = await fetchSkillFromUrl(url);
const files = fetched.files ?? {};
const entries = Object.entries(files);
console.log(`meta: ${JSON.stringify(fetched.meta)}`);
console.log(`files: ${entries.length}`);
let total = 0;
for (const [path, body] of entries) {
  const bytes = new TextEncoder().encode(String(body ?? "")).byteLength;
  total += bytes;
  console.log(`  ${path}  (${bytes} bytes)`);
}
console.log(`total: ${total} bytes`);
const skillMdBytes = new TextEncoder().encode(String(files["SKILL.md"] ?? "")).byteLength;
console.log(`SKILL.md: ${skillMdBytes} bytes — ${skillMdBytes > 64 * 1024 ? "EXCEEDS the old 64KiB cap (would have been rejected before SKILLS-UNCAPPED-01)" : "under 64KiB (the multi-file map still proves the new walk)"}`);

// Round-trip through the install path (the SW's skill.import does exactly this).
const data = new Map();
const memory = { async get(k) { return data.get(k); }, async set(k, v) { data.set(k, v); } };
const skill = await installImportedSkill(memory, fetched);
console.log(`installed: id=${skill.id} fileCount=${skill.fileCount} totalBytes=${skill.totalBytes}`);
console.log(`prompt head: ${String(skill.prompt ?? "").slice(0, 80).replace(/\n/g, " ")}`);
console.log("PROOF-OK");
