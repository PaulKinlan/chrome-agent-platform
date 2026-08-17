// lib/skill-import.js — import EXTERNAL skills (the chaos skill-loader pattern).
//
// A skill is fetched from a source (a GitHub repo with a SKILL.md, or a direct
// URL to a markdown file), its frontmatter (name/description) is parsed, and it
// is installed as a reusable skill the owner can then /skill:<id> into any task
// or attach to any agent. Skills are DATA (a prompt + files), never eval'd.

/** Parse minimal YAML frontmatter (name/description/author/version). */
export function parseFrontmatter(md) {
  const text = String(md ?? "");
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  const meta = {};
  if (!m) return { body: text, meta };
  const fm = m[1] ?? "";
  for (const line of fm.split("\n")) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    let value = kv[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    meta[key] = value;
  }
  return { body: text.slice(m[0].length), meta };
}

/** A stable, safe id from a skill name. */
export function slugifySkillId(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "imported-skill";
}

/**
 * Fetch a SKILL.md from a GitHub repo URL or a direct markdown URL.
 * Returns { files: {SKILL.md: content}, meta: {name, description, author} }.
 * Mirrors ~/chaos's skill-fetcher: GitHub Contents API → raw fallback → direct URL.
 */
export async function fetchSkillFromUrl(url) {
  const u = String(url ?? "").trim();
  if (!u) throw new Error("no skill URL provided");

  // Direct markdown URL first (raw.githubusercontent.com / a .md file).
  if (/\.md(?:\?.*)?$/.test(u) || u.includes("raw.githubusercontent.com")) {
    return fetchDirectSkill(u);
  }

  // GitHub repo URL → resolve the SKILL.md via the Contents API, fall back to raw.
  if (/github\.com\//.test(u)) {
    const gh = await fetchGitHubSkill(u);
    if (gh) return gh;
  }

  return fetchDirectSkill(u);
}

async function fetchDirectSkill(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`failed to fetch ${url} (${resp.status})`);
  const content = await resp.text();
  const { meta } = parseFrontmatter(content);
  const urlName = url.split("/").pop().replace(/\.md$/i, "") || "imported-skill";
  return {
    files: { "SKILL.md": content },
    meta: {
      name: meta.name || urlName,
      description: meta.description || `Imported from ${url}`,
      author: meta.author,
    },
  };
}

// Parse https://github.com/owner/repo[/tree|blob/branch[/path]]
function parseGitHubUrl(url) {
  const m = String(url).match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/(tree|blob)\/([^/]+)(?:\/(.+))?)?$/,
  );
  if (!m) return null;
  return { owner: m[1], repo: m[2], branch: m[4] || "main", path: m[5] || "" };
}

async function fetchGitHubSkill(url) {
  const parsed = parseGitHubUrl(url);
  if (!parsed) return null;
  const { owner, repo, branch, path } = parsed;

  const apiUrl = path
    ? `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`
    : `https://api.github.com/repos/${owner}/${repo}/contents?ref=${branch}`;
  let skillContent = null;
  let author = owner;

  try {
    const resp = await fetch(apiUrl, { headers: { Accept: "application/vnd.github.v3+json" } });
    if (resp.ok) {
      const data = await resp.json();
      const items = Array.isArray(data) ? data : [];
      const skillFile = items.find((i) => i.type === "file" && i.name === "SKILL.md");
      if (skillFile?.download_url) {
        const fr = await fetch(skillFile.download_url);
        if (fr.ok) skillContent = await fr.text();
      } else {
        // A repo whose skills live under skills/ or .agents/skills/.
        const dirs = items.filter((i) => i.type === "dir");
        for (const dir of dirs) {
          const dresp = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/contents/${dir.path}?ref=${branch}`,
            { headers: { Accept: "application/vnd.github.v3+json" } },
          );
          if (!dresp.ok) continue;
          const dItems = await dresp.json();
          const sub = (Array.isArray(dItems) ? dItems : []).find(
            (i) => i.type === "file" && i.name === "SKILL.md",
          );
          if (sub?.download_url) {
            const fr = await fetch(sub.download_url);
            if (fr.ok) { skillContent = await fr.text(); break; }
          }
        }
      }
    }
  } catch { /* fall through to raw */ }

  if (!skillContent) {
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path ? path + "/" : ""}SKILL.md`;
    const resp = await fetch(rawUrl);
    if (!resp.ok) return null;
    skillContent = await resp.text();
  }

  const { meta } = parseFrontmatter(skillContent);
  return {
    files: { "SKILL.md": skillContent },
    meta: {
      name: meta.name || `${owner}/${repo}`,
      description: meta.description || `Skill from ${owner}/${repo}`,
      author: meta.author || owner,
    },
  };
}

/**
 * Install an imported skill into the master store (under `importedSkills`).
 * The skill becomes /skill:<id>-referenceable and attachable to agents.
 */
export async function installImportedSkill(memory, fetched) {
  const name = fetched.meta.name || "imported-skill";
  const id = slugifySkillId(name);
  const skill = {
    id,
    name,
    description: fetched.meta.description || "",
    author: fetched.meta.author,
    source: "imported",
    mode: "on-demand",
    category: "imported",
    prompt: fetched.files["SKILL.md"] ?? "",
    requiredCapabilities: [],
    importedAt: Date.now(),
  };
  const list = (await memory.get("importedSkills")) ?? [];
  const idx = list.findIndex((s) => s.id === id);
  if (idx >= 0) list[idx] = skill;
  else list.push(skill);
  await memory.set("importedSkills", list);
  return skill;
}
