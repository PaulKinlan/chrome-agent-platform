// scripts/lib/lockfile-delta.mjs — Class-1 lockfile certification for the FAST selector
// (chrome-agent-platform-lezl0, contract: ADR chrome-agent-platform-gx0wg, findings ke9rp + fuixm).
//
// THE PROBLEM THIS SOLVES. Before this module the selector had exactly one answer for a dependency
// delta: refuse. package.json / package-lock.json / extension/manifest.json are BOOKKEEPING_FILES and
// classsifyUncovered() fails them closed ("release/version JSON belongs to the merger"), deno.lock has
// no importer at all, and a lockfile change therefore escalated `test:changed` to the FULL suite. The
// cost is measured, twice: the FAST tier cannot finish a 760-file sweep inside its bound (fuixm — three
// consecutive INTERRUPTED fast gates at ~600s on a fast-uri bump), and a union whose whole delta was
// three docs files plus a lockfile bump was killed after the 1800s bound (ke9rp). That is the worst
// possible shape: "fast" is never available for the class of change that most often needs to land
// quickly, so lockfile work batches into 3-hour union gates.
//
// THE CONTRACT (ADR gx0wg). Subset certification is CLOSURE-BASED: a delta is certifiable by exactly
// the suite set that a machine-checked closure of its own BYTES selects. So this module does not
// guess from the file name; it parses both sides of the delta and answers "which suites does this
// exact byte-delta oblige?", and when it cannot answer by name, it says so and the selector runs the
// full suite. Ambiguity is ALWAYS `kind: "full"` with a NAMED reason — never a silent narrowing.
//
// WHAT A LOCKFILE DELTA CAN AFFECT, and what covers it:
//
//   1. THE VERSION COUNTER ONLY — the landing stamp (scripts/bump-version.mjs rewrites package.json
//      version, package-lock.json version + packages[""].version, and extension/manifest.json
//      version on EVERY landing). This is not a dependency change and it is not even a source change
//      to any module the tree executes: it is bookkeeping, and chrome-agent-platform-nco2 conflated
//      it with a dependency bump when it made the whole class fail closed. Verdict: PASSIVE
//      BOOKKEEPING, certified by the always-on set alone (which includes the manifest and changelog
//      guards, and `build:production`'s "one live version" assertion on every gate).
//
//   2. THE RESOLVED SET IS UNCHANGED AND ONLY HASHES MOVED (deno.lock "integrity-only"). No import
//      graph edge changed, so no importer's behaviour can change; what moved is the pin on bytes the
//      build verifies. Verdict: the DECLARED READER — tests/security-dependency-locks.test.ts — plus
//      the always-on set. That guard parses BOTH locks and asserts (a) every package in its advisory
//      table is still pinned in deno.lock and (b) every pinned version clears the advisory fix floor,
//      so it is exactly the suite that reads these bytes as data. (The build tier's content key also
//      invalidates on ANY lockfile byte, so "the build ran over the refetched bytes" is proven there,
//      not asserted here.)
//
//   3. A PACKAGE SET CHANGED. The delta names package(s); the caller resolves repo importers
//      (`pkg`, `pkg/subpath`, `npm:pkg@range`, `jsr:@scope/pkg@range`); their reverse-import closure is
//      the suite set, plus the declared-reader guard, plus the always-on set.
//
//      STATED FAIL-OPEN, PINNED SO REVIEW CAN ATTACK IT: a changed npm/specifier/workspace entry with
//      NO repo importer is STILL a subset, WITH the guard. It is not a hole that slipped in: most
//      declared dependencies legitimately have no importer (a types-only package, a CLI, a
//      peer-transitive pin), and the guard is the declared reader of those exact declarations — it
//      asserts pins and advisory floors over the new bytes. This is the one fail-open-with-guard case
//      in the module, it is named in every ledger line it produces, and
//      tests/lockfile-delta.test.ts pins both directions (a real change still selects its closure; an
//      unattributable declared name still selects the guard).
//
//      A REMOTE URL, JSR ENTRY OR REDIRECT with no importer is DIFFERENT and stays FULL: no guard in
//      this repo reads those sections as data, so nothing in a subset would look at the new bytes.
//
//   4. ANYTHING ELSE — a manifest delta beyond the version counter (permissions, CSP,
//      web_accessible_resources: the always-on manifest guard does not prove those), a package.json
//      field that is not a version stamp or a dependency declaration (scripts, engines, workspaces),
//      a lockfile format-version change, an unknown top-level field, an unparseable/truncated/
//      merge-marked side, an added or deleted lockfile — is `kind: "full"` with the reason named.
//
// PURITY. This module reads no files, spawns nothing and knows no git ref: sides arrive as text and
// importers arrive from an injected `closureFor`, so every rule above is testable without a repo
// state (tests must never depend on another agent's tree or on test order).

/** The four files this module certifies. `package.json` + `package-lock.json` are ONE unit. */
export const LOCKFILE_CLASS_FILES = Object.freeze([
  "package.json",
  "package-lock.json",
  "deno.lock",
  "extension/manifest.json",
]);

/**
 * The DECLARED READER for a dependency delta (coord's measured precondition): it parses BOTH
 * package-lock.json and deno.lock, asserts every advisory-table package is still pinned in deno.lock
 * and that every pinned version clears the advisory fix floor. Any change to the resolved set or to a
 * pin is read by this suite, which is why it accompanies every non-passive verdict below.
 */
export const DEPENDENCY_LOCK_GUARD = "tests/security-dependency-locks.test.ts";

/** The ledger prefix every verdict line carries, so a reviewer can see the closure, not infer it. */
export const LOCKFILE_DELTA_LEDGER_PREFIX = "lockfile-delta:";

/** Dependency maps, the only package.json / lock-root fields whose change names packages. */
const DEPENDENCY_FIELDS = Object.freeze([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
]);

/** `true` for the four files this module owns. */
export function isLockfileClassFile(rel) {
  return LOCKFILE_CLASS_FILES.includes(String(rel ?? "").replace(/\\/g, "/"));
}

// ── canonical forms ────────────────────────────────────────────────────────────────────────────
// Key ORDER is not a dependency change (a lockfile rewritten by a different npm patch reorders
// objects), so comparisons are canonicalised rather than byte-compared.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
    return out;
  }
  return value;
}

function sameJson(a, b) {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/** Top-level keys whose value differs between two objects. */
function changedKeys(before = {}, after = {}) {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return [...keys].filter((key) => !sameJson(before?.[key], after?.[key])).sort();
}

// ── package-name extraction ───────────────────────────────────────────────────────────────────
/**
 * `node_modules/@scope/name` (or a nested `node_modules/a/node_modules/b`) -> `@scope/name`.
 * Returns null for the root entry (`""`) and for a path this module cannot read as a package.
 */
export function packageNameFromLockPath(key) {
  const path = String(key ?? "");
  const marker = "node_modules/";
  const at = path.lastIndexOf(marker);
  if (at < 0) return null;
  const name = path.slice(at + marker.length);
  return name ? name : null;
}

/**
 * A deno.lock `npm` key (`@ai-sdk/anthropic@4.0.45_zod@3.25.76`) -> `@ai-sdk/anthropic`.
 * The `_<peer>@<version>` suffix is npm peer-resolution, not part of the package name.
 */
export function packageNameFromNpmKey(key) {
  const text = String(key ?? "");
  const at = text.indexOf("@", 1);
  if (at < 0) return text || null;
  const name = text.slice(0, at);
  return name || null;
}

/**
 * A bare import specifier (`zod`, `zod/v4`, `npm:zod@^3`, `jsr:@std/assert@1`) -> the package name
 * it names. Returns null for relative/URL specifiers, which are not package references.
 */
export function packageNameFromSpecifier(specifier) {
  let text = String(specifier ?? "").trim();
  if (!text || text.startsWith(".") || text.startsWith("/") || text.includes("://")) return null;
  text = text.replace(/^(npm|jsr):/, "");
  // Drop a version/range suffix FIRST (`zod@^3`, `@std/assert@1`, `acorn@8.18.0`): a version suffix
  // after a subpath would otherwise survive as part of the subpath and truncate a scoped name.
  const at = text.indexOf("@", 1);
  if (at >= 0) text = text.slice(0, at);
  // Then drop a subpath (`pkg/sub`, `@scope/pkg/sub`). A SCOPED name owns exactly one slash.
  if (text.startsWith("@")) {
    const first = text.indexOf("/", 1);
    if (first >= 0) {
      const second = text.indexOf("/", first + 1);
      if (second >= 0) text = text.slice(0, second);
    }
  } else {
    const slash = text.indexOf("/");
    if (slash >= 0) text = text.slice(0, slash);
  }
  return text || null;
}

/** Does this import specifier name that package (`pkg` or `pkg/subpath`, any scheme)? */
export function specifierNamesPackage(specifier, packageName) {
  const text = String(specifier ?? "").trim();
  const name = String(packageName ?? "").trim();
  if (!text || !name) return false;
  if (text === name) return true;
  if (text.startsWith(`${name}/`)) return true;
  const bare = text.replace(/^(npm|jsr):/, "");
  if (bare === name) return true;
  if (bare.startsWith(`${name}/`)) return true;
  // `npm:@scope/pkg@^1` / `jsr:@std/assert@1` — strip the range and re-apply the two rules above.
  const at = bare.indexOf("@", 1);
  if (at >= 0) {
    const stripped = bare.slice(0, at);
    if (stripped === name || stripped.startsWith(`${name}/`)) return true;
  }
  return false;
}

// ── parsing ───────────────────────────────────────────────────────────────────────────────────
/** A delta side is `{ base, tip }`, either of which may be `null` (added / deleted file). */
function parseSide(rel, side) {
  if (!side || (side.base == null && side.tip == null)) {
    return { ok: false, reason: `${rel}: no pair of sides to compare — an added or deleted lockfile has no delta to certify` };
  }
  if (side.base == null || side.tip == null) {
    return {
      ok: false,
      reason: `${rel}: ${side.base == null ? "added" : "deleted"} in this delta — a lockfile that did not exist on both sides has no comparable resolved set`,
    };
  }
  for (const [label, text] of [["base", side.base], ["tip", side.tip]]) {
    const raw = String(text);
    if (/^(?:<{7}|={7}|>{7})/m.test(raw)) {
      return { ok: false, reason: `${rel}: the ${label} side carries merge-conflict markers — a conflicted lockfile certifies nothing` };
    }
  }
  const parsed = {};
  for (const [label, text] of [["base", side.base], ["tip", side.tip]]) {
    try {
      parsed[label] = JSON.parse(String(text));
    } catch (error) {
      return { ok: false, reason: `${rel}: the ${label} side is unparseable (${error.message}) — truncated or hand-edited locks are never certifiable` };
    }
  }
  return { ok: true, base: parsed.base, tip: parsed.tip };
}

// ── version-counter-only (the landing stamp) ─────────────────────────────────────────────────
/**
 * Is this side's delta confined to the fields scripts/bump-version.mjs rewrites?
 *   package.json ............ version
 *   package-lock.json ....... version, packages[""].version
 *   extension/manifest.json . version
 */
export function isVersionCounterOnly(rel, side) {
  const path = String(rel ?? "").replace(/\\/g, "/");
  // Bytes or already-parsed objects: the ADR's unit is BYTES, so a parsed side is only a convenience.
  const asObject = (value) => (typeof value === "string" ? JSON.parse(value) : value);
  if (path === "package.json") {
    const before = { ...(asObject(side.base) ?? {}) };
    const after = { ...(asObject(side.tip) ?? {}) };
    if (before.version === after.version) return false; // no version delta at all: not this class
    delete before.version;
    delete after.version;
    return sameJson(before, after);
  }
  if (path === "package-lock.json") {
    const before = { ...(asObject(side.base) ?? {}) };
    const after = { ...(asObject(side.tip) ?? {}) };
    const rootBefore = { ...(before.packages?.[""] ?? {}) };
    const rootAfter = { ...(after.packages?.[""] ?? {}) };
    const versionMoved =
      before.version !== after.version || rootBefore.version !== rootAfter.version;
    if (!versionMoved) return false;
    delete before.version;
    delete after.version;
    delete rootBefore.version;
    delete rootAfter.version;
    before.packages = { ...(before.packages ?? {}), "": rootBefore };
    after.packages = { ...(after.packages ?? {}), "": rootAfter };
    return sameJson(before, after);
  }
  if (path === "extension/manifest.json") {
    const before = { ...(asObject(side.base) ?? {}) };
    const after = { ...(asObject(side.tip) ?? {}) };
    if (before.version === after.version) return false;
    delete before.version;
    delete after.version;
    return sameJson(before, after);
  }
  return false;
}

// ── package-lock + package.json (classified TOGETHER) ────────────────────────────────────────
function collectDeclaredChanges(before = {}, after = {}, names) {
  for (const field of DEPENDENCY_FIELDS) {
    const b = before?.[field] ?? {};
    const t = after?.[field] ?? {};
    for (const name of new Set([...Object.keys(b), ...Object.keys(t)])) {
      if (b[name] !== t[name]) names.add(name);
    }
  }
}

function stripDeclaredMaps(entry = {}) {
  const rest = { ...(entry ?? {}) };
  for (const field of DEPENDENCY_FIELDS) delete rest[field];
  return rest;
}

/**
 * The package set a package-lock.json delta names, or a named refusal when the delta has a shape
 * this module does not certify (an unknown field, a renamed root, a lockfile format change).
 */
function packageLockShape(base, tip) {
  const names = new Set();
  const unrecognised = [];
  for (const key of changedKeys(base, tip)) {
    // `version` is the landing stamp (scripts/bump-version.mjs rewrites it on every landing).
    if (key === "version" || key === "packages") continue;
    unrecognised.push(`package-lock.json: top-level field '${key}' changed`);
  }
  const before = base.packages ?? {};
  const after = tip.packages ?? {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const b = before[key];
    const t = after[key];
    if (sameJson(b, t)) continue;
    if (key === "") {
      collectDeclaredChanges(b, t, names);
      // The root entry carries the same version stamp as the top level.
      const restBefore = stripDeclaredMaps(b);
      const restAfter = stripDeclaredMaps(t);
      delete restBefore.version;
      delete restAfter.version;
      for (const field of changedKeys(restBefore, restAfter)) {
        unrecognised.push(`package-lock.json: root entry field '${field}' changed (not a version stamp or a dependency declaration)`);
      }
      continue;
    }
    const name = packageNameFromLockPath(key);
    if (name) names.add(name);
    else unrecognised.push(`package-lock.json: package entry '${key}' changed and no package name could be read from it`);
  }
  return { names, unrecognised };
}

/** The package set a package.json delta names (beyond the version stamp). */
function packageJsonShape(base, tip) {
  const names = new Set();
  const unrecognised = [];
  const restBefore = { ...(base ?? {}) };
  const restAfter = { ...(tip ?? {}) };
  delete restBefore.version;
  delete restAfter.version;
  for (const field of changedKeys(restBefore, restAfter)) {
    if (DEPENDENCY_FIELDS.includes(field)) {
      collectDeclaredChanges(restBefore, restAfter, names);
      continue;
    }
    unrecognised.push(`package.json: field '${field}' changed (neither a version stamp nor a dependency declaration)`);
  }
  return { names, unrecognised };
}

// ── deno.lock ────────────────────────────────────────────────────────────────────────────────
/** A deno.lock `specifiers` key/value -> the package it names, or null. */
function specifierPackageName(specifier) {
  const text = String(specifier ?? "").trim();
  if (text.startsWith("jsr:")) return packageNameFromSpecifier(text);
  if (text.startsWith("npm:")) return packageNameFromSpecifier(text);
  return null; // a bare relative specifier is not a package reference
}

/** `npm:@ai-sdk/anthropic@^4.0.45` -> `@ai-sdk/anthropic` (workspace declaration arrays). */
function declaredDependencyName(declaration) {
  return packageNameFromSpecifier(declaration);
}

/**
 * Classify a deno.lock delta into:
 *   resolved:      dependency names the lock guards read (npm entries, specifiers, workspace deps).
 *   edgeRequired:  names/URLs from sections NO guard reads as data (remote, jsr, redirects) — these
 *                  must resolve to real importers or the delta is FULL.
 *   integrityOnly: the resolved set (keys and dependency edges) is identical and only hashes moved.
 */
function denoLockShape(base, tip) {
  const resolved = new Set();
  const edgeRequired = new Set();
  const unrecognised = [];
  let integrityOnly = true;

  const SECTION_KEYS = Object.freeze(["version", "specifiers", "jsr", "npm", "redirects", "remote", "workspace"]);
  for (const key of changedKeys(base, tip)) {
    if (!SECTION_KEYS.includes(key)) unrecognised.push(`deno.lock: unknown top-level field '${key}' changed`);
  }
  if (base.version !== tip.version) {
    unrecognised.push(`deno.lock: lockfile format version ${String(base.version)} -> ${String(tip.version)} (the shape of every section may have moved)`);
  }

  // npm: the resolved package set. Keys and dependency edges are the graph; integrity/hash values are
  // pins on bytes the build verifies, so a hash-only change is integrity-only.
  const npmBefore = base.npm ?? {};
  const npmAfter = tip.npm ?? {};
  for (const key of new Set([...Object.keys(npmBefore), ...Object.keys(npmAfter)])) {
    const b = npmBefore[key];
    const t = npmAfter[key];
    if (sameJson(b, t)) continue;
    let hashOnly = false;
    if (b && t) {
      const restBefore = { ...b };
      const restAfter = { ...t };
      delete restBefore.integrity;
      delete restAfter.integrity;
      hashOnly = sameJson(restBefore, restAfter);
      if (!hashOnly) integrityOnly = false;
    } else {
      integrityOnly = false;
    }
    // A hash-only change moved no edge, so it names no package: the resolved set is identical and
    // the only thing that changed is the pin on bytes the build verifies.
    if (hashOnly) continue;
    // Key changes are named; a same-key dependency-edge change still names the package.
    const name = packageNameFromNpmKey(key);
    if (name) resolved.add(name);
    for (const dep of [...(b?.dependencies ?? []), ...(t?.dependencies ?? [])]) {
      const depName = packageNameFromSpecifier(dep);
      if (depName) resolved.add(depName);
    }
  }

  // specifiers: a declared range moved (`npm:zod@^3` -> `npm:zod@^4`) — the resolved graph moved with it.
  for (const key of changedKeys(base.specifiers ?? {}, tip.specifiers ?? {})) {
    integrityOnly = false;
    const name = specifierPackageName(key);
    if (name) resolved.add(name);
    else unrecognised.push(`deno.lock: specifier '${key}' changed and names no npm/jsr package`);
  }

  // remote: integrity-pinned URLs. Nothing in a subset reads these as data.
  for (const url of changedKeys(base.remote ?? {}, tip.remote ?? {})) {
    integrityOnly = false;
    edgeRequired.add(url);
  }

  // redirects: URL -> URL. Same reasoning as remote.
  for (const url of changedKeys(base.redirects ?? {}, tip.redirects ?? {})) {
    integrityOnly = false;
    edgeRequired.add(url);
  }

  // jsr: package entries, reader-less in this repo (the lock guard reads npm pins only).
  const jsrBefore = base.jsr ?? {};
  const jsrAfter = tip.jsr ?? {};
  for (const key of new Set([...Object.keys(jsrBefore), ...Object.keys(jsrAfter)])) {
    if (sameJson(jsrBefore[key], jsrAfter[key])) continue;
    let hashOnly = false;
    if (jsrBefore[key] && jsrAfter[key]) {
      const restBefore = { ...jsrBefore[key] };
      const restAfter = { ...jsrAfter[key] };
      delete restBefore.integrity;
      delete restAfter.integrity;
      hashOnly = sameJson(restBefore, restAfter);
      if (!hashOnly) integrityOnly = false;
    } else {
      integrityOnly = false;
    }
    if (hashOnly) continue;
    const name = packageNameFromNpmKey(key);
    if (name) edgeRequired.add(name);
    else unrecognised.push(`deno.lock: jsr entry '${key}' changed and no package name could be read from it`);
  }

  // workspace: the declared dependency array, i.e. the same declarations as package.json.
  const workspaceBefore = base.workspace ?? {};
  const workspaceAfter = tip.workspace ?? {};
  for (const key of changedKeys(workspaceBefore, workspaceAfter)) {
    if (key !== "packageJson") {
      unrecognised.push(`deno.lock: workspace field '${key}' changed and this module does not certify it`);
      continue;
    }
    const pkgBefore = workspaceBefore.packageJson ?? {};
    const pkgAfter = workspaceAfter.packageJson ?? {};
    for (const field of changedKeys(pkgBefore, pkgAfter)) {
      if (field !== "dependencies") {
        unrecognised.push(`deno.lock: workspace.packageJson field '${field}' changed and this module does not certify it`);
        continue;
      }
      const b = new Set(pkgBefore.dependencies ?? []);
      const t = new Set(pkgAfter.dependencies ?? []);
      for (const declaration of [...b, ...t]) {
        if (b.has(declaration) === t.has(declaration)) continue;
        integrityOnly = false;
        const name = declaredDependencyName(declaration);
        if (name) resolved.add(name);
        else unrecognised.push(`deno.lock: workspace dependency '${declaration}' names no package`);
      }
    }
  }

  return { resolved, edgeRequired, unrecognised, integrityOnly };
}

// ── the verdict ──────────────────────────────────────────────────────────────────────────────
function full(reason, extra = {}) {
  return {
    kind: "full",
    suites: [],
    packages: [],
    importers: {},
    unresolved: [],
    passive: false,
    integrityOnly: false,
    notes: [reason],
    reason,
    ...extra,
  };
}

/**
 * Classify a lockfile delta by its BYTES.
 *
 * @param {{ packageJson?: {base: string|null, tip: string|null}, packageLock?: {base: string|null, tip: string|null}, denoLock?: {base: string|null, tip: string|null}, manifest?: {base: string|null, tip: string|null} }} delta
 * @param {{
 *   coreSuites?: string[],
 *   dependencyGuards?: string[],
 *   closureFor?: (names: string[]) => { suites?: string[], importers?: Record<string, string[]>, unattributed?: string[] },
 * }} [options]
 * @returns {{kind: "subset"|"full", suites: string[], packages: string[], importers: Record<string, string[]>, unresolved: string[], passive: boolean, integrityOnly: boolean, notes: string[], reason: string}}
 */
export function classifyLockfileDelta(delta = {}, options = {}) {
  const coreSuites = [...(options.coreSuites ?? [])];
  const guards = [...(options.dependencyGuards ?? [DEPENDENCY_LOCK_GUARD])];
  const closureFor = typeof options.closureFor === "function"
    ? options.closureFor
    : () => ({ suites: [], importers: {}, unattributed: [] });

  const present = Object.keys(delta).filter((key) => delta[key]);
  if (!present.length) return full("no lockfile delta was supplied");

  // 1. Parse every side. An unparseable / conflicted / one-sided lock is never certifiable.
  const parsed = {};
  for (const key of present) {
    const rel = key === "manifest" ? "extension/manifest.json" : key === "denoLock" ? "deno.lock" : key === "packageLock" ? "package-lock.json" : "package.json";
    const side = parseSide(rel, delta[key]);
    if (!side.ok) return full(side.reason);
    parsed[key] = { rel, base: side.base, tip: side.tip, text: delta[key] };
  }

  // 2. The version-counter-only class. package.json + package-lock.json are ONE unit: the landing
  //    bump rewrites both, so "did only the stamp move" is a question about the union of the deltas.
  const versionOnly = {};
  for (const key of present) versionOnly[key] = isVersionCounterOnly(parsed[key].rel, parsed[key]);
  const passive = present.every((key) => versionOnly[key]);

  // 3. The package set (and any named refusal) from the non-passive sides.
  const resolved = new Set();
  const edgeRequired = new Set();
  const unrecognised = [];
  let integrityOnly = false;

  if (parsed.packageLock || parsed.packageJson) {
    if (versionOnly.packageLock !== false && versionOnly.packageJson !== false) {
      // Both sides of the unit are pure version stamps (or absent).
    } else {
      if (parsed.packageLock) {
        const shape = packageLockShape(parsed.packageLock.base, parsed.packageLock.tip);
        for (const name of shape.names) resolved.add(name);
        unrecognised.push(...shape.unrecognised);
      }
      if (parsed.packageJson) {
        const shape = packageJsonShape(parsed.packageJson.base, parsed.packageJson.tip);
        for (const name of shape.names) resolved.add(name);
        unrecognised.push(...shape.unrecognised);
      }
      // The landing stamp riding along with a real dependency change is not a refusal — the
      // dependency shape is what decides the suites.
      if (!resolved.size && !unrecognised.length) {
        unrecognised.push(
          "package.json/package-lock.json: the delta is neither a version stamp nor a dependency " +
            "change this module can name a package for",
        );
      }
    }
  }

  if (parsed.denoLock && !versionOnly.denoLock) {
    const shape = denoLockShape(parsed.denoLock.base, parsed.denoLock.tip);
    for (const name of shape.resolved) resolved.add(name);
    for (const name of shape.edgeRequired) edgeRequired.add(name);
    unrecognised.push(...shape.unrecognised);
    integrityOnly = shape.integrityOnly && !resolved.size && !edgeRequired.size && !unrecognised.length;
    if (!integrityOnly && !resolved.size && !edgeRequired.size && !unrecognised.length) {
      unrecognised.push("deno.lock: the delta changed no field this module can name a package or a guard for");
    }
  }

  if (parsed.manifest && !versionOnly.manifest) {
    const keys = changedKeys(parsed.manifest.base, parsed.manifest.tip).filter((key) => key !== "version");
    unrecognised.push(
      `extension/manifest.json: field(s) ${keys.map((k) => `'${k}'`).join(", ")} changed — a manifest delta beyond the ` +
        `version counter stays FULL in v1: the always-on manifest guard does not prove CSP or ` +
        `web_accessible_resources, so widening this class needs its own bead`,
    );
  }

  if (unrecognised.length) return full(unrecognised.join("; "));

  // 4. A pure version stamp is certified by the always-on set alone (nothing about the dependency
  //    graph, the bundles or the guards moved).
  if (passive) {
    const suites = [...new Set(coreSuites)].sort();
    return {
      kind: "subset",
      suites,
      packages: [],
      importers: {},
      unresolved: [],
      passive: true,
      integrityOnly: false,
      notes: [
        "version-counter-only (the landing stamp scripts/bump-version.mjs rewrites on every landing)",
      ],
      reason: "",
    };
  }

  // 5. Resolve the closure: importers of the changed packages, then their reverse-import tests.
  const names = [...new Set([...resolved])].sort();
  const closure = names.length ? closureFor(names) : { suites: [], importers: {}, unattributed: [] };
  const importers = closure.importers ?? {};
  const unattributed = new Set(closure.unattributed ?? []);

  // 6. Edge sections no guard reads (remote URLs, jsr entries, redirects) must resolve to a real
  //    import edge, or a subset would contain nothing that looks at the new bytes.
  const unresolved = [...edgeRequired].filter((name) => !importers[name]?.length).sort();
  if (unresolved.length) {
    return full(
      `deno.lock: ${unresolved.join(", ")} changed in a section no dependency guard reads ` +
        `(remote/jsr/redirects) and no repo importer resolves it — a subset would not inspect the new bytes`,
      { unresolved },
    );
  }

  const declaredGuards = guards.filter((guard) => !coreSuites.includes(guard));
  const suites = [...new Set([...coreSuites, ...declaredGuards, ...(closure.suites ?? [])])].sort();
  const notes = [];
  if (integrityOnly && !names.length) {
    notes.push("integrity-only: the resolved set and every dependency edge are unchanged, only pin hashes moved");
  }
  for (const name of names) {
    const files = importers[name] ?? [];
    const fileList = files.length ? files.join(", ") : "none";
    const why = files.length
      ? "imported by repo file(s) named here"
      : `no repo importer — certified by its declared reader (${guards.join(", ") || "none"}) over the new bytes`;
    notes.push(`${name} -> importers: ${fileList} -> ${why}`);
  }
  return {
    kind: "subset",
    suites,
    packages: names,
    importers,
    unresolved: [],
    passive: false,
    integrityOnly,
    notes,
    reason: "",
  };
}

/**
 * The ledger lines for a verdict: `lockfile-delta: <...>`. One line per named package (so review can
 * read package -> importers -> suites without a diff walk) plus a summary line for the class.
 * @param {{ verdict: object, files: string[], suites: string[] }} args
 */
export function lockfileDeltaLedgerLines({ verdict, files = [], suites = verdict?.suites ?? [] }) {
  const name = String(LOCKFILE_DELTA_LEDGER_PREFIX);
  const lines = [];
  if (!verdict) return lines;
  const scope = files.length ? files.join(" + ") : "lockfile";
  if (verdict.kind === "full") {
    lines.push(`${name} ${scope}: NOT CERTIFIABLE -> full suite -> ${verdict.reason}`);
    return lines;
  }
  if (verdict.passive) {
    lines.push(`${name} ${scope}: version-counter-only (landing stamp) -> suites: the always-on set (${suites.length})`);
    return lines;
  }
  if (verdict.integrityOnly) {
    lines.push(`${name} ${scope}: integrity-only (resolved set unchanged) -> suites: ${suites.length}`);
  }
  for (const note of verdict.notes ?? []) lines.push(`${name} ${scope}: ${note}`);
  lines.push(`${name} ${scope}: ${verdict.packages.length} package(s) -> ${suites.length} suite(s) selected (guard + closure + always-on)`);
  return lines;
}
