// lib/skill-files.js — OPFS-backed storage for imported SKILL BODIES.
//
// Why a dedicated file store: the memory layer caps a single value at 256KiB
// (MAX_VALUE_BYTES in lib/memory.js) — a physical bound on one serialized
// JSON value. A 300KiB SKILL.md cannot live in one memory value, and the
// SKILLS-UNCAPPED-01 budgets (2MiB per file, 8MiB per import) certainly
// cannot. Skills are FILES (SKILL.md + scripts/ + references/ — cf.
// cloudflare/skills); they are stored as real OPFS files under
// cap-skills/<skill-id>/<path>. Memory holds only the metadata index.
//
// The OPFS root handle is INJECTABLE (getDirectory) so the store is
// unit-testable with the in-memory fake from tests/agent-opfs-teardown.test.ts.

const SKILLS_ROOT = "cap-skills";

export const SKILL_FILE_BUDGET = 2 * 1024 * 1024; // per stored file
export const SKILL_TOTAL_BUDGET = 8 * 1024 * 1024; // per skill (all files)

/** Only [a-z0-9-_] survives — skill ids are slugified upstream, this is
 * defense-in-depth for the OPFS directory name. */
export function sanitizeSkillId(id) {
  return String(id ?? "").replace(/[^a-z0-9_-]/gi, "").slice(0, 96) || "skill";
}

/** Resolve + validate a file path within a skill: no leading slash, no `..`
 * segments, no backslashes, no NUL. Returns the cleaned segments or null. */
export function skillPathSegments(path) {
  if (typeof path !== "string" || !path) return null;
  if (path.includes("\u0000") || path.includes("\\")) return null;
  const parts = path.split("/");
  const out = [];
  for (const p of parts) {
    if (!p || p === "." || p === "..") return null;
    out.push(p);
  }
  if (out.length === 0) return null;
  return out;
}

/** The cap-skills root (injectable for tests). */
export async function openSkillsRoot(getDirectory = null) {
  const getDir = getDirectory ??
    (typeof navigator !== "undefined" && navigator.storage?.getDirectory
      ? navigator.storage.getDirectory.bind(navigator.storage)
      : null);
  if (!getDir) throw new Error("OPFS unavailable — cannot store skill files");
  const root = await getDir();
  return await root.getDirectoryHandle(SKILLS_ROOT, { create: true });
}

async function openSkillDir(id, { create = false, getDirectory = null } = {}) {
  const root = await openSkillsRoot(getDirectory);
  return await root.getDirectoryHandle(sanitizeSkillId(id), { create });
}

/**
 * Write a skill's whole files map into OPFS, enforcing the physical budgets
 * BEFORE any write (a partial skill is a broken skill — reject, not truncate).
 * Returns { fileCount, totalBytes }.
 */
export async function writeSkillFiles(id, files, { getDirectory = null } = {}) {
  const entries = Object.entries(files ?? {});
  let total = 0;
  const sized = [];
  for (const [path, body] of entries) {
    const segments = skillPathSegments(path);
    if (!segments) {
      throw new Error(`skill file path is not safe: "${path}"`);
    }
    const bytes = new TextEncoder().encode(String(body ?? "")).byteLength;
    if (bytes > SKILL_FILE_BUDGET) {
      throw new Error(
        `skill file "${path}" is too large (${bytes} bytes > ${SKILL_FILE_BUDGET} per-file budget; split it or shrink it)`,
      );
    }
    total += bytes;
    if (total > SKILL_TOTAL_BUDGET) {
      throw new Error(
        `skill import exceeds the ${SKILL_TOTAL_BUDGET}-byte total budget (${total} bytes); remove files or shrink them`,
      );
    }
    sized.push({ segments, text: String(body ?? "") });
  }
  const dir = await openSkillDir(id, { create: true, getDirectory });
  for (const { segments, text } of sized) {
    let d = dir;
    for (const seg of segments.slice(0, -1)) {
      d = await d.getDirectoryHandle(seg, { create: true });
    }
    const fh = await d.getFileHandle(segments[segments.length - 1], { create: true });
    const w = await fh.createWritable();
    try {
      await w.write(new TextEncoder().encode(text));
    } finally {
      await w.close();
    }
  }
  return { fileCount: sized.length, totalBytes: total };
}

/** Read one stored skill file's text (path-validated). Throws NotFoundError
 * when the file is absent. */
export async function readSkillFile(id, path, { getDirectory = null } = {}) {
  const segments = skillPathSegments(path);
  if (!segments) throw new Error(`skill file path is not safe: "${path}"`);
  const dir = await openSkillDir(id, { create: false, getDirectory });
  let d = dir;
  for (const seg of segments.slice(0, -1)) {
    d = await d.getDirectoryHandle(seg);
  }
  const fh = await d.getFileHandle(segments[segments.length - 1]);
  const file = await fh.getFile();
  return typeof file.text === "function" ? await file.text() : new TextDecoder().decode(await file.arrayBuffer());
}

/** Delete a skill's whole OPFS directory (its bodies). */
export async function removeSkillFiles(id, { getDirectory = null } = {}) {
  try {
    const root = await openSkillsRoot(getDirectory);
    await root.removeEntry(sanitizeSkillId(id));
  } catch {
    /* absent skill dir is a no-op */
  }
}
