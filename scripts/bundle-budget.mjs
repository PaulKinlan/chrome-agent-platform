// scripts/bundle-budget.mjs — the store-target bundle size report + the
// dependency-integrity gate (CAP-FB-20260830-BUNDLE-BUDGET-01).
//
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
// The constitution watches the service-worker bundle (docs/CONSTITUTION.md):
// unmeasured growth once shipped 4.56 MB against a ~2.5 MB note because
// nothing in the build NOTICED when it grew. This module keeps every bundle's
// size measured and reported, and keeps the build FAILING CLOSED on the
// dependency-integrity invariants (one instance per exact package version, no
// lockfile drift, no zod CJS+ESM double-bundling).
//
// OWNER DECISION (Paul, 2026-10-05): "The limits make no sense anymore." A
// bundle exceeding its SIZE ceiling no longer fails the build — the size is
// measured, recorded in extension/dist/dist.complete, and reported loudly
// (with its top contributors) instead of blocking. The integrity invariants
// below still throw. The developer build stays unminified with source maps
// (CAP-FB-20260826-OBSERVABILITY-01).

/** Store-target service-worker budget: 3.0 MB minified. */
export const STORE_SW_BUDGET_BYTES = 3_000_000;

export const STORE_AGGREGATE_CHUNKS_BUDGET_BYTES = 750_000;

/**
 * Store-target reference sizes for EVERY generated bundle (minified bytes),
 * keyed by dist-relative path (chrome-agent-platform-9epn.4, perf audit #5).
 * Ratcheted down to the bead targets in 20e2u with code splitting and
 * shared chunk extraction (sidepanel <=250KB, ntp <=500KB, options <=450KB).
 */
export const STORE_BUNDLE_BUDGETS = Object.freeze({
  "background/service-worker.js": STORE_SW_BUDGET_BYTES,
  "workers/agent-worker.js": 2_000_000,
  "options.bundle.js": 450_000,
  "ntp.bundle.js": 500_000,
  "sidepanel.bundle.js": 250_000,
  "shared/diff-core.bundle.js": 17_000,
  "artifacts.bundle.js": 200_000,
  "artifact.bundle.js": 200_000,
  "directory.bundle.js": 65_000,
  "privacy.bundle.js": 65_000,
  "offscreen.bundle.js": 250_000,
  "user-wasm-store-client.bundle.js": 10_000,
});

/** The bundle outputs the budget report covers (relative to dist/). */
export const BUDGET_REPORTED_BUNDLES = Object.freeze(Object.keys(STORE_BUNDLE_BUDGETS));

/**
 * The top contributor inputs of an esbuild metafile, largest first.
 * Pure and fixture-testable: takes the metafile object, returns
 * [{ input, bytes }] with repo-relative-ish paths as esbuild reports them.
 */
export function topContributors(metafile, limit = 15) {
  const inputs = metafile?.inputs;
  if (!inputs || typeof inputs !== "object") return [];
  return Object.entries(inputs)
    .map(([input, info]) => ({ input, bytes: Number(info?.bytes) || 0 }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, Math.max(1, limit));
}

/** Format the contributor list for the build log / gate failure. */
export function formatContributors(metafile, limit = 15) {
  const rows = topContributors(metafile, limit);
  if (rows.length === 0) return "(no metafile inputs)";
  return rows.map((r) => `  ${String(r.bytes).padStart(9)}  ${r.input}`).join("\n");
}

/**
 * Every Deno-store package instance in a metafile input path:
 * `node_modules/.deno/<name>@<version>[_N]/…`. Scoped packages are stored as
 * `@scope+name`; `_N` is Deno's suffix for a second peer-context instantiation
 * of the SAME exact version. Captures: [1] the store name, [2] the version
 * (suffix included).
 *
 * chrome-agent-platform-9epn.3: this used to match only
 * `ai|zod|@ai-sdk+provider-utils` (the 63et packages), so the build's "one
 * instance per exact version" invariant (docs/CONSTITUTION.md §performance)
 * was silently violated by @modelcontextprotocol/sdk@1.30.0 + _1 and
 * zod-to-json-schema@3.25.2 + _1 both shipping in the service worker. The
 * detector now covers EVERY package.
 */
const DENO_STORE_INSTANCE_RE = /\.deno\/(@?[^/@]+)@([^/]+)\//;

/**
 * chrome-agent-platform-63et (widened by 9epn.3 to every package): group the
 * Deno-store instances in a metafile per package and return only SAME-VERSION
 * peer-context duplicates — the `_N`-suffixed second instantiations of one
 * exact version (the same code bundled twice, ~500KB minified of pure
 * duplication on 2026-09-06; ~175KB pre-minify of SDK on 2026-10-01).
 * DISTINCT versions of a package are legitimate (the providers pin
 * incompatible provider-utils lines; zod majors are an owner-scope decision)
 * and are not flagged. Pure and fixture-testable: takes the metafile object,
 * returns { ["name@version"]: [".deno/name@version", ".deno/name@version_N"]
 * } for duplicated packages only (empty object when clean).
 */
export function duplicateStoreInputs(metafile) {
  const inputs = metafile?.inputs;
  if (!inputs || typeof inputs !== "object") return {};
  const groups = {};
  for (const input of Object.keys(inputs)) {
    const m = input.match(DENO_STORE_INSTANCE_RE);
    if (!m) continue;
    const pkg = m[1].replaceAll("+", "/");
    const base = m[2].replace(/_\d+$/, "");
    (groups[`${pkg}@${base}`] ??= new Set()).add(`.deno/${m[1]}@${m[2]}`);
  }
  const duplicates = {};
  for (const [key, instances] of Object.entries(groups)) {
    if (instances.size > 1) duplicates[key] = [...instances].sort();
  }
  return duplicates;
}

/** The 63et name, kept so existing callers and tests read unchanged — it is
 * the same (now package-wide) detector. */
export const duplicateAiSdkInputs = duplicateStoreInputs;

/**
 * chrome-agent-platform-63et lockfile-drift guard: every dependency input in
 * the bundle must come from the Deno store layout (node_modules/.deno/…)
 * that `deno install` + deno.lock produce. A bare node_modules/… input path
 * means the install state drifted (npm-era leftovers, manual copies) — the
 * exact mis-install that silently produced a 272KB-bloated bundle on
 * 2026-09-06 while the primary checkout measured 2,999,957. Returns the
 * offending input paths, sorted. Pure.
 */
export function nonDenoStoreInputs(metafile) {
  const inputs = metafile?.inputs;
  if (!inputs || typeof inputs !== "object") return [];
  return Object.keys(inputs)
    .filter((p) => p.includes("node_modules/") && !p.includes("node_modules/.deno/"))
    .sort();
}

/**
 * Return any .cjs input paths from zod in the metafile.
 * A CJS entrypoint pulls in CommonJS zod + dozens of locale files that
 * cannot be tree-shaken and duplicates ESM zod (d885.1). Pure.
 */
export function zodCjsInputs(metafile) {
  const inputs = metafile?.inputs;
  if (!inputs || typeof inputs !== "object") return [];
  return Object.keys(inputs)
    .filter((p) => p.includes("zod") && p.endsWith(".cjs"))
    .sort();
}

// The npm lock is NOT the build resolver: esbuild ships the Deno-store copy.
// Inspect both locks and the actual metafile inputs for the fast-uri mismatch
// in lf9xe; also prevent future SDK drift (im9q8's 1.30 report was stale).
const SECURITY_PACKAGES = Object.freeze([
  ["fast-uri", "fast-uri"],
  ["@modelcontextprotocol/sdk", "@modelcontextprotocol+sdk"],
]);

export function securityDependencyDrift(metafile, npmLock, denoLock) {
  const paths = Object.keys(metafile?.inputs ?? {});
  const mismatches = [];
  for (const [name, storeName] of SECURITY_PACKAGES) {
    const prefix = `node_modules/.deno/${storeName}@`;
    const shipped = [...new Set(paths.filter((p) => p.includes(prefix))
      .map((p) => p.split(prefix, 2)[1]?.split("/", 1)[0]?.split("_", 1)[0]))]
      .filter(Boolean).sort();
    if (!shipped.length) continue; // unrelated bundles carry no copy
    const npmVersion = npmLock?.packages?.[`node_modules/${name}`]?.version;
    const denoVersions = [...new Set(Object.keys(denoLock?.npm ?? {})
      .filter((key) => key.startsWith(`${name}@`))
      .map((key) => key.slice(name.length + 1).split("_", 1)[0]))].sort();
    if (!npmVersion || shipped.length !== 1 || shipped[0] !== npmVersion ||
        denoVersions.length !== 1 || denoVersions[0] !== npmVersion) {
      mismatches.push(`${name}: npm=${npmVersion ?? "missing"}; deno=${denoVersions.join(",") || "missing"}; shipped=${shipped.join(",")}`);
    }
    if (name === "fast-uri" && npmVersion && !isPatchedFastUriVersion(npmVersion)) {
      mismatches.push(`fast-uri ${npmVersion}: GHSA-qw65-cvwx-89v3 / GHSA-58mr-gqgx-xq4g require 3.1.7+ on the 3.x line`);
    }
  }
  return mismatches;
}

export function isPatchedFastUriVersion(value) {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+$/.test(value)) return false;
  const [major, minor, patch] = value.split(".").map(Number);
  return major === 3 && (minor > 1 || (minor === 1 && patch >= 7));
}

/** Fail BEFORE esbuild on the ACTUAL SDK -> AJV -> fast-uri dependency path,
 * for BOTH developer and store targets. Store dir presence alone is not proof:
 * AJV may still resolve an older symlink after deno.lock changed (bbz3s). */
export function assertLiveFastUriResolution({ root, sdkDir }) {
  const refuse = (reason) => {
    throw new Error(`cap-security-dependency-resolve: ${reason}. ` +
      "Run `deno install --frozen-lockfile` in this worktree and retry; if the old link remains, recreate this worktree's local .deno store.");
  };
  let npmLock, denoLock;
  try {
    npmLock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
    denoLock = JSON.parse(readFileSync(join(root, "deno.lock"), "utf8"));
  } catch (err) {
    refuse(`cannot read both dependency locks: ${err?.message ?? err}`);
  }
  const fast = npmLock?.packages?.["node_modules/fast-uri"];
  const fastEntries = Object.entries(denoLock?.npm ?? {}).filter(([key]) => key.startsWith("fast-uri@"));
  if (!fast?.version || !fast.integrity || !isPatchedFastUriVersion(fast.version) ||
      fastEntries.length !== 1 || fastEntries[0][0] !== `fast-uri@${fast.version}` ||
      fastEntries[0][1]?.integrity !== fast.integrity) {
    refuse(`fast-uri locks disagree or are not patched (npm=${fast?.version ?? "missing"}; ` +
      `Deno=${fastEntries.map(([key]) => key).join(",") || "missing"})`);
  }
  const sdkVersion = npmLock?.packages?.["node_modules/@modelcontextprotocol/sdk"]?.version;
  const denoSdkVersions = [...new Set(Object.keys(denoLock?.npm ?? {})
    .filter((key) => key.startsWith("@modelcontextprotocol/sdk@"))
    .map((key) => key.slice("@modelcontextprotocol/sdk@".length).split("_", 1)[0]))];
  let sdk, ajvPath, ajvImporter, fastPath, actualPath, actual;
  try {
    sdk = JSON.parse(readFileSync(join(sdkDir, "package.json"), "utf8"));
    ajvPath = createRequire(join(sdkDir, "package.json")).resolve("ajv/package.json");
    // Ajv imports fast-uri from dist/runtime/uri.js. Resolve FROM THAT FILE,
    // not package.json: a nested node_modules shadow would otherwise pass.
    ajvImporter = join(dirname(ajvPath), "dist", "runtime", "uri.js");
    const importerSource = readFileSync(ajvImporter, "utf8");
    if (!/\brequire\(["']fast-uri["']\)|\bfrom\s+["']fast-uri["']/.test(importerSource)) {
      refuse(`AJV URI importer ${ajvImporter} no longer imports fast-uri; review the new resolution path`);
    }
    fastPath = createRequire(ajvImporter).resolve("fast-uri/package.json");
    actualPath = realpathSync(fastPath);
    actual = JSON.parse(readFileSync(actualPath, "utf8"));
  } catch (err) {
    if (err?.message?.startsWith("cap-security-dependency-resolve:")) throw err;
    refuse(`SDK -> AJV -> fast-uri cannot resolve from ${sdkDir}: ${err?.message ?? err}`);
  }
  if (!sdkVersion || denoSdkVersions.length !== 1 || denoSdkVersions[0] !== sdkVersion || sdk?.version !== sdkVersion) {
    refuse(`MCP SDK lock vs selected Deno-store instance disagrees (npm=${sdkVersion ?? "missing"}; ` +
      `Deno=${denoSdkVersions.join(",") || "missing"}; live=${sdk?.version ?? "missing"} at ${sdkDir})`);
  }
  const expectedPath = join(root, "node_modules", ".deno", `fast-uri@${fast.version}`, "node_modules", "fast-uri", "package.json");
  if (actual?.version !== fast.version || actualPath !== expectedPath) {
    refuse(`AJV (${ajvImporter}) resolves fast-uri ${actual?.version ?? "missing"} at ${actualPath}; ` +
      `npm and Deno locks require fast-uri ${fast.version} at ${expectedPath}`);
  }
  return { version: actual.version, path: actualPath, ajvPath };
}

/** If <root>/node_modules resolves through a symlink, say so in the error —
 * dependency-root layout changes measured bytes (a symlinked root measured
 * 688 bytes over budget with source unchanged, chrome-agent-platform-2eb5),
 * and the environmental-vs-product distinction should cost zero gate runs. */
function dependencyRootNote(root) {
  try {
    const nm = `${root}/node_modules`;
    if (lstatSync(nm).isSymbolicLink()) {
      return `\nNOTE: ${nm} is a SYMLINK → ${readlinkSync(nm)}. Dependency-root layout changes the measured bundle (688 bytes observed with source unchanged) — verify with a real node_modules before treating this as product growth.`;
    }
  } catch { /* no node_modules here — nothing to say */ }
  return "";
}

/**
 * The over-reference REPORT (owner decision Paul, 2026-10-05: reported, not
 * enforced): names the bundle, the actual size, the reference size and the
 * top contributors (when a metafile is available). Pure — returns the text;
 * the caller decides where it prints. An under-reference call returns "".
 */
export function bundleBudgetReport({ label, bytes, budgetBytes = STORE_SW_BUDGET_BYTES, metafile = null, root = process.cwd() }) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size < 0 || size <= budgetBytes) return "";
  return `bundle budget report: ${label} is ${size} bytes; the store reference size is ${budgetBytes} — OVER by ${size - budgetBytes} bytes (reported, not enforced; owner decision 2026-10-05).\n` +
    `Top contributors:\n${formatContributors(metafile)}` +
    dependencyRootNote(root);
}

/**
 * The build-time check (build.mjs): FAILS CLOSED on an unmeasurable size and
 * on the dependency-integrity invariants (one instance per exact package
 * version, no lockfile drift, no zod CJS double-bundling — 63et / 9epn.3),
 * and RETURNS the measured size otherwise. The SIZE itself is not fatal
 * (owner decision Paul, 2026-10-05) — the caller reports an over-reference
 * bundle via bundleBudgetReport; the bytes still land in dist.complete.
 */
export function assertBundleBudget({ label, bytes, budgetBytes = STORE_SW_BUDGET_BYTES, metafile = null, root = process.cwd() }) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size < 0) {
    throw new Error(`bundle budget: ${label} size is not measurable (${bytes})`);
  }
  if (metafile) {
    // chrome-agent-platform-63et fail-closed guards (9epn.3: the duplicate
    // guard covers EVERY package): a duplicated same-version Deno-store
    // instance or a drifted (non-Deno-store) dependency input must fail the
    // build even when the byte total still fits the budget — a mis-install
    // silently changed the shipped bundle once already, and a second
    // @modelcontextprotocol/sdk@1.30.0 shipped for weeks under a guard that
    // only watched three packages.
    const duplicates = duplicateStoreInputs(metafile);
    if (Object.keys(duplicates).length) {
      throw new Error(
        `bundle budget: duplicated same-version package instances in ${label} — ` +
        Object.entries(duplicates)
          .map(([pkg, instances]) => `${pkg}: ${instances.join(", ")}`)
          .join("; ") +
        `\nOne instance per exact version is the build invariant (distinct versions are fine); the cap-ai-sdk-dedup plugin in build.mjs owns the fix.`,
      );
    }
    const drifted = nonDenoStoreInputs(metafile);
    if (drifted.length) {
      throw new Error(
        `bundle budget: non-Deno-store dependency inputs in ${label} (lockfile drift — run deno install; an npm-era install silently changes the shipped bundle):\n` +
        drifted.map((p) => `  ${p}`).join("\n"),
      );
    }
    // A Deno-store input can still carry a vulnerable VERSION even though
    // nonDenoStoreInputs() passes. Only inspect bundles that ship these deps.
    if (Object.keys(metafile.inputs ?? {}).some((p) => SECURITY_PACKAGES.some(([, store]) =>
      p.includes(`node_modules/.deno/${store}@`)))) {
      const npmLock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
      const denoLock = JSON.parse(readFileSync(join(root, "deno.lock"), "utf8"));
      const mismatches = securityDependencyDrift(metafile, npmLock, denoLock);
      if (mismatches.length) {
        throw new Error(`bundle budget: security dependency lock-to-shipped drift in ${label}:\n${mismatches.join("\n")}`);
      }
    }
    const cjsZod = zodCjsInputs(metafile);
    if (cjsZod.length) {
      throw new Error(
        `bundle budget: .cjs inputs from zod in ${label} (CJS+ESM double-bundling — CANON_ZOD_V4 in build.mjs must resolve to ESM .js):\n` +
        cjsZod.map((p) => `  ${p}`).join("\n"),
      );
    }
  }
  // SIZE IS NOT FATAL HERE (owner decision Paul, 2026-10-05): an
  // over-reference bundle is REPORTED by the caller via bundleBudgetReport
  // and its bytes still land in dist/dist.complete. Nothing below depends on
  // budgetBytes — the parameter stays so the call sites (and their pins) keep
  // one shape for integrity + reporting.
  return size;
}
