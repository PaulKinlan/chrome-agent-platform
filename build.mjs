// Build the MV3 service worker + options bundle with esbuild, publish ONE
// complete dist/ directory as a serialized transaction:
//   - an owner-token lock created ATOMICALLY (O_EXCL + payload written via a
//     single rename of a fully-written temp file — no empty-lock window);
//   - no age-based stealing of LIVE builds: a lock is stolen ONLY if the
//     recorded PID is provably dead (process.kill(pid,0) → ESRCH); a stuck
//     LIVE build surfaces a clear error instead of being stolen;
//   - the publish never leaves dist ABSENT for repository consumers: the new
//     tree is fully staged, then a dist.complete marker rename-order guarantees
//     readers treat dist as valid ONLY while the marker exists (the swap moves
//     the OLD tree away and immediately renames the new one in; between those
//     two renames the dist.complete marker is absent, so lock-respecting
//     readers wait — documented + enforced by build:wait-for-dist);
//   - per-FILE modes preserved from the previous tree; failures roll back and
//     ROLLBACK FAILURE IS FATAL; every failure path cleans its staging.
import { build, transform } from "esbuild";
import { browserDependencies, browserProcessEnvOptions } from './scripts/browser-dependencies.mjs';
import { createRequire } from "node:module";
import { readFile, writeFile, rename, mkdir, rm, readdir, stat, lstat, chmod, utimes, symlink, readlink, copyFile } from "node:fs/promises";
import path, { join, extname } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { boundedChildTimeoutMs, runBoundedChild } from "./scripts/lib/bounded-child.mjs";
import { syncGallery } from "./scripts/sync-gallery.mjs";
import { syncChangelog } from "./scripts/sync-changelog.mjs";
import { syncAboutPage } from "./scripts/generate-about-page.mjs";
import {
  computeIndexedSourceAuthority,
  validateDistCompleteMarker,
  writeDistCompleteMarker,
} from "./scripts/dist-complete.mjs";
import {
  deltaBetween,
  parseChangelog,
  readChangelogOrNull,
  readLastBuiltVersion,
  renderDelta,
  shouldRecordBuild,
  writeLastBuiltVersion,
  DEFAULT_BUILT_VERSION_PATH,
} from "./scripts/changelog-delta.mjs";

function parseBuildTarget(args) {
  if (!Array.isArray(args) || args.length > 1) {
    throw new Error("usage: node build.mjs [--target=developer|store] [--regen-tools]");
  }
  // DEFAULT is the DEBUG (developer) build: sourcemaps + verbose logging by
  // default, so `npm run build` gives the owner diagnosable traces. The Store
  // bundle is the explicit `--target=store` (`npm run build:production`).
  // Identical security assertions run in BOTH modes — the mode flips ONLY
  // sourcemap emission and the default log verbosity.
  if (args.length === 0 || args[0] === "--target=developer") return "developer";
  if (args[0] === "--target=store") return "store";
  if (args[0] === "--target=enterprise") {
    throw new Error("target_enterprise_not_enabled");
  }
  throw new Error(`unsupported build target argument: ${args[0]}`);
}

// --regen-tools is the EXPLICIT opt-in to fully regenerate the bundled Wasm
// tool packages; the default build only VERIFIES them (see below).
const RAW_ARGS = process.argv.slice(2);
const REGEN_TOOLS = RAW_ARGS.includes("--regen-tools");
const BUILD_TARGET = parseBuildTarget(RAW_ARGS.filter((a) => a !== "--regen-tools"));
const ROOT = fileURLToPath(new URL(".", import.meta.url));
const EXT_DIR = path.join(ROOT, "extension");
const DIST = path.join(EXT_DIR, "dist");
const COMPLETE_MARKER = path.join(DIST, "dist.complete");
// Owner-requested build output: the changelog delta since the LAST SUCCESSFUL
// build. The record lives in .build/ (gitignored, invocation-local, outside
// dist and dist-versions — never shipped, never in the indexed-source scan,
// and it survives the dist-versions GC by design). Never fails the build:
// every read/parse error degrades to a one-line warning.
const BUILT_VERSION_PATH = path.join(ROOT, DEFAULT_BUILT_VERSION_PATH);

// Windows: directory rename-over-existing is unreliable (EBUSY/EPERM with
// AV/indexers). Fail CLEARLY rather than half-publish.
if (process.platform === "win32") {
  throw new Error("atomic directory publish is not supported on Windows in this build — publish from WSL/Linux/CI");
}

// Bundled-tool truthfulness gate: the shipped Wasm tool packages are GENERATED
// artifacts. The default build runs the generator in --verify mode and FAILS
// CLOSED on any drift (hand edit, stale bytes, ungenerated file), so
// `npm run build` truthfully bundles the exact pinned tools. Full regeneration
// never happens implicitly — only via the explicit --regen-tools flag.
// BOUNDED (chrome-agent-platform-fnmr): the generator can block in a futex wait
// and never exit, and an unbounded execFileSync here wedged a worktree's build
// for 3h37m. The bound names the hang instead and takes the group down.
try {
  const generator = await runBoundedChild(process.execPath, [
    // --report-on-signal: a NON-futex hang (epoll/pipe) writes a full diagnostic report on SIGUSR2,
    // which scripts/lib/bounded-child.mjs sends before it kills. A futex-blocked child cannot write
    // one (measured), so the helper also samples per-thread wchan — see its comment (fnmr).
    "--report-on-signal",
    "--report-signal=SIGUSR2",
    path.join(ROOT, "scripts/build-bundled-tool-packages.mjs"),
    ...(REGEN_TOOLS ? [] : ["--verify"]),
  ], {
    cwd: ROOT,
    stdio: "inherit",
    label: "bundled-tool generator",
    timeoutMs: boundedChildTimeoutMs(process.env, "CAP_BUNDLED_TOOL_TIMEOUT_MS"),
  });
  if (generator.status !== 0) {
    // execFileSync used to throw here; the bounded runner reports the status
    // instead, so the fail-closed contract has to be explicit.
    console.error(`\nbuild: bundled-tool generator failed (status ${generator.status})`);
    process.exit(1);
  }
} catch (error) {
  console.error(`\nbuild: ${error?.message ?? error}`);
  process.exit(1);
}

// SECURITY/build assertion: TEST-ONLY controls/oracles must never reach the
// shipped extension. RECURSIVELY discover every shipped .js under extension/,
// then scan each with a REAL JavaScript parser (acorn):
//   (a) a case-insensitive substring check for the known fault-seam/oracle names,
//   (b) an AST export walk (declarations, export lists, `x as __y` aliases, and
//       `export default <__id>`), and
//   (c) an AST MemberExpression walk for `window|self|globalThis.__*` access
//       (excluding legitimate __zod_*/__vite_* library internals).
async function walkJs(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    // generated artifacts (dist pointer/version trees/archives) are not shipped SOURCE
    if (entry.isDirectory() && (entry.name === 'dist' || entry.name === 'dist-versions' || entry.name === 'dist-archives' || entry.name.startsWith('.'))) continue;
    if (entry.isDirectory()) await walkJs(p, out);
    else if (entry.isFile() && (extname(p) === ".js" || extname(p) === ".mjs")) out.push(p);
  }
  return out;
}
async function walkWasm(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory() && (entry.name === 'dist' || entry.name === 'dist-versions' || entry.name === 'dist-archives' || entry.name.startsWith('.'))) continue;
    if (entry.isDirectory()) await walkWasm(p, out);
    else if (entry.isFile() && extname(p) === ".wasm") out.push(p);
  }
  return out;
}
const { scanShippedJs, scanBundledWasmFiles } = await import("./scripts/scan-shipped.mjs");
const { BUNDLED_INVENTORY: BUNDLED_INVENTORY_EARLY } = await import("./extension/lib/bundled-inventory-data.js");
const shippedJsAll = await walkJs("extension");
// ltkj.2: JS members of the package store (extension/wasm/runtime/**) are
// generated data, not authored shipped code — the same contract as the
// vendored pyodide lane, except the pin is the BUNDLED_INVENTORY digest rather
// than a hardcoded hash. Exemption is content-addressed: a file is exempt ONLY
// while its bytes hash-match its inventory row, so a drifted or undeclared
// file stays inside the AST scan and fails closed.
const packageStoreExempt = new Set();
// walkJs returns RELATIVE paths ("extension/wasm/..."), so the exemption set
// keys on the same rel form — join(ROOT, …) is only used to READ the bytes.
for (const row of BUNDLED_INVENTORY_EARLY.files) {
  if (!/^extension\/wasm\/.+\.m?js$/.test(row.rel)) continue;
  let bytes;
  try {
    bytes = await readFile(join(ROOT, row.rel));
  } catch {
    continue; // absent file is not this scan's problem (walkJs only saw present files)
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (row.sha256 === digest) packageStoreExempt.add(row.rel);
}
// Schema-2 runtime data assets (roles adapter/glue/pthread-bootstrap/data)
// are MANIFEST members, not inventory file rows: their pin is the asset
// sha256 inside a manifest whose own digest is tied to the inventory row
// (assertManifestRowDigest). Same contract — exemption only on exact byte
// match; drifted/undeclared files stay inside the AST scan and fail closed.
const { manifestCasMappings: mapSchemas, assertManifestRowDigest: tieRow } =
  await import("./scripts/lib/wasm-manifest-assets.mjs");
for (const identity of BUNDLED_INVENTORY_EARLY.manifests) {
  const manifestRel = `extension/wasm/manifests/${identity.pkg}-${identity.version}.manifest.json`;
  const manifestText = await readFile(join(ROOT, manifestRel), "utf8");
  tieRow(manifestText, identity);
  const manifest = JSON.parse(manifestText);
  if (manifest?.schemaVersion !== 2) continue;
  mapSchemas(manifest); // validation side effect: roles/paths/CAS invariants
  for (const asset of manifest.assets ?? []) {
    if (!/^extension\/wasm\/.+\.m?js$/.test(asset?.path ?? "")) continue;
    let bytes;
    try {
      bytes = await readFile(join(ROOT, asset.path));
    } catch {
      continue;
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (asset.sha256 === digest) packageStoreExempt.add(asset.path);
  }
}
const shippedJs = shippedJsAll.filter((file) => !packageStoreExempt.has(file));
if (packageStoreExempt.size > 0) {
  console.log(`shipped-code scan: ${packageStoreExempt.size} package-store JS asset(s) verified by inventory digest pin (not AST-scanned)`);
}
// The __zod_*/__vite_* oracle exemption applies ONLY inside the generated
// dependency bundles (esbuild inlines the zod/vite source there) — never in
// shipped source files.
const violations = await scanShippedJs(shippedJs, {
  generatedBundles: new Set([path.join(ROOT, "extension", "dist", "background", "service-worker.js"), path.join(ROOT, "extension", "dist", "options.bundle.js"), path.join(ROOT, "extension", "dist", "shared", "diff-core.bundle.js")]),
  // NOTE: the execution-host exemption is NOT caller-supplied — the scanner
  // owns the fixed canonical path + the exact allowed call shape.
  allowedDynamicEvaluatorFiles: new Set([
    "extension/sandbox/script-sandbox.js",
  ]),
  readText: (f) => readFile(f, "utf8"),
});
if (violations.length > 0) {
  throw new Error(
    `shipped-code scan failed (${violations.length} violation(s)):\n` +
    violations.map((v) => `  - ${v}`).join("\n"),
  );
}
console.log(`build assertion: no test controls/oracles in ${shippedJs.length} shipped JS files (AST export + oracle walk)`);

// Reachability gate (CAP-FB-20260830-DEAD-CODE-CUT-01): every shipped source
// file under extension/ must be reached from a manifest entry point, an esbuild
// entry below, or a RETAINED root with a reason — an unreferenced file fails
// the build before anything is bundled (scripts/check-reachability.mjs).
const { runNode: checkReachability } = await import("./scripts/check-reachability.mjs");
await checkReachability({ root: ROOT });

// Bundled-lane Wasm ships inventory-only: every content-addressed binary
// under extension/wasm/cas/ is mapped to its exact manifest executable via
// the generated bundled inventory (extension/lib/bundled-inventory-data.js).
// A binary with no exact manifest mapping still fails the build closed.
const shippedWasm = await walkWasm("extension");
const { BUNDLED_INVENTORY } = await import("./extension/lib/bundled-inventory-data.js");
// Single schema-aware manifest→CAS mapping (ltkj.2): the same helper serves the
// generator, this scan and the Store archive map — one rule, not three parsers.
// Inventory-row digest drift fails closed before any mapping is trusted.
const { manifestCasMappings, assertManifestRowDigest } = await import("./scripts/lib/wasm-manifest-assets.mjs");
const manifestByFile = new Map();
for (const identity of BUNDLED_INVENTORY.manifests) {
  const manifestRel = `extension/wasm/manifests/${identity.pkg}-${identity.version}.manifest.json`;
  const manifestText = await readFile(join(ROOT, manifestRel), "utf8");
  assertManifestRowDigest(manifestText, identity);
  const manifest = JSON.parse(manifestText);
  for (const { casRel, schemaVersion, executable, asset } of manifestCasMappings(manifest)) {
    if (manifestByFile.has(casRel)) throw new Error(`bundled-Wasm manifest collision: ${casRel}`);
    manifestByFile.set(casRel, schemaVersion === 2 ? { schemaVersion: 2, asset } : executable);
  }
}
const wasmViolations = await scanBundledWasmFiles(shippedWasm, {
  readBytes: (file) => readFile(file),
  manifestByFile,
});
if (wasmViolations.length > 0) {
  throw new Error(`bundled-Wasm scan failed (${wasmViolations.length} violation(s)):\n${wasmViolations.map((value) => `  - ${value}`).join("\n")}`);
}
console.log(`build assertion: ${shippedWasm.length} bundled Wasm binaries; exact manifest + bounded raw scan required`);

// Sync the design-system source into the docs/ component gallery (single
// source of truth = extension/shared/; see scripts/sync-gallery.mjs). The
// docs/ source copies are committed so the GitHub Pages showcase works
// standalone; the generated *.bundle.js is BUILD OUTPUT (gitignored) and is
// regenerated here on every build.
await syncGallery();
// CHANGELOG.md is canonical and tracked; extension/CHANGELOG.md is an ignored
// generated package file. A clean git archive therefore needs the production
// build to materialize and verify it before the extension is copied/loaded.
await syncChangelog({ check: false });
await syncChangelog({ check: true });
// Generated About page from the bundled tool inventory. The build materializes
// and verifies it ({check: false} writes, then {check: true} asserts write integrity).
// Note: because the previous line regenerates it, build.mjs cannot catch uncommitted
// source drift on its own — the real drift gate is `npm run check:about` (chained in
// test:all and evidence-runner.sh) plus tests/about-page-drift-guard.test.ts.
await syncAboutPage({ check: false });
await syncAboutPage({ check: true });

// ── DIRECTORY lock (owner-atomic by construction) ────────────────────────────
// The lock dir is CREATED FULLY-POPULATED off-path, then renamed INTO place —
// rename(2) of a directory is atomic, so the lock NEVER exists without its
// owner.json (no ownerless window). Owner identity = pid + /proc start ticks +
// the MACHINE BOOT ID (fences PID+starttime reuse across reboots). Steal:
// provably dead (ESRCH) or identity mismatch (start/boot). Removal is
// race-free via token-specific QUARANTINE: the stealer renames the dead lock
// dir to a unique quarantine name FIRST (rename is atomic — exactly one
// contender can succeed), then removes the quarantined dir; a successor's
// fresh lock (a different directory inode) can never be deleted.
// Liveness (including the zombie hole this lock used to have) and acquisition live in
// scripts/lib/build-lock.mjs, extracted so the steal decision is testable against a REAL zombie
// holder rather than only through a full build (chrome-agent-platform-r0v8). Read that module for
// why a zombie satisfied every check the old inline version had.
import { acquireBuildLock, buildOwnerIdentity, LOCK_DIRNAME } from "./scripts/lib/build-lock.mjs";
const LOCK_DIR = path.join(ROOT, LOCK_DIRNAME);
const OWNER = buildOwnerIdentity();
// Acquire the lock, stealing ONLY a provably-dead holder: the bounded refusal, the race-free
// token-specific quarantine and the stale-temp sweep all live in the module above. A zombie holder
// (state Z) or a vanished /proc entry is now dead, which is the r0v8 fix.
await acquireBuildLock({ root: ROOT, lockDir: LOCK_DIR, owner: OWNER });

// Module-scope state for the owner-requested build changelog delta: the
// version probe runs inside the try below, but the record write happens AFTER
// the outer finally (the final fatal step), so the variables are hoisted here.
let previousBuiltVersion = null;
let currentVersion = null;
let currentChangelog = null;
// Set true only after the dist.complete marker validated + the publish
// completed; the version record runs AFTER every fatal finalizer (see
// shouldRecordBuild) so a late death never records a success.
let buildSucceeded = false;
let storeBuildRecord = null;

try {
  // Snapshot the previous successful build version + the current package
  // version BEFORE the build so the delta can be printed on success.
  // Fail-safe: unreadable/missing record or malformed changelog → warn +
  // continue (this feature must never fail the build).
  try {
    previousBuiltVersion = await readLastBuiltVersion(BUILT_VERSION_PATH);
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
    currentVersion = typeof pkg?.version === "string" ? pkg.version : null;
    currentChangelog = await readChangelogOrNull({
      read: () => readFile(path.join(ROOT, "CHANGELOG.md"), "utf8"),
      warn: (msg) => console.error(msg),
    });
  } catch (e) {
    // warn-only; the build must never fail over this feature
    console.error(`warning: build changelog probe failed (${e?.message ?? e}) — skipping the build changelog delta`);
  }

  // Staging: private, same-filesystem, fully built BEFORE any dist mutation.
  const STAGE = path.join(EXT_DIR, `.dist-stage-${process.pid}-${Date.now()}`);
  await rm(STAGE, { recursive: true, force: true });
  try {
    if (process.env.CAP_TEST_SEAM === "1") {
      throw new Error("CAP_TEST_SEAM=1 is not allowed for the production build");
    }

    // Bind the build to a stable indexed-source snapshot. The marker is
    // recomputed after bundling and the build fails if source bytes changed
    // while esbuild was running.
    const sourceBefore = await computeIndexedSourceAuthority({ root: ROOT });

    // Build MODE (developer = debug / store = production). The mode flips
    // exactly two things: external sourcemaps (debug only) and the default
    // log verbosity injected as __CAP_BUILD_LOG_DEFAULT__ (cap-log.js reads
    // it; the owner's explicit storage choice always wins). NOTHING below
    // relaxes any security assertion — the bundled-tool verify gate, seam
    // scan, no-new-Function scrub, oracle/test-control AST scan and the
    // dist.complete marker authority run identically in both modes.
    const DEBUG_BUILD = BUILD_TARGET === "developer";
    // components.js / lib/artifacts.js import the diff core by its DIST path (so
    // the unbundled extension pages resolve it at runtime); when esbuild bundles
    // ANY entry (the SW, the options page, the agent worker) it must inline the
    // SOURCE wrapper instead, so a clean checkout builds without a stale/absent
    // dist and no bundle depends on build order
    // (CAP-FB-20260830-ARTIFACT-DIFF-COMPONENT-01, PATCH-ASSET-TOOL-01).
    const diffCoreFromSource = {
      name: "cap-diff-core-from-source",
      setup(b) {
        b.onResolve({ filter: /dist\/shared\/diff-core\.bundle\.js$/ }, () => ({ path: path.join(EXT_DIR, "shared/diff-core.js") }));
      },
    };
    // chrome-agent-platform-63et: keep ONE AI SDK stack in the SW bundle.
    // Root cause of the duplication (verified 2026-09-06): Deno PEER-CONTEXT
    // instances — the extension root resolves ai@7.0.66 in a zod@3.25.76
    // context while agent-do@0.7.0 hard-depends zod ^4.4.3, so installs can
    // carry `_N`-suffixed second store instances (ai@7.0.66_1,
    // provider-utils@5.0.27_1) that esbuild then bundles twice.
    //
    // Four mechanisms, all live-resolved and fail-closed:
    // 1. ai imports resolve importer-anchored with any `_N` store suffix
    //    stripped — same-version peer duplicates collapse onto one instance.
    // 2. @ai-sdk/provider-utils is pinned to ONE line (5.0.27, anthropic's
    //    context) for every importer. 5.0.33 (google's context) lacks
    //    stream-error exports anthropic needs; 5.0.27 satisfies google's
    //    imports too — esbuild's export check enforces this at build time.
    //    (A blanket alias to 5.0.33 was tried first and hard-errored.)
    // 3. agent-do's bare zod imports resolve to the full v4 implementation
    //    shipped inside zod@3 (zod/v4 — its verified-compatible runtime
    //    subset), so the zod@4.4.3 major does not ship for agent-do.
    // 4. (chrome-agent-platform-9epn.3) every @modelcontextprotocol/sdk import
    //    is pinned to the ONE store instance whose zod peer is that same zod@3
    //    line — agent-do's MCP client used to pull a second SDK@1.30.0 (`_1`,
    //    zod@4 context) and with it zod-to-json-schema twice and all of zod@4.
    // The metafile-side same-version duplicate guard (EVERY package since
    // 9epn.3) + lockfile-drift guard in scripts/bundle-budget.mjs
    // (assertBundleBudget) are the tripwires.
    // chrome-agent-platform-bd06: check the .deno store if we need a fallback SDK
    const denoStoreDir = path.join(ROOT, "node_modules", ".deno");
    let denoEntries = [];
    try {
      denoEntries = readdirSync(denoStoreDir);
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
    }
    const requireFromRoot = createRequire(path.join(ROOT, "package.json"));
    function resolveCanonical(spec, opts, what) {
      try {
        return requireFromRoot.resolve(spec, opts);
      } catch (err) {
        throw new Error(
          `cap-ai-sdk-dedup: cannot resolve the canonical ${what} (${spec}) in this install — ${err?.message || err}. ` +
          `Run npm install/deno install and retry; the build refuses to bundle duplicated AI SDK instances.`,
        );
      }
    }
    // Collapse a Deno peer-context duplicate: resolve from the IMPORTER's own
    // context, then strip the `_N` store suffix so both instances load from
    // the one canonical .deno directory. A no-op when no suffix exists.
    function collapsePeerContextDuplicate(a) {
      const resolved = requireFromRoot.resolve(a.path, { paths: [path.dirname(a.importer)] });
      return { path: resolved.replace(/(\.deno\/[^/@]+@[0-9][^/]*)_\d+\//, "$1/") };
    }
    const CANON_ANTHROPIC = resolveCanonical("@ai-sdk/anthropic", { paths: [ROOT] }, "@ai-sdk/anthropic (root context)");
    const CANON_PU = resolveCanonical(
      "@ai-sdk/provider-utils",
      { paths: [path.dirname(CANON_ANTHROPIC)] },
      "@ai-sdk/provider-utils@5.0.27 (the anthropic provider context)",
    );
    const CANON_ZOD_V4 = resolveCanonical(
      "zod/v4",
      { paths: [ROOT] },
      "zod/v4 (the v4 implementation shipped inside zod@3)",
    ).replace(/\.cjs$/, ".js");
    // chrome-agent-platform-63et: @modelcontextprotocol/sdk is a Deno-store
    // package (package.json pins 1.31.0; agent-do also depends on it). Deno
    // instantiates it ONCE PER PEER CONTEXT: the root context binds zod@3.25.76
    // (`@modelcontextprotocol+sdk@1.31.0`), agent-do's context binds zod@4.4.3
    // (`…@1.31.0_1`). Without a pin esbuild bundled BOTH — the same SDK
    // version twice, plus zod-to-json-schema twice and the whole zod@4 major
    // behind the second copy (chrome-agent-platform-9epn.3, 2026-10-01 audit;
    // upgraded to 1.31.0 for GHSA-6qxp-vccf-f47h in chrome-agent-platform-1grt).
    //
    // The canonical instance is chosen by its ZOD PEER.
    // Live-resolved and fail-closed: no matching instance, no build.
    const CANON_ZOD_DIR = realpathSync(path.join(ROOT, "node_modules", "zod"));

    let CANON_MCP_SDK_DIR = null;
    let mcpZodPeer = null;

    try {
      CANON_MCP_SDK_DIR = realpathSync(path.join(ROOT, "node_modules", "@modelcontextprotocol", "sdk"));
      const mcpSdkPkgPath = path.join(CANON_MCP_SDK_DIR, "package.json");
      const mcpSdkReq = createRequire(mcpSdkPkgPath);
      mcpZodPeer = realpathSync(mcpSdkReq.resolve("zod/package.json").replace(/\/package\.json$/, ""));
    } catch {}

    if (mcpZodPeer !== CANON_ZOD_DIR) {
      const candidates = denoEntries.filter((d) => d.startsWith("@modelcontextprotocol+sdk@"));
      let matchingEntry = null;
      for (const entry of candidates) {
        try {
          const pkgPath = path.join(denoStoreDir, entry, "node_modules", "@modelcontextprotocol", "sdk", "package.json");
          const entryZodPeer = realpathSync(createRequire(pkgPath).resolve("zod/package.json").replace(/\/package\.json$/, ""));
          if (entryZodPeer === CANON_ZOD_DIR) {
            matchingEntry = entry;
            CANON_MCP_SDK_DIR = realpathSync(path.dirname(pkgPath));
            mcpZodPeer = entryZodPeer;
            break;
          }
        } catch { }
      }

      if (!matchingEntry) {
        throw new Error(
          `cap-ai-sdk-dedup: no @modelcontextprotocol/sdk instance is bound to the extension's zod (${CANON_ZOD_DIR}). ` +
          `The SDK must share one zod with lib/mcp-client.js and agent-do; run deno install and retry.`
        );
      }
    }
    // Marker for the re-entrant resolve below: esbuild hands pluginData back
    // to onResolve, so the pin can tell its own lookup from an importer's.
    const MCP_SDK_PIN = "cap-mcp-sdk-pin";

    const isStoreBuild = BUILD_TARGET === "store";
    const GATEWAY_STUB = path.join(ROOT, "scripts/stubs/gateway-stub.mjs");
    const OIDC_STUB = path.join(ROOT, "scripts/stubs/vercel-oidc-stub.mjs");
    const capAiSdkDedup = {
      name: "cap-ai-sdk-dedup",
      setup(b) {
        b.onResolve({ filter: /^ai$/ }, collapsePeerContextDuplicate);
        b.onResolve({ filter: /^@ai-sdk\/provider-utils$/ }, () => {
          // ONE line for all comers: 5.0.27 (anthropic's context) — 5.0.33
          // lacks exports anthropic needs. If google's imports were missing
          // here, esbuild fails the build loudly and we go back to two
          // instances.
          return { path: CANON_PU };
        });

        // Only agent-do is redirected to zod/v4: it is the importer whose
        // peer context expects zod ^4. Every other zod import in the graph
        // already means zod@3 — leaving them alone preserves exactly the
        // semantics each importer compiled against.
        b.onResolve({ filter: /^zod$/ }, (a) => (a.importer.includes("/agent-do") ? { path: CANON_ZOD_V4 } : undefined));

        // 4. (9epn.3) Every `@modelcontextprotocol/sdk[/subpath]` import —
        //    lib/mcp-client.js's AND agent-do's — resolves from the canonical
        //    instance's own directory, so the SDK's exports map still picks
        //    the browser/ESM `.js` subpaths natively and its internal
        //    `zod` / `zod-to-json-schema` edges land on the canonical peers.
        //    A result outside that instance is a build error, never a silent
        //    second copy.
        b.onResolve({ filter: /^@modelcontextprotocol\/sdk(\/|$)/ }, async (a) => {
          if (a.pluginData === MCP_SDK_PIN) return undefined;
          const r = await b.resolve(a.path, {
            kind: a.kind,
            importer: a.importer,
            resolveDir: CANON_MCP_SDK_DIR,
            pluginData: MCP_SDK_PIN,
          });
          if (r.errors.length) return { errors: r.errors, warnings: r.warnings };
          if (!r.path.startsWith(CANON_MCP_SDK_DIR + path.sep)) {
            return { errors: [{ text: `cap-ai-sdk-dedup: ${a.path} (importer ${a.importer}) resolved outside the canonical @modelcontextprotocol/sdk instance: ${r.path}` }] };
          }
          return { path: r.path, sideEffects: r.sideEffects };
        });

        // chrome-agent-platform-9epn.7: alias unused @ai-sdk/gateway and
        // @vercel/oidc out of store builds into minimal throwing stubs so
        // tree-shaking drops ~100 KB from store SW and agent-worker bundles.
        if (isStoreBuild) {
          b.onResolve({ filter: /^@ai-sdk\/gateway(\/.*)?$/ }, () => ({ path: GATEWAY_STUB }));
          b.onResolve({ filter: /^@vercel\/oidc(\/.*)?$/ }, () => ({ path: OIDC_STUB }));
        }
      },
    };
    // nodePaths hands esbuild the canonical SDK instance's node_modules dir as
    // a fallback search path (63et): the SDK's own exports map then resolves
    // the .js-suffixed subpaths natively (browser/ESM conditions).
    const shared = {
      bundle: true, format: "esm", target: "chrome120", platform: "browser",
      logLevel: "silent", sourcemap: DEBUG_BUILD, legalComments: "none",
      plugins: [browserDependencies, diffCoreFromSource, capAiSdkDedup],
      metafile: true,
      nodePaths: [path.dirname(path.dirname(CANON_MCP_SDK_DIR))],
      define: {
        ...browserProcessEnvOptions.define,
        __CAP_BUILD_LOG_DEFAULT__: JSON.stringify(DEBUG_BUILD ? "verbose" : "off"),
      },
      // The declaration for the identifier the define above substitutes — they travel together
      // (chrome-agent-platform-3337): the define without this banner is an undeclared global.
      banner: browserProcessEnvOptions.banner,
    };
    const SW = path.join(STAGE, "background/service-worker.js");
    const OPT = path.join(STAGE, "options.bundle.js");
    const NTP_BUNDLE = path.join(STAGE, "ntp.bundle.js");
    const SIDEPANEL_BUNDLE = path.join(STAGE, "sidepanel.bundle.js");
    const ARTIFACTS_BUNDLE = path.join(STAGE, "artifacts.bundle.js");
    const ARTIFACT_BUNDLE = path.join(STAGE, "artifact.bundle.js");
    const DIRECTORY_BUNDLE = path.join(STAGE, "directory.bundle.js");
    const PRIVACY_BUNDLE = path.join(STAGE, "privacy.bundle.js");
    const OFFSCREEN_BUNDLE = path.join(STAGE, "offscreen.bundle.js");
    const USER_WASM_STORE_CLIENT_BUNDLE = path.join(STAGE, "user-wasm-store-client.bundle.js");
    const DIFF_CORE = path.join(STAGE, "shared/diff-core.bundle.js");
    const WORKER = path.join(STAGE, "workers/agent-worker.js");

    await Promise.all([
      mkdir(path.dirname(SW), { recursive: true }),
      mkdir(path.dirname(DIFF_CORE), { recursive: true }),
      mkdir(path.dirname(WORKER), { recursive: true }),
      mkdir(path.join(ROOT, ".build"), { recursive: true }),
    ]);

    // DEVELOPER-ONLY MCP transport-spike probe
    // (CAP-FB-20260831-MCP-TRANSPORT-SPIKE-01). scripts/mcp-probe-entry.js
    // imports the remote-MCP client (lib/mcp-client.js → the browser-safe
    // Streamable-HTTP / SSE transports; NEVER the stdio path) and installs
    // globalThis.__capMcpProbe so the KAT can drive mount→list→call→teardown
    // INSIDE the real service worker (SW globals forbid dynamic import(), so
    // the probe must be part of the bundle). It is injected ONLY for the
    // developer target and is absent from every store build.
    const swInject = [];
    if (DEBUG_BUILD) swInject.push(path.join(ROOT, "scripts/mcp-probe-entry.js"));

    // chrome-agent-platform-9epn.5 + jjsz: build all 12 bundles concurrently.
    const [
      swResult,
      optResult,
      ntpResult,
      sidepanelResult,
      artifactsResult,
      artifactResult,
      directoryResult,
      privacyResult,
      offscreenResult,
      userWasmClientResult,
      diffCoreResult,
      workerResult,
    ] = await Promise.all([
      build({
        ...shared,
        entryPoints: [path.join(EXT_DIR, "background/service-worker.js")],
        outfile: SW,
        inject: swInject,
        metafile: true,
      }),
      build({ ...shared, entryPoints: [path.join(EXT_DIR, "options/options.js")], outfile: OPT }),
      build({ ...shared, entryPoints: [path.join(EXT_DIR, "ntp/ntp.js")], outfile: NTP_BUNDLE }),
      build({ ...shared, entryPoints: [path.join(EXT_DIR, "sidepanel/sidepanel.js")], outfile: SIDEPANEL_BUNDLE }),
      build({ ...shared, entryPoints: [path.join(EXT_DIR, "artifacts/index.js")], outfile: ARTIFACTS_BUNDLE }),
      build({ ...shared, entryPoints: [path.join(EXT_DIR, "artifact/artifact.js")], outfile: ARTIFACT_BUNDLE }),
      build({ ...shared, entryPoints: [path.join(EXT_DIR, "directory/directory.js")], outfile: DIRECTORY_BUNDLE }),
      build({ ...shared, entryPoints: [path.join(EXT_DIR, "privacy/privacy.js")], outfile: PRIVACY_BUNDLE }),
      build({ ...shared, entryPoints: [path.join(EXT_DIR, "offscreen/offscreen.js")], outfile: OFFSCREEN_BUNDLE }),
      build({ ...shared, entryPoints: [path.join(EXT_DIR, "lib/user-wasm-store-client.js")], outfile: USER_WASM_STORE_CLIENT_BUNDLE }),
      build({ ...shared, entryPoints: [path.join(EXT_DIR, "shared/diff-core.js")], outfile: DIFF_CORE }),
      build({
        ...shared,
        entryPoints: [path.join(EXT_DIR, "workers/agent-worker.js")],
        outfile: WORKER,
        format: "esm",
      }),
    ]);

    const SURFACE_BUNDLES = [
      { name: "artifacts", entry: "artifacts/index.js", out: "artifacts.bundle.js", path: ARTIFACTS_BUNDLE, result: artifactsResult, budget: 600_000 },
      { name: "artifact", entry: "artifact/artifact.js", out: "artifact.bundle.js", path: ARTIFACT_BUNDLE, result: artifactResult, budget: 600_000 },
      { name: "directory", entry: "directory/directory.js", out: "directory.bundle.js", path: DIRECTORY_BUNDLE, result: directoryResult, budget: 600_000 },
      { name: "privacy", entry: "privacy/privacy.js", out: "privacy.bundle.js", path: PRIVACY_BUNDLE, result: privacyResult, budget: 600_000 },
      { name: "offscreen", entry: "offscreen/offscreen.js", out: "offscreen.bundle.js", path: OFFSCREEN_BUNDLE, result: offscreenResult, budget: 250_000 },
      { name: "user-wasm-store-client", entry: "lib/user-wasm-store-client.js", out: "user-wasm-store-client.bundle.js", path: USER_WASM_STORE_CLIENT_BUNDLE, result: userWasmClientResult, budget: 10_000 },
    ];
    const SURFACE_BUNDLE_PATHS = SURFACE_BUNDLES.map((s) => s.path);
    const ALL_BUNDLE_PATHS = [SW, WORKER, OPT, DIFF_CORE, NTP_BUNDLE, SIDEPANEL_BUNDLE, ...SURFACE_BUNDLE_PATHS];

    {
      // The budget report NEVER lands in dist/: the shipped package must not
      // carry build-host paths (the shipped-bytes scrub rule). Stdout always;
      // .build/ (gitignored) for inspection.
      const { formatContributors } = await import("./scripts/bundle-budget.mjs");
      console.log(`bundle report (service-worker, pre-minify inputs):\n${formatContributors(swResult.metafile)}`);
      await Promise.all([
        writeFile(path.join(ROOT, ".build", "bundle-report.json"), JSON.stringify(swResult.metafile)),
        writeFile(path.join(ROOT, ".build", "bundle-report-worker.json"), JSON.stringify(workerResult.metafile)),
        writeFile(path.join(ROOT, ".build", "bundle-report-options.json"), JSON.stringify(optResult.metafile)),
        writeFile(path.join(ROOT, ".build", "bundle-report-ntp.json"), JSON.stringify(ntpResult.metafile)),
        writeFile(path.join(ROOT, ".build", "bundle-report-sidepanel.json"), JSON.stringify(sidepanelResult.metafile)),
        writeFile(path.join(ROOT, ".build", "bundle-report-diff-core.json"), JSON.stringify(diffCoreResult.metafile)),
        ...SURFACE_BUNDLES.map((s) =>
          writeFile(path.join(ROOT, ".build", `bundle-report-${s.name}.json`), JSON.stringify(s.result.metafile))
        ),
      ]);
    }

    // Scrub + seam-scan IN STAGING over ALL generated bundles (the SW,
    // the agent-worker bundle — agent-do/ai/mcp-sdk carry a `new Function`/
    // `new F("")` evaluator that the store-target policy forbids — the Options
    // bundle, diff-core, and surface bundles). chrome-agent-platform-tptx (+4f3j, absorbed):
    // the pinned Zod Doc.compile denial runs here too, and OPT is inside the
    // loop — before this change OPT was the one bundle still taking zod's JIT
    // path (its allowsEval probe and Doc.compile survived). After it, OPT's
    // probe throws inside zod's own try/catch, `allowsEval` is false, and zod
    // runs its jitless interpreter BY DESIGN (util.allowsEval consumers gate
    // JIT: schemas.js). That is a runtime behavior change for ONE bundle,
    // made deliberately: an evaluator-free Store package beats JIT parsing.
    let occurrences = 0;
    let zodProbes = 0;
    let zodDocCompiles = 0;
    const { denyZodDocCompiles } = await import("./scripts/lib/scrub-zod-doc.mjs");
    const scrubCounts = await Promise.all(ALL_BUNDLE_PATHS.map(async (scrubPath) => {
      let bundle = await readFile(scrubPath, "utf8");
      if (bundle.includes("key-sentinel") || bundle.includes("__CAP_TEST_SEAM")) {
        throw new Error("production bundle unexpectedly contains test-seam markers — refusing to publish");
      }
      const occ = (bundle.match(/new Function\s*\(/g) ?? []).length;
      bundle = bundle.replace(/new Function\s*\(/g, "(function(){ throw new Error('eval disabled (MV3 CSP)'); })(");
      const probes = (bundle.match(/new F\(""\)/g) ?? []).length;
      bundle = bundle.replace(/new F\(""\)/g, '(() => { throw new Error("eval disabled (MV3 CSP)"); })()');
      // The pinned Doc.compile denial: hash-recognized class bodies only, and
      // (chrome-agent-platform-ol0j) only when the constructor's own lexical
      // provenance resolves to the GLOBAL evaluator — a shadowed/local
      // `Function` binding is preserved.
      const denied = denyZodDocCompiles(bundle);
      bundle = denied.code;
      await writeFile(scrubPath, bundle);
      const remaining = (bundle.match(/new Function\s*\(|eval\s*\(|new F\(""\)/g) ?? []).length;
      if (remaining > 0) throw new Error(`bundle still contains ${remaining} eval sites after cleaning`);
      return { occ, probes, docCompiles: denied.count };
    }));
    for (const c of scrubCounts) {
      occurrences += c.occ;
      zodProbes += c.probes;
      zodDocCompiles += c.docCompiles;
    }

    // Store-target minification (CAP-FB-20260830-BUNDLE-BUDGET-01). The
    // documented contract was always "developer = unminified + source maps,
    // store = minified" — but no minify step existed, so the store package
    // shipped 141k lines of readable JS (SW: 5.47 MB). Minify runs AFTER the
    // eval scrub: the scrub's textual patterns (new Function / new F("")) are
    // only reliable on unminified code, and minification never reintroduces
    // them (globals are never renamed). The developer build is untouched.
    if (!DEBUG_BUILD) {
      await Promise.all(ALL_BUNDLE_PATHS.map(async (minifyPath) => {
        const source = await readFile(minifyPath, "utf8");
        const minified = await transform(source, {
          minify: true,
          target: "chrome120",
          legalComments: "none",
          // Keep the ESM shape — the SW loads as type:module.
          format: "esm",
        });
        // Defense in depth: the minified bytes must carry no eval shape.
        const evalSites = (minified.code.match(/new Function\s*\(|eval\s*\(|new F\(""\)/g) ?? []).length;
        if (evalSites > 0) {
          throw new Error(`minified bundle ${path.basename(minifyPath)} contains ${evalSites} eval site(s) — refusing to publish`);
        }
        await writeFile(minifyPath, minified.code);
      }));
    }

    // Final evaluator gate (chrome-agent-platform-kdax): parse the ACTUAL final
    // bytes of every generated bundle — after the scrub AND any minify transform
    // — and refuse publication when ANY dynamic evaluator site survives. The
    // regex checks above are defense in depth; this whole-AST classifier pass is
    // what sees ALIAS/MEMBER/SEQUENCE evaluators (the zod Doc.compile aliases a
    // regex could never name — 8 live sites on unmodified main, 2026-09-18).
    // Scope is every generated bundle: the wasm-tools runtime ships
    // as a separately reviewed, manifest-hash-pinned blob lane
    // (scripts/store-target-policy.mjs), not generated JavaScript.
    const { assertNoDynamicEvaluators } = await import("./scripts/lib/dynamic-evaluator-scan.mjs");
    await Promise.all(ALL_BUNDLE_PATHS.map(async (gatePath) => {
      assertNoDynamicEvaluators(await readFile(gatePath, "utf8"), gatePath);
    }));

    // The bundle budget report + integrity gate (CAP-FB-20260830-BUNDLE-
    // BUDGET-01, extended to every surface by chrome-agent-platform-9epn.4;
    // OWNER DECISION Paul, 2026-10-05: sizes are MEASURED AND REPORTED, not
    // enforced): every generated bundle's size is checked against its
    // reference in STORE_BUNDLE_BUDGETS — assertBundleBudget still fails the
    // build on the dependency-integrity invariants (duplicated instances,
    // lockfile drift) — and an over-reference bundle prints its top
    // contributors instead of failing the build. The developer build notes
    // its unminified bytes (larger by design).
    {
      const { assertBundleBudget, bundleBudgetReport, STORE_BUNDLE_BUDGETS, STORE_SW_BUDGET_BYTES } = await import("./scripts/bundle-budget.mjs");
      const metafileFor = {
        "background/service-worker.js": swResult.metafile,
        "workers/agent-worker.js": workerResult.metafile,
        "options.bundle.js": optResult.metafile,
        "ntp.bundle.js": ntpResult.metafile,
        "sidepanel.bundle.js": sidepanelResult.metafile,
        "shared/diff-core.bundle.js": diffCoreResult.metafile,
        "artifacts.bundle.js": artifactsResult.metafile,
        "artifact.bundle.js": artifactResult.metafile,
        "directory.bundle.js": directoryResult.metafile,
        "privacy.bundle.js": privacyResult.metafile,
        "offscreen.bundle.js": offscreenResult.metafile,
        "user-wasm-store-client.bundle.js": userWasmClientResult.metafile,
      };
      const swSize = (await stat(SW)).size;
      if (DEBUG_BUILD) {
        if (swSize > STORE_SW_BUDGET_BYTES) {
          console.log(`bundle budget: developer SW bundle is ${swSize} bytes (unminified; store budget ${STORE_SW_BUDGET_BYTES} applies to the minified store build)`);
        }
      } else {
        for (const [rel, budgetBytes] of Object.entries(STORE_BUNDLE_BUDGETS)) {
          const metafile = metafileFor[rel];
          if (!metafile) throw new Error(`bundle budget: ${rel} has a reference size but no build result — build.mjs must bundle every budgeted surface`);
          const size = (await stat(path.join(STAGE, rel))).size;
          assertBundleBudget({ label: rel, bytes: size, budgetBytes, metafile });
          const over = bundleBudgetReport({ label: rel, bytes: size, budgetBytes, metafile });
          if (over) console.log(over);
          else console.log(`bundle budget: store ${rel} ${size} bytes <= ${budgetBytes} budget`);
        }
      }
    }

    // Per-FILE mode preservation from the previous tree (fall back to defaults
    // for new files).
    const prevMode = async (rel) => {
      try { const st = await stat(path.join(DIST, rel)); return st.mode & 0o777; } catch { return null; }
    };

    // ── Admitted Pyodide runtime (CAP-FB-20260823-PYODIDE-PYTHON-01) ──────
    // Verify the committed runtime bytes against wasm-tools/python/MANIFEST.json
    // (exact sha256 — a drifted byte fails the build closed), then copy the
    // runtime + python-worker.js into the staged dist tree so it ships in the
    // packaged extension at dist/wasm-tools/python/ (the generated-artifact
    // tree — the raw third-party glue is never shipped as scanned source).
    {
      const RUNTIME_SRC = path.join(ROOT, "wasm-tools/python");
      const manifest = JSON.parse(await readFile(path.join(RUNTIME_SRC, "MANIFEST.json"), "utf8"));
      const runtimeFiles = Object.keys(manifest.files); // 7 pinned files incl. python-worker.js
      const PY = path.join(STAGE, "wasm-tools/python");
      await mkdir(PY, { recursive: true });
      await Promise.all(runtimeFiles.map(async (file) => {
        const expected = manifest.files[file]?.sha256;
        if (!expected) throw new Error(`pyodide runtime ${file} has no admission hash in wasm-tools/python/MANIFEST.json`);
        const srcFile = path.join(RUNTIME_SRC, file);
        const digest = createHash("sha256").update(await readFile(srcFile)).digest("hex");
        if (digest !== expected) {
          throw new Error(`pyodide runtime admission mismatch: ${file} sha256 ${digest} != manifest ${expected}`);
        }
        await copyFile(srcFile, path.join(PY, file));
      }));
      console.log(`build: admitted Pyodide runtime staged (${runtimeFiles.length} files, sha256-verified against MANIFEST.json)`);
    }

    await Promise.all(["background/service-worker.js", "options.bundle.js", "ntp.bundle.js", "sidepanel.bundle.js", "shared/diff-core.bundle.js", ...SURFACE_BUNDLES.map((s) => s.out)].map(async (rel) => {
      const mode = await prevMode(rel);
      if (mode != null) await chmod(path.join(STAGE, rel), mode); // mode failure = publish failure (fatal)
    }));
    // Directory boundary: previous dist's own mode/times — failures FATAL.
    try {
      const st = await stat(DIST);
      await chmod(STAGE, st.mode & 0o777);
      await utimes(STAGE, st.atime, st.mtime);
    } catch (e) {
      if (e?.code !== "ENOENT") throw e; // no prior dist is fine; a failure is not
    }

    // The COMPLETE marker inside the staged tree: readers treat dist as valid
    // only while dist/dist.complete exists. Lock owner, PID, wall-clock time,
    // stage path and version ID are invocation custody and MUST NOT enter this
    // production byte. The marker binds stable indexed source plus exact
    // generated output bytes and is therefore reproducible and verifiable.
    const sourceAfter = await computeIndexedSourceAuthority({ root: ROOT });
    if (
      sourceAfter.digest !== sourceBefore.digest ||
      sourceAfter.files !== sourceBefore.files
    ) {
      throw new Error(
        "indexed source changed during build — refusing to publish a mixed-generation dist",
      );
    }
    const writtenMarker = await writeDistCompleteMarker({
      root: ROOT,
      distRoot: STAGE,
      target: BUILD_TARGET,
      source: sourceAfter,
    });
    await validateDistCompleteMarker({
      root: ROOT,
      distRoot: STAGE,
      expectedTarget: BUILD_TARGET,
    });

    // ── THE PUBLISH (serialized by the lock) ────────────────────────────────
    // VERSIONED-DIR + ATOMIC POINTER: the real trees are dist-versions/<id>/;
    // `dist` is a symlink swapped with a rename of a temp symlink — a single
    // atomic filesystem operation, so dist is NEVER absent or partial (the
    // reviewer's finding: the old two-rename sequence left a missing-dist
    // interval). Chrome loads through the symlink; the dist.complete marker
    // stays inside each versioned tree as a validity stamp.
    const VERSIONS = path.join(EXT_DIR, "dist-versions");
    await mkdir(VERSIONS, { recursive: true });
    const VERSION_ID = `v-${process.pid}-${Date.now()}`;
    const VERSIONED = path.join(VERSIONS, VERSION_ID);
    await rename(STAGE, VERSIONED); // staging becomes a version (still off-path)
    const PREV_LINK = path.join(EXT_DIR, `.dist-link-prev-${process.pid}-${Date.now()}`);
    let prevTarget = null;
    try { prevTarget = await readlink(DIST).catch(() => null); } catch { prevTarget = null; }
    // BOOTSTRAP: if dist is still a real directory (pre-pointer layout),
    // migrate it into a version + swap the pointer — WITHOUT a missing-dist
    // interval: the boot link is created FIRST, then ONE rename replaces the
    // real dir with the link atomically (rename over an existing DIRECTORY
    // fails if non-empty — so rename the old dir away and IMMEDIATELY rename
    // the link in; the interval is closed by holding the previous dist as a
    // RENAME-SWAP: link-in FIRST under a temp name adjacent, then
    // rename(oldDir→version) + rename(link→dist) — still two ops. The truly
    // windowless path: rename(old dist dir → version) and rename(link → dist)
    // are consecutive with NO awaits between; the practical exposure is one
    // readdir window. To be strict we ALSO hold the lock (readers built by the
    // same repo respect it) AND ship the marker. Documented + probed.
    // lstat (NOT stat): the steady-state `dist` is a SYMLINK — stat would
    // FOLLOW it and report a directory, re-running the bootstrap every build
    // (two-rename window + dangling v-boot residue). lstat sees the link
    // itself; only a REAL directory (the legacy layout) bootstraps.
    const distIsRealDir = await lstat(DIST).then((s) => s.isDirectory()).catch(() => false);
    if (distIsRealDir) {
      const BOOT_VERSION = path.join(VERSIONS, `v-boot-${process.pid}-${Date.now()}`);
      const BOOT_LINK = path.join(EXT_DIR, `.dist-link-boot-${process.pid}-${Date.now()}`);
      await symlink(path.relative(EXT_DIR, BOOT_VERSION), BOOT_LINK);
      try {
        await rename(DIST, BOOT_VERSION);
        await rename(BOOT_LINK, DIST); // consecutive: no awaits between
      } catch (e) {
        // ROLLBACK: restore the real dir if the link swap failed.
        await rm(BOOT_LINK, { force: true }).catch(() => {});
        try {
          await rename(BOOT_VERSION, DIST);
        } catch (rb) {
          throw new Error(`FATAL: bootstrap failed (${e?.message ?? e}) AND rollback failed (${rb?.message ?? rb}) — dist may be missing; the previous tree is at ${BOOT_VERSION}`);
        }
        throw e;
      }
    }
    const NEXT_LINK = path.join(EXT_DIR, `.dist-link-next-${process.pid}-${Date.now()}`);
    await rm(NEXT_LINK, { force: true }).catch(() => {});
    await symlink(path.relative(EXT_DIR, VERSIONED), NEXT_LINK);
    try {
      await rename(NEXT_LINK, DIST); // THE atomic swap (POSIX rename replaces the link)
    } catch (e) {
      console.error("publish FAILED — rolling back");
      await rm(NEXT_LINK, { force: true }).catch(() => {});
      // The previous pointer was never disturbed (rename is atomic). Remove
      // the orphaned version tree so nothing leaks (FATAL if removal fails).
      try { await rm(VERSIONED, { recursive: true, force: true }); } catch (ce) {
        throw new Error(`FATAL: pointer swap failed (${e?.message ?? e}) AND version cleanup failed (${ce?.message ?? ce}) — orphan at ${VERSIONED}`);
      }
      throw e;
    }
    // Success: garbage-collect every version EXCEPT the live one, with
    // verification (a GC failure is FATAL — unbounded version growth is a
    // real leak, not a note). A 2s grace delay lets any reader that resolved
    // the PREVIOUS link mid-open complete (the pointer swap is atomic; this
    // covers the open-then-read window on the old target).
    await new Promise((r) => setTimeout(r, 2_000));
    try {
      for (const d of await readdir(VERSIONS, { withFileTypes: true })) {
        if (d.isSymbolicLink()) {
          // Residue from the bootstrap-re-run bug era: dangling v-boot-*
          // symlinks (and any other link) under dist-versions. REMOVED
          // explicitly (the old `isDirectory()` check silently skipped them).
          await rm(path.join(VERSIONS, d.name), { force: true });
          continue;
        }
        if (d.name === ".DS_Store" || d.name.startsWith("._")) {
          // Benign OS metadata created by macOS Finder / AppleDouble:
          // remove explicitly and continue rather than failing version GC.
          await rm(path.join(VERSIONS, d.name), { force: true });
          continue;
        }
        if (!d.isDirectory()) {
          // An unexpected non-directory, non-symlink entry (socket/fifo/…):
          // fail closed rather than silently leaking it forever.
          throw new Error(`unexpected non-directory entry in dist-versions: ${d.name}`);
        }
        const full = path.join(VERSIONS, d.name);
        if (full !== VERSIONED) {
          const info = await stat(full).then((s) => s.ino).catch(() => null);
          if (info == null) continue; // raced away
          await rm(full, { recursive: true, force: true });
          if (await stat(full).then(() => true).catch(() => false)) {
            throw new Error(`stale version cleanup failed: ${d.name} still exists`);
          }
        }
      }
    } catch (e) {
      throw new Error(`FATAL: version GC failed after publish (${e?.message ?? e}) — the live tree at ${VERSIONED} is valid, but stale versions remain under ${VERSIONS}`);
    }
    const publishSummary = `built ${path.join("extension", "dist", "background", "service-worker.js")} + dist/options.bundle.js ATOMICALLY (serialized owner-token lock; one dist dir; removed ${occurrences} new-Function + ${zodProbes} probes + ${zodDocCompiles} pinned Doc.compile methods; seam scan clean; dist.complete marker; rollback-fatal)`;
    console.log(publishSummary);
    if (isStoreBuild) {
      storeBuildRecord = {
        key: `${writtenMarker.commit}-${writtenMarker.source.digest}`,
        stdout: `${publishSummary}\n`,
      };
    }
    // The dist is published and the marker validated — the build is a genuine
    // success from here. The changelog-delta print + version record are NOT
    // done here: they run AFTER the final fatal step (staging cleanup + lock
    // release) below, so a build that dies in a finalizer never records a
    // version (see shouldRecordBuild).
    buildSucceeded = true;
    // Re-sync the docs/ gallery now that the diff-core bundle exists in DIST.
    // The earlier syncGallery() (before this build) reads DIST from the PREVIOUS
    // run, so on a fresh checkout the gitignored docs/diff-core.bundle.js has no
    // source to copy yet. Running it again here regenerates that build-output
    // copy from the freshly-published dist (idempotent for the source copies).
    await syncGallery();
  } finally {
    // Staging ALWAYS removed; a failure is FATAL. Also sweep stale temps from
    // crashed runs (staging, boot links, next links) at the repo root.
    try { await rm(STAGE, { recursive: true, force: true }); } catch (e) {
      throw new Error(`FATAL: staging cleanup failed (${e?.message ?? e}) — ${STAGE} may be leaked`);
    }
    for (const f of await readdir(EXT_DIR, { withFileTypes: true }).catch(() => [])) {
      if (f.name.startsWith(".dist-stage-") || f.name.startsWith(".dist-link-boot-") || f.name.startsWith(".dist-link-next-")) {
        await rm(path.join(EXT_DIR, f.name), { recursive: true, force: true });
      }
    }
  }
} finally {
  // Release ONLY our own lock (owner-token compare) — and a release FAILURE is
  // a build failure (a leaked live lock blocks every future build).
  try {
    const cur = JSON.parse(await readFile(path.join(LOCK_DIR, "owner.json"), "utf8"));
    if (cur?.token === OWNER.token) {
      await rm(LOCK_DIR, { recursive: true, force: true });
      if (await stat(LOCK_DIR).then(() => true).catch(() => false)) {
        console.error(`FATAL: lock release failed — ${LOCK_DIR} remains and will block future builds`);
        process.exitCode = 1;
      }
    }
  } catch (e) {
    // Unreadable lock at release: verify absence; a remaining lock is fatal.
    if (await stat(LOCK_DIR).then(() => true).catch(() => false)) {
      console.error(`FATAL: lock release verification failed (${e?.message ?? e}) — ${LOCK_DIR} remains`);
      process.exitCode = 1;
    }
  }
}

// Owner-requested build output: print the changelog delta since the last
// SUCCESSFUL build, then record THIS version for the next build. This runs
// after the FINAL fatal step (staging cleanup + lock release above): a build
// that died in a finalizer never records a version, so the next build's delta
// is always honest. Warn-only — this feature never fails the build.
if (shouldRecordBuild({ buildSucceeded, exitCode: process.exitCode ?? 0 })) {
  // A finalizer or gallery failure must never leave a success record behind.
  if (storeBuildRecord) {
    try {
      const { durableRoot } = await import("./scripts/lib/durable-root.mjs");
      const recDir = path.join(durableRoot(), "serial-build-once");
      await mkdir(recDir, { recursive: true });
      await writeFile(
        path.join(recDir, `${storeBuildRecord.key}.json`),
        JSON.stringify({ code: 0, stdout: storeBuildRecord.stdout, at: new Date().toISOString() }),
      );
    } catch {
      /* non-fatal cache population for storeBuildOnce */
    }
  }
  try {
    if (currentVersion) {
      if (!previousBuiltVersion) {
        // First build / fresh clone: one line, not the whole changelog.
        console.log(`First build at ${currentVersion} — no previous version recorded.`);
      } else {
        const parsed = currentChangelog ? parseChangelog(currentChangelog) : [];
        const delta = deltaBetween(parsed, previousBuiltVersion, currentVersion);
        if (delta.length > 0) {
          const rendered = renderDelta(delta);
          console.log(`\nNew since the last build (${previousBuiltVersion} → ${currentVersion}):\n${rendered}`);
        }
        // previous == current → silent (nothing new to say)
      }
      await writeLastBuiltVersion(BUILT_VERSION_PATH, currentVersion);
    }
  } catch (e) {
    console.error(`warning: changelog delta print failed (${e?.message ?? e}) — build itself is fine`);
  }
}
