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

// Bounds for external skill import (the one fetch-and-persist path).
// These are PHYSICAL budgets, not arbitrary caps: a skill's body can be large
// (SKILL.md + scripts/ + references/ directories, cf. cloudflare/skills), and
// the product must accept it — but the fetch-and-persist path must still be
// bounded so a hostile URL cannot drive unbounded downloads or storage. The
// old 64KiB ceiling (owner: "I don't want arbitrary constraints, especially
// around skills") is gone; skills up to 2MiB per file / 8MiB total import.
const MAX_SKILL_FILE_BYTES = 2 * 1024 * 1024; // 2MiB per fetched file
const MAX_SKILL_TOTAL_BYTES = 8 * 1024 * 1024; // 8MiB per import (all files)
const MAX_DIR_WALK = 64; // max subdirectories walked on a GitHub repo

/** Read a response body, capped at the per-file budget (reject, not truncate).
 * @param {string} label what is being read (for the error message) */
async function readSkillText(resp, label = "skill") {
  const declared = Number(resp.headers.get("content-length") ?? 0);
  if (declared > MAX_SKILL_FILE_BYTES) {
    throw new Error(
      `${label} is too large (${declared} bytes > ${MAX_SKILL_FILE_BYTES} per-file budget; split it or shrink it)`,
    );
  }
  const buf = await resp.arrayBuffer();
  if (buf.byteLength > MAX_SKILL_FILE_BYTES) {
    throw new Error(
      `${label} is too large (${buf.byteLength} bytes > ${MAX_SKILL_FILE_BYTES} per-file budget; split it or shrink it)`,
    );
  }
  return new TextDecoder().decode(buf);
}

/** Track the running total for a multi-file import and reject when the total
 * budget is exhausted (reject, not truncate — a partial skill is a broken skill). */
function makeTotalBudget(label) {
  let total = 0;
  return {
    add(byteLength) {
      total += byteLength;
      if (total > MAX_SKILL_TOTAL_BYTES) {
        throw new Error(
          `${label} import exceeds the ${MAX_SKILL_TOTAL_BYTES}-byte total budget (${total} bytes); remove files or shrink them`,
        );
      }
      return total;
    },
  };
}

/**
 * Fetch a SKILL.md from a GitHub repo URL or a direct markdown URL.
 * Returns { files: {SKILL.md: content}, meta: {name, description, author} }.
 * Mirrors ~/chaos's skill-fetcher: GitHub Contents API → raw fallback → direct URL.
 */
export async function fetchSkillFromUrl(url) {
  const u = String(url ?? "").trim();
  if (!u) throw new Error("no skill URL provided");

  // Only http(s) — reject file:/data:/anything else (no scheme restriction
  // would let an untrusted URL reach a local/privileged fetch).
  let parsedUrl;
  try { parsedUrl = new URL(u); } catch { throw new Error("invalid skill URL"); }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("skill URL must be http(s)");
  }

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
  const content = await readSkillText(resp);
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
  // The directory containing SKILL.md (repo-relative) — files are keyed
  // relative to it. Declared at function scope (the multi-file walk below
  // reads it after the SKILL.md discovery block).
  let skillParent = "";
  // Multi-file skill: every walked file lands in `files` keyed by its path
  // RELATIVE TO THE DIRECTORY CONTAINING SKILL.md (so the skill's own layout
  // is preserved: SKILL.md, scripts/, references/, …). Bounded by the per-file
  // budget, the total-import budget, and MAX_DIR_WALK.
  const files = {};

  const contents = async (p) => {
    const resp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${p}?ref=${branch}`,
      { headers: { Accept: "application/vnd.github.v3+json" } },
    );
    if (resp.status === 403 || resp.status === 429) {
      throw new Error(
        `GitHub API rate-limited (HTTP ${resp.status}) while walking ${owner}/${repo}; wait and retry, or use a raw.githubusercontent.com URL`,
      );
    }
    if (!resp.ok) return null;
    const data = await resp.json();
    return Array.isArray(data) ? data : [];
  };

  const fetchFileBody = async (file) => {
    if (!file?.download_url) return null;
    const fr = await fetch(file.download_url);
    if (!fr.ok) return null;
    const label = `${owner}/${repo} ${file.path ?? file.name}`;
    return await readSkillText(fr, label);
  };

  try {
    const items = (await contents(path)) ?? [];
    skillParent = path ? String(path).replace(/\/$/, "") : "";
    const skillFile = items.find((i) => i.type === "file" && i.name === "SKILL.md");
    if (skillFile?.download_url) {
      const body = await fetchFileBody(skillFile);
      if (body) skillContent = body;
    } else {
      // A repo whose skills live under skills/ or .agents/skills/. Bound the
      // walk (MAX_DIR_WALK) so a hostile repo can't drive unbounded fetches.
      const dirs = items.filter((i) => i.type === "dir").slice(0, MAX_DIR_WALK);
      for (const dir of dirs) {
        const dItems = (await contents(dir.path)) ?? [];
        const sub = dItems.find((i) => i.type === "file" && i.name === "SKILL.md");
        if (sub?.download_url) {
          const body = await fetchFileBody(sub);
          if (body) { skillContent = body; skillParent = dir.path; break; }
        }
      }
    }
  } catch (e) {
    if (String(e?.message ?? "").includes("rate-limited")) throw e;
    /* fall through to raw */
  }

  if (!skillContent) {
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path ? path + "/" : ""}SKILL.md`;
    const resp = await fetch(rawUrl);
    if (!resp.ok) return null;
    skillContent = await readSkillText(resp, `${owner}/${repo} SKILL.md`);
  }

  // Re-walk the SKILL.md's own directory tree to collect every sibling file
  // (scripts/, references/, …). BUDGET rejections (a file or the total past
  // the physical import budgets) FAIL the import loudly — a partial skill is
  // a broken skill, and an honest error is never silent. Only transient API
  // failures (a rate limit / missing dir mid-walk) stay best-effort: the
  // SKILL.md body alone is still a valid skill then.
  const total = makeTotalBudget(`${owner}/${repo}`);
  files["SKILL.md"] = skillContent;
  total.add(new TextEncoder().encode(skillContent).byteLength);
  try {
    let dirsToWalk = 0;
    const walk = async (dir) => {
      if (dirsToWalk >= MAX_DIR_WALK) return;
      const items = (await contents(dir)) ?? [];
      for (const item of items) {
        if (item?.type === "dir") {
          if (dirsToWalk < MAX_DIR_WALK) {
            dirsToWalk += 1;
            await walk(item.path);
          }
        } else if (item?.type === "file" && item.name !== "SKILL.md") {
          const body = await fetchFileBody(item);
          if (body === null) continue;
          // key the file by its path relative to the SKILL.md parent so the
          // skill's own layout is preserved (SKILL.md, scripts/, references/)
          const rel = skillParent ? item.path.replace(skillParent + "/", "") : item.path;
          if (rel === "SKILL.md" || rel in files) continue;
          files[rel] = body;
          total.add(new TextEncoder().encode(body).byteLength);
        }
      }
    };
    await walk(skillParent);
  } catch (e) {
    // Physical-budget violations (per-file / total) are REAL failures — the
    // importer must not silently drop the offending file(s). Transient API
    // errors (rate limit mid-walk, missing dir) keep the SKILL.md-only fallback.
    const msg = String(e?.message ?? "");
    if (msg.includes("per-file budget") || msg.includes("total budget")) throw e;
    /* transient — best-effort */
  }

  const { meta } = parseFrontmatter(skillContent);
  return {
    files,
    meta: {
      name: meta.name || `${owner}/${repo}`,
      description: meta.description || `Skill from ${owner}/${repo}`,
      author: meta.author || owner,
    },
  };
}

/**
 * Install an imported skill. The SKILL BODIES (SKILL.md + scripts/ +
 * references/ — the multi-file map) are written to the OPFS skill-files
 * store; memory keeps a metadata-only INDEX row (bodies can exceed the
 * memory store's 256KiB per-value bound, CAP-FB-20260830-SKILLS-UNCAPPED-01).
 *
 * @param {object} memory the master memory store
 * @param {object} fetched { files, meta } from fetchSkillFromUrl
 * @param {object=} fileStore { writeSkillFiles(id, files), removeSkillFiles(id) }
 *   defaults to lib/skill-files.js (OPFS). Tests inject an in-memory fake.
 */
export async function installImportedSkill(memory, fetched, fileStore = null) {
  const name = fetched.meta.name || "imported-skill";
  const id = slugifySkillId(name);
  const files =
    fetched.files && typeof fetched.files === "object" ? fetched.files : { "SKILL.md": fetched.files?.["SKILL.md"] ?? "" };
  const prompt = files["SKILL.md"] ?? "";
  const promptBytes = new TextEncoder().encode(String(prompt ?? "")).byteLength;
  const store = fileStore ?? (await import("./skill-files.js"));
  const { fileCount, totalBytes } = await store.writeSkillFiles(id, files);
  const skill = {
    id,
    name,
    description: fetched.meta.description || "",
    author: fetched.meta.author,
    source: "imported",
    mode: "on-demand",
    category: "imported",
    // Metadata only — the body lives in OPFS (small skills read it back via
    // resolveRecipe; large skills compose a skill_read marker instead).
    prompt: "",
    promptBytes,
    fileCount,
    totalBytes,
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

/** Remove an imported skill: its index row AND its OPFS bodies. */
export async function removeImportedSkill(memory, id, fileStore = null) {
  const store = fileStore ?? (await import("./skill-files.js"));
  const list = (await memory.get("importedSkills")) ?? [];
  const next = list.filter((s) => s.id !== id);
  if (next.length === list.length) return { ok: false, error: "no imported skill with that id" };
  await memory.set("importedSkills", next);
  await store.removeSkillFiles(id).catch(() => null);
  return { ok: true };
}

// Legacy imported-skill migration (CAP-FB-20260830-SKILLS-UNCAPPED-01):
// records imported BEFORE the OPFS body store kept the SKILL.md body inline
// (`prompt`) with no files map / OPFS files and no `promptBytes`. On read,
// migrate the inline body into the OPFS store and enrich the index row so no
// existing skill's body disappears after the storage change. Idempotent:
// fresh rows carry `promptBytes`, so a re-read skips the write. If the body
// store is unavailable the legacy row is returned untouched (its inline body
// still composes) — the migration is never destructive.
/**
 * @param {object} memory the master memory store (index rows)
 * @param {object} row one imported-skill index row
 * @param {object=} fileStore { writeSkillFiles(id, files), … } — defaults to
 *   lib/skill-files.js (OPFS); tests inject an in-memory fake
 * @returns {Promise<object>} the migrated (or untouched) row
 */
export async function loadImportedSkill(memory, row, fileStore = null) {
  if (!row || typeof row !== "object") return row;
  if (Number.isInteger(row.promptBytes)) return row; // fresh / already migrated
  const body = typeof row.prompt === "string" ? row.prompt : "";
  const files = row.files && typeof row.files === "object" ? row.files : {};
  if (!files["SKILL.md"] && body) files["SKILL.md"] = body;
  const migrated = {
    ...row,
    prompt: "",
    promptBytes: new TextEncoder().encode(body).byteLength,
  };
  delete migrated.files; // index rows are metadata-only (bodies live in OPFS)
  const store = fileStore ?? (await import("./skill-files.js"));
  try {
    const { fileCount, totalBytes } = await store.writeSkillFiles(row.id, files);
    migrated.fileCount = fileCount;
    migrated.totalBytes = totalBytes;
  } catch {
    // Body store unavailable / budget exceeded — keep the LEGACY row intact
    // (inline body preserved) so nothing disappears, and FLAG the failure so
    // the caller can warn. The flag also tells the prompt composer that the
    // body is NOT store-backed: skill_read cannot serve it, so a skill_read
    // marker would be a dead loader — the full inline body composes instead
    // (renderBoundarySkills keys the marker on integer promptBytes only).
    return { ...row, migrationFailed: true };
  }
  // Persist the migrated metadata row so future reads skip the migration.
  const list = (await memory.get("importedSkills")) ?? [];
  const idx = list.findIndex((s) => s.id === row.id);
  if (idx >= 0) {
    list[idx] = migrated;
    await memory.set("importedSkills", list);
  }
  return migrated;
}

/** Load + migrate every imported-skill index row (read paths use this). */
export async function loadAllImportedSkills(memory, fileStore = null) {
  const imported = (await memory.get("importedSkills")) ?? [];
  const out = [];
  for (const r of imported) out.push(await loadImportedSkill(memory, r, fileStore));
  return out;
}
