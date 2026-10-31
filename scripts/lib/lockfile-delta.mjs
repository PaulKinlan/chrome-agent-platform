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
//      version + version_name on EVERY landing; the set is pinned by
//      "lezl0: a REAL landing stamp is passive" in tests/lockfile-delta.test.ts). This is not a dependency change and it is not even a source change
//      to any module the tree executes: it is bookkeeping, and chrome-agent-platform-nco2 conflated
//      it with a dependency bump when it made the whole class fail closed. Verdict: PASSIVE
//      BOOKKEEPING, certified by the always-on set PLUS tests/first-run-onboarding-composition.test.ts,
//      which asserts the identity across all three surfaces (package.json version == package-lock
//      version == packages[""].version == manifest.version == manifest.version_name) and is the
//      stamp's real reader (review round 1, finding 1: it reads all three files by path and no import
//      graph reaches it). `version_name` is part of the counter: scripts/bump-version.mjs writes both
//      fields on every landing.
//
//   2. ONLY HASHES MOVED (integrity-only: resolved versions and dependency edges unchanged; npm, JSR
//      or a remote URL re-pin). NOT CERTIFIABLE BY A SUBSET — coord's ruling on review round 2, and the
//      reviewer's counterexample proves it: change packages["node_modules/zod"].integrity to a
//      different hash at the same version and every reader still passes, because a reader compares
//      VERSIONS, integrity PRESENCE and advisory FLOORS, and never recomputes a hash value. No suite in
//      this repo runs `npm ci`, and deno.runner.jsonc sets "lock": false, so nothing verifies the bytes
//      of a lockfile without an install (adding one to the gate is out of scope for this bead). A
//      bytes-only delta therefore joins parse-level ambiguity: `kind: "full"`, naming the entries.
//      (The build tier's content key does invalidate on any lockfile byte, so the build re-reads them —
//      but a subset gate may not lean on that.)
//
//   3. A PACKAGE SET CHANGED — and every changed entry must be INSPECTED by a suite in the selection.
//      This is the module's whole safety rule, and it is where review round 1 (gpt-6-sol) failed the
//      first version, correctly: that version certified a changed entry with no repo importer on the
//      strength of "the declared reader re-reads the new bytes", and the reader does no such thing for
//      an arbitrary entry — it asserts only the packages in its own advisory/patch tables. An unearned
//      claim about coverage is the same defect as a missing suite.
//
//      So an entry is certifiable only when one of three things is true, and each is resolved here:
//        (a) a repo file imports the package -> its reverse-import test closure;
//        (b) a repo file imports a package that TRANSITIVELY DEPENDS on it -> that dependent's
//            closure (this is how a types-only or peer-transitive pin is attributed to the code that
//            actually executes it: the lock's own dependency edges are the evidence);
//        (c) a declared reader VERIFIES that exact entry's changed value — DECLARED_PIN_READERS holds
//            only the two packages whose version a reader asserts against something other than
//            itself (fast-uri: npm <-> deno equality AND lock -> shipped drift; the MCP SDK: the same
//            drift check). Review round 2 stated the standard: a selected suite must verify the
//            CHANGED pin, not merely declare the package. `atLeast(version, floor)` bounds a version,
//            it does not verify the one that changed, so the advisory FLOOR tables are NOT declared
//            (hono, ip-address, proxy-addr, undici, body-parser): a change to those with no importer
//            and no imported dependent is FULL, because nothing in the tree checks it without an
//            install.
//      (c) also never covers a hash VALUE: no reader recomputes one. So (c) earns a version /
//      declaration change and never a bytes-only one — which is exactly what class 2 refuses.
//
//      Anything else is `kind: "full"`, naming every entry nothing in the subset would look at.
//
//      REMOTE URLS AND REDIRECTS have no (b) and no (c) — no guard in this repo reads those sections —
//      so they must resolve to a real importer or the delta is FULL. JSR ENTRIES have no (c) for the
//      same reason, but they DO have (a) and (b): the std libraries are imported across the suite graph.
//
// THE BOUNDARY, in one line, so it is not re-derived wrongly: SUBSET for attributable
// version/declaration changes; FULL for bytes-only changes and for any ambiguity. Nothing else.
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
 * The DECLARED READERS for a dependency delta — the suites that parse the lockfiles as DATA.
 *
 * Review finding (round 1, gpt-6-sol) proved the single-guard version of this wrong by reading the
 * code: tests/security-dependency-locks.test.ts asserts only the packages in its own advisory/patch
 * TABLES plus advisory floors, and tests/bundle-budget.test.ts separately parses BOTH locks to prove
 * the lock -> shipped-bundle drift guard (lf9xe, im9q8). A JSON file has no import edge, so neither
 * suite is reachable by the selector's graph; they are DECLARED here instead, per file, and their
 * tables are declared below as the only entries they actually inspect.
 */
export const DEPENDENCY_LOCK_GUARDS = Object.freeze([
  "tests/security-dependency-locks.test.ts",
  "tests/bundle-budget.test.ts",
]);

/**
 * The suite that asserts the RELEASE IDENTITY across all three counter surfaces
 * (package.json version == package-lock version == packages[""].version == manifest.version ==
 * manifest.version_name). It is the stamp's real reader - stronger than the changelog guard, which
 * only checks the changelog's newest entry against package.json. Also found by review round 1: it
 * reads all three files by path and appears in no import graph.
 */
export const RELEASE_IDENTITY_GUARD = "tests/first-run-onboarding-composition.test.ts";

/**
 * The ONLY entries an unattributed change can be certified by: those whose version a reader asserts
 * against something other than itself.
 *
 * Coord's ruling on review round 2 stated the standard precisely: "the declared-pin fallback must
 * require that a selected suite actually verifies the CHANGED pin, not merely that the package is
 * declared." Measured against that, exactly two packages qualify:
 *
 *   * fast-uri — tests/security-dependency-locks.test.ts asserts the Deno entries are EXACTLY
 *     [["fast-uri@<npm version>", { integrity: npm.integrity }]] (so npm and deno must agree on both
 *     the version and the hash of the same tarball), and tests/bundle-budget.test.ts proves the
 *     version that actually SHIPPED in the bundle is the locked one (lf9xe);
 *   * @modelcontextprotocol/sdk — the same lock -> shipped drift check (im9q8).
 *
 * The advisory FLOOR tables are deliberately NOT here, and the drift pin in the tests asserts the two
 * sets stay disjoint: `atLeast(version, floor)` bounds a version, it does not verify the one that
 * changed (hono, ip-address, proxy-addr, undici, body-parser). A change to any of those with no repo
 * importer and no imported dependent is FULL, which is the honest answer — nothing in the tree checks
 * it without an install.
 */
export const DECLARED_PIN_READERS = Object.freeze({
  "fast-uri": Object.freeze(["tests/security-dependency-locks.test.ts", "tests/bundle-budget.test.ts"]),
  "@modelcontextprotocol/sdk": Object.freeze(["tests/bundle-budget.test.ts"]),
});

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
    // `version_name` is the manifest's DISPLAY copy of the same counter: scripts/bump-version.mjs
    // writes `manifest.version = next` and `manifest.version_name = next` on every landing (measured
    // on a real --landing stamp, 2026-10-28: a stamp that only listed `version` classified as
    // "field 'version_name' changed" and escalated the landing itself back to the FULL suite).
    const moved = before.version !== after.version || before.version_name !== after.version_name;
    if (!moved) return false;
    delete before.version;
    delete after.version;
    delete before.version_name;
    delete after.version_name;
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
  const bytesOnly = new Set();
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
    if (name) {
      names.add(name);
      // Review round 3: the predicate is "the integrity VALUE changed", not "everything except
      // integrity is equal". A version bump moves the resolved tarball and therefore its hash in the
      // same commit, and that hash is just as unverified as a bare re-pin — nothing in this repo
      // checks lockfile bytes without an install. So a mixed version+hash change is FULL too.
      if (b?.integrity !== t?.integrity) bytesOnly.add(name);
    } else unrecognised.push(`package-lock.json: package entry '${key}' changed and no package name could be read from it`);
  }
  return { names, bytesOnly, unrecognised };
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
  // Entries whose ONLY delta is an integrity/hash value (same version, same dependency edges).
  // chrome-agent-platform-lezl0 review round 2 (coord's ruling): these are NOT subset-certifiable —
  // see the refusal in classifyLockfileDelta.
  const bytesOnly = new Set();
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
    // Review round 3: "any changed integrity value", including when a version moved with it — the
    // stripped-equality test missed exactly that case.
    const hashOnly = Boolean(b && t) && b.integrity !== t.integrity;
    if (b && t) {
      const restBefore = { ...b };
      const restAfter = { ...t };
      delete restBefore.integrity;
      delete restAfter.integrity;
      if (!sameJson(restBefore, restAfter)) integrityOnly = false;
    } else {
      integrityOnly = false;
    }
    // A hash-only change moved no EDGE, but it moved BYTES: review round 1 (finding 3) is right that
    // skipping the name left a same-version/different-hash package with nothing checking it. The name
    // is kept so its importer closure (or its dependents', below) is selected; if nothing resolves it,
    // the delta is refused further down rather than certified on a guard that never reads the pin.
    // Key changes are named; a same-key dependency-edge change still names the package.
    const name = packageNameFromNpmKey(key);
    if (name) {
      resolved.add(name);
      if (hashOnly) bytesOnly.add(name);
    }
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

  // remote: integrity-pinned URLs. Nothing in a subset reads these as data, so every changed URL is
  // edge-required. A VALUE-only change (the same URL re-pinned to a different hash) is still a delta:
  // an earlier revision iterated keys only and so could not see it at all.
  for (const url of new Set([...Object.keys(base.remote ?? {}), ...Object.keys(tip.remote ?? {})])) {
    if ((base.remote ?? {})[url] === (tip.remote ?? {})[url]) continue;
    if (url in (base.remote ?? {}) !== url in (tip.remote ?? {})) integrityOnly = false;
    else bytesOnly.add(url); // same key, new hash: a bytes-only re-pin
    edgeRequired.add(url);
  }

  // redirects: URL -> URL. Same reasoning as remote, including the value-only case.
  for (const url of new Set([...Object.keys(base.redirects ?? {}), ...Object.keys(tip.redirects ?? {})])) {
    if ((base.redirects ?? {})[url] === (tip.redirects ?? {})[url]) continue;
    if (url in (base.redirects ?? {}) !== url in (tip.redirects ?? {})) integrityOnly = false;
    else bytesOnly.add(url);
    edgeRequired.add(url);
  }

  // jsr: package entries, reader-less in this repo (the lock guard reads npm pins only).
  const jsrBefore = base.jsr ?? {};
  const jsrAfter = tip.jsr ?? {};
  for (const key of new Set([...Object.keys(jsrBefore), ...Object.keys(jsrAfter)])) {
    if (sameJson(jsrBefore[key], jsrAfter[key])) continue;
    // Review round 3: any changed integrity value, including alongside a version change (jsr entries
    // carry the same unverified-pin problem as npm ones).
    const hashOnly = Boolean(jsrBefore[key] && jsrAfter[key]) &&
      jsrBefore[key].integrity !== jsrAfter[key].integrity;
    if (jsrBefore[key] && jsrAfter[key]) {
      const restBefore = { ...jsrBefore[key] };
      const restAfter = { ...jsrAfter[key] };
      delete restBefore.integrity;
      delete restAfter.integrity;
      if (!sameJson(restBefore, restAfter)) integrityOnly = false;
    } else {
      integrityOnly = false;
    }
    // Same rule as the npm section: a jsr hash-only change names the package, and because no guard in
    // this repo reads jsr entries the name must resolve to real importers (review round 1, finding 3).
    const name = packageNameFromNpmKey(key);
    if (name) {
      edgeRequired.add(name);
      if (hashOnly) bytesOnly.add(name);
    } else unrecognised.push(`deno.lock: jsr entry '${key}' changed and no package name could be read from it`);
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

  return { resolved, edgeRequired, bytesOnly, unrecognised, integrityOnly };
}

// ── dependency-graph attribution ─────────────────────────────────────────────────────────────
/** Bounded walk: a pathological lock must never expand into the whole graph. */
const MAX_DEPENDENTS = 128;

/**
 * name -> the names that (directly) depend on it, from BOTH sides of the deno.lock and the
 * package-lock's own dependency edges. This is what lets a TRANSITIVE change be attributed to a
 * suite: `@types/node` has no importer, but `ai` does, and the lock says `ai` depends on it.
 */
function lockDependents(...locks) {
  const map = new Map();
  const add = (dependency, dependent) => {
    if (!dependency || !dependent || dependency === dependent) return;
    let set = map.get(dependency);
    if (!set) map.set(dependency, set = new Set());
    set.add(dependent);
  };
  for (const lock of locks) {
    for (const section of [lock?.npm, lock?.jsr]) {
      for (const [key, entry] of Object.entries(section ?? {})) {
        const name = packageNameFromNpmKey(key);
        for (const dependency of entry?.dependencies ?? []) add(packageNameFromSpecifier(dependency), name);
      }
    }
    for (const [key, entry] of Object.entries(lock?.packages ?? {})) {
      const name = key === "" ? null : packageNameFromLockPath(key);
      for (const dependency of Object.keys(entry?.dependencies ?? {})) add(dependency, name);
    }
  }
  return map;
}

/** Every name that transitively depends on `name` (bounded, cycle-safe). */
function dependentsOf(dependents, name) {
  const out = new Set();
  const queue = [name];
  while (queue.length && out.size < MAX_DEPENDENTS) {
    for (const dependent of dependents.get(queue.pop()) ?? []) {
      if (out.has(dependent)) continue;
      out.add(dependent);
      queue.push(dependent);
    }
  }
  return [...out];
}

// ── the verdict ──────────────────────────────────────────────────────────────────────────────
function full(reason, extra = {}) {
  return {
    kind: "full",
    suites: [],
    packages: [],
    importers: {},
    unresolved: [],
    viaDependent: {},
    viaDeclaredReader: {},
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
 *   referrerSuites?: string[],
 *   releaseGuards?: string[],
 *   pinReaders?: Record<string, readonly string[]>,
 * }} [options]
 * @returns {{kind: "subset"|"full", suites: string[], packages: string[], importers: Record<string, string[]>, unresolved: string[], passive: boolean, integrityOnly: boolean, viaDependent: Record<string, string>, viaDeclaredReader: Record<string, string[]>, notes: string[], reason: string}}
 */
export function classifyLockfileDelta(delta = {}, options = {}) {
  const coreSuites = [...(options.coreSuites ?? [])];
  const guards = [...(options.dependencyGuards ?? DEPENDENCY_LOCK_GUARDS)];
  const releaseGuards = [...(options.releaseGuards ?? [RELEASE_IDENTITY_GUARD])];
  const pinReaders = options.pinReaders ?? DECLARED_PIN_READERS;
  // Design amendment (architect, 2026-10-31): the minimum certifying set for an ATTRIBUTABLE delta is
  // enumerable by construction — always-on + the DIRECT READERS the repo can compute (the caller
  // supplies `referrerSuites`: every suite that mentions the changed path, via referrersFor) + the
  // attributed importer closure. The declared readers above are the pinned core of that set; the
  // referrers make it complete for readers nobody wrote down (owed-changelog-ledger, build-tier-inputs,
  // …), which is exactly the class of miss review round 1 caught by hand.
  const referrerSuites = [...new Set(options.referrerSuites ?? [])];
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
  // Entries whose only delta is an integrity/hash value. Review round 2 (coord's ruling): a hash move
  // is NOT certifiable by a subset — nothing in this repo verifies lockfile bytes without an install
  // (deno.runner.jsonc sets "lock": false, and no suite runs `npm ci`), so a green subset would be a
  // claim no suite backs. Bytes-only deltas therefore join parse-level ambiguity in the FULL suite.
  const bytesOnly = new Set();

  if (parsed.packageLock || parsed.packageJson) {
    if (versionOnly.packageLock !== false && versionOnly.packageJson !== false) {
      // Both sides of the unit are pure version stamps (or absent).
    } else {
      if (parsed.packageLock) {
        const shape = packageLockShape(parsed.packageLock.base, parsed.packageLock.tip);
        for (const name of shape.names) resolved.add(name);
        for (const name of shape.bytesOnly) bytesOnly.add(name);
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
    for (const name of shape.bytesOnly) bytesOnly.add(name);
    for (const name of shape.edgeRequired) edgeRequired.add(name);
    unrecognised.push(...shape.unrecognised);
    // `integrityOnly` is a FACT about the delta (only pin hashes moved), not a selection shortcut: the
    // changed entries are still named, so it must not be cancelled by the names now being kept.
    integrityOnly = shape.integrityOnly && !unrecognised.length;
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

  // 3b. THE BYTES-ONLY BOUNDARY (review round 2, coord's ruling). A changed hash is not a changed
  //     version: every suite that reads these files compares versions, presence and advisory floors,
  //     and none of them recomputes or checks a hash value. So a delta whose ONLY movement for an
  //     entry is its integrity/hash value cannot be certified by a subset — the honest answer is the
  //     full suite, which does run the install-dependent checks. This is stated, not implied: the
  //     refusal names the entries, so nobody reads it as parse trouble.
  if (bytesOnly.size) {
    const named = [...bytesOnly].sort().join(", ");
    return full(
      `integrity/hash-only change(s) cannot be certified by a subset: ${named} — no suite verifies ` +
        `lockfile bytes without an install (deno.runner.jsonc sets "lock": false; nothing runs npm ci), ` +
        `so only the full suite covers it. Bump a version, or take the full run.`,
      { unresolved: [...bytesOnly].sort() },
    );
  }

  // 4. A pure version stamp is certified by the always-on set alone (nothing about the dependency
  //    graph, the bundles or the guards moved).
  if (passive) {
    const suites = [...new Set([...coreSuites, ...releaseGuards, ...referrerSuites])].sort();
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
        `certified by always-on (${coreSuites.length}) + release-identity reader (${releaseGuards.length}) + ` +
          `direct readers that name the changed path (${referrerSuites.length})`,
      ],
      reason: "",
    };
  }

  // 5. Attribute every changed entry to something that INSPECTS it. This is the review round-1
  //    correction (findings 2 and 3), and it is the whole safety rule of the module:
  //
  //      an entry is certifiable only if a suite in the selection ACTUALLY LOOKS AT IT,
  //      and there are exactly three ways that happens:
  //        (a) a repo file imports the package -> its reverse-import test closure;
  //        (b) a repo file imports a package that (transitively) DEPENDS on it -> same closure,
  //            which is how a transitive pin (a types-only package, a peer pin) is attributed to the
  //            code that executes its dependents;
  //        (c) a declared reader VERIFIES that exact entry (DECLARED_PIN_READERS) — npm <-> deno
  //            equality or the lock -> shipped drift check. Advisory FLOORS are not verification and
  //            are deliberately not declared.
  //      Anything else is REFUSED, named. The previous version of this module certified an
  //      unattributed entry on the strength of "the guard re-reads the new bytes", which the guard
  //      does not do for arbitrary entries: that claim was not earned, and review was right to fail it.
  const dependencyNames = [...new Set([...resolved])].sort();
  const edgeNames = [...new Set([...edgeRequired])].sort();
  const changedNames = [...new Set([...dependencyNames, ...edgeNames])].sort();
  const dependents = lockDependents(parsed.denoLock?.tip, parsed.denoLock?.base, parsed.packageLock?.tip);

  // Ask the closure about every name AND the packages that depend on it, so (a) and (b) are one call.
  const ask = new Set(changedNames);
  for (const name of changedNames) for (const dependent of dependentsOf(dependents, name)) ask.add(dependent);
  const closure = ask.size ? closureFor([...ask]) : { suites: [], importers: {}, unattributed: [] };
  const importers = closure.importers ?? {};

  const uninspected = [];
  const viaDependent = {};
  const viaDeclaredReader = {};
  for (const name of changedNames) {
    if ((importers[name] ?? []).length) continue; // (a) imported directly
    const dependentWithImporter = dependentsOf(dependents, name).find((dependent) => (importers[dependent] ?? []).length);
    if (dependentWithImporter) { // (b) executed through a dependent
      viaDependent[name] = dependentWithImporter;
      continue;
    }
    // (c) a declared reader inspects this entry — but only for the sections those readers read. No
    // guard in this repo reads deno.lock's remote/jsr/redirects sections, so those must resolve by
    // import edge or be refused.
    const readers = edgeRequired.has(name) ? null : pinReaders[name];
    if (readers?.length) {
      viaDeclaredReader[name] = [...readers];
      continue;
    }
    uninspected.push(name);
  }
  if (uninspected.length) {
    return full(
      `no suite in a subset would inspect these changed entries: ${uninspected.join(", ")} — ` +
        `nothing imports them, nothing that depends on them is imported, and no declared reader ` +
        `(tests/security-dependency-locks.test.ts, tests/bundle-budget.test.ts) verifies that entry; ` +
        `add the suite that does, or run the full suite`,
      { unresolved: uninspected },
    );
  }

  const declaredGuards = guards.filter((guard) => !coreSuites.includes(guard));
  const suites = [...new Set([...coreSuites, ...declaredGuards, ...referrerSuites, ...(closure.suites ?? [])])].sort();
  const notes = [];
  if (referrerSuites.length) {
    notes.push(`direct readers (suites that name the changed path): ${referrerSuites.join(", ")}`);
  }
  if (integrityOnly) {
    notes.push("integrity-only: every dependency edge is unchanged; only pin hashes moved, so the named importers/readers are what re-reads those bytes");
  }
  for (const name of changedNames) {
    const files = importers[name] ?? [];
    if (files.length) {
      notes.push(`${name} -> importers: ${files.join(", ")}`);
      continue;
    }
    if (viaDependent[name]) {
      notes.push(`${name} -> no direct importer -> reached through its dependent ${viaDependent[name]} (importers: ${(importers[viaDependent[name]] ?? []).join(", ")})`);
      continue;
    }
    notes.push(`${name} -> no importer -> inspected by ${viaDeclaredReader[name].join(", ")}`);
  }
  return {
    kind: "subset",
    suites,
    packages: changedNames,
    importers,
    unresolved: [],
    passive: false,
    integrityOnly,
    notes,
    viaDependent,
    viaDeclaredReader,
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
    lines.push(
      `${name} ${scope}: version-counter-only (landing stamp) -> suites: ${suites.length} ` +
        `(always-on + release-identity reader + the direct readers that name the changed path)`,
    );
    return lines;
  }
  for (const note of verdict.notes ?? []) lines.push(`${name} ${scope}: ${note}`);
  lines.push(`${name} ${scope}: ${verdict.packages.length} package(s) -> ${suites.length} suite(s) selected (guard + closure + always-on)`);
  return lines;
}
