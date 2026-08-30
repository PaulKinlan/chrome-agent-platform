// scripts/changelog-delta.mjs — print the CHANGELOG entries that landed
// between the PREVIOUSLY-BUILT version and the CURRENT version, so the person
// building sees what's new since their last build (owner-requested:
// CAP-FB-20260830-BUILD-CHANGELOG-PRINT-01).
//
// Pure + importable (no side effects on import): build.mjs wires it to the
// atomic build lifecycle; the unit tests exercise the parser directly.
//
// Rules:
//   - Never FAIL the build over this feature: every read/parse error degrades
//     to a one-line warning, never a thrown build error.
//   - The previous-version record lives in .build/last-built-version
//     (gitignored, invocation-local, outside dist — never shipped, never in
//     the indexed-source scan, survives the dist-versions GC by design).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_DELTA_LIMIT = 10;
export const DEFAULT_BUILT_VERSION_PATH = ".build/last-built-version";

const VERSION_RE = /^\d+\.\d+\.\d+$/u;

/** Compare two dotted-numeric versions a,b → -1 | 0 | 1 (numeric per part). */
export function compareVersions(a, b) {
  const pa = String(a ?? "").split(".").map((n) => Number(n) || 0);
  const pb = String(b ?? "").split(".").map((n) => Number(n) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function isValidVersion(v) {
  return typeof v === "string" && VERSION_RE.test(v);
}

/**
 * Parse a CHANGELOG.md body into newest-first entries:
 * `## [x.y.z] — title` header + following `- bullet` lines until the next
 * header. Malformed headers are skipped (warned by the caller's counts).
 * Returns [{ version, title, bullets: string[] }].
 */
export function parseChangelog(md) {
  const out = [];
  const lines = String(md ?? "").split(/\r?\n/u);
  let current = null;
  for (const raw of lines) {
    if (raw == null) continue; // never throw on malformed/null lines
    const line = String(raw).trimEnd();
    const header = line.match(/^##\s*\[([0-9]+\.[0-9]+\.[0-9]+)\]\s*(?:—|-)?\s*(.*)$/u);
    if (header) {
      current = { version: header[1], title: header[2].trim(), bullets: [] };
      out.push(current);
      continue;
    }
    if (current && /^-\s+/u.test(line)) {
      current.bullets.push(line.replace(/^-\s+/u, ""));
    }
  }
  return out;
}

/**
 * The entries the user has NOT seen yet: version > previous && version <=
 * current, in FILE order (newest first). Skips malformed/missing entries.
 */
export function deltaBetween(parsed, previousVersion, currentVersion) {
  const out = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object" || !isValidVersion(entry.version)) continue;
    const c = compareVersions(entry.version, currentVersion);
    if (c > 0) continue; // newer than current (future/unknown)
    if (previousVersion && isValidVersion(previousVersion)) {
      if (compareVersions(entry.version, previousVersion) <= 0) continue;
    }
    out.push(entry);
  }
  return out;
}

/**
 * Render the delta as printable lines, newest LAST (a build reads top-down,
 * so the most recent change is what you just built — it lands at the bottom).
 * The input arrives newest-first (deltaBetween file order); this reverses to
 * oldest→newest so the newest entry is the FINAL line. Bounded: the newest
 * `limit` entries print in full, older ones collapse into a "… N older
 * entr(ies)" note.
 */
export function renderDelta(entries, limit = DEFAULT_DELTA_LIMIT) {
  if (!Array.isArray(entries) || entries.length === 0) return "";
  const clean = entries.filter((e) => e && typeof e === "object");
  const total = clean.length;
  if (total === 0) return "";
  // Input is newest-first; slice the NEWEST `limit`, then reverse so the
  // oldest of the shown set prints first and the newest prints LAST.
  const shown = clean.slice(0, limit).reverse();
  const lines = [];
  for (const entry of shown) {
    const head = `- ${entry.version} — ${entry.title}`.trim();
    lines.push(head);
    for (const bullet of entry.bullets.slice(0, 8)) {
      lines.push(`    ${bullet}`);
    }
    if (entry.bullets.length > 8) {
      lines.push(`    … ${entry.bullets.length - 8} more bullet(s)`);
    }
  }
  const older = total - shown.length;
  if (older > 0) {
    lines.push(`… ${older} older entr${older === 1 ? "y" : "ies"} — see CHANGELOG.md`);
  }
  return lines.join("\n");
}

/**
 * Pure decision seam for the build record: the version may only be recorded
 * after EVERY fatal step (staging cleanup + lock release) completed without
 * setting a non-zero exit code. Exported so the unit tests pin the
 * "no record on late fatal failure" rule without invoking a real build.
 */
export function shouldRecordBuild({ buildSucceeded = false, exitCode = 0 } = {}) {
  return buildSucceeded === true && (Number(exitCode) || 0) === 0;
}

/** Read the recorded previous build version; null when absent/unreadable. */
export async function readLastBuiltVersion(builtVersionPath) {
  try {
    const value = (await readFile(builtVersionPath, "utf8")).trim();
    return isValidVersion(value) ? value : null;
  } catch {
    return null;
  }
}

/** Record the version of a SUCCESSFUL build (never called on failure). */
export async function writeLastBuiltVersion(builtVersionPath, version) {
  if (!isValidVersion(version)) return;
  await mkdir(path.dirname(builtVersionPath), { recursive: true });
  await writeFile(builtVersionPath, `${version}\n`, "utf8");
}
