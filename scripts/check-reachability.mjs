// scripts/check-reachability.mjs — the shipped-package reachability gate
// (CAP-FB-20260830-DEAD-CODE-CUT-01).
//
// Every shipped source file under extension/ (.js/.mjs/.html/.css) must be
// REACHED from a manifest entry point, a build entry, or an explicit RETAINED
// entry with a reason. A file nothing references still ships to users and
// still has to be read by every security reviewer, so the build refuses it.
//
//   node scripts/check-reachability.mjs          → exit 1 on any unreached,
//                                                   unlisted file (or a stale
//                                                   RETAINED entry)
//   node scripts/check-reachability.mjs --list   → also print the reached set
//
// How a file is reached (the walk):
//   seeds  = manifest.json (background.service_worker, content_scripts[].js,
//            chrome_url_overrides, side_panel.default_path, options_page,
//            action.default_popup, sandbox.pages, web_accessible_resources)
//          + every esbuild entry in build.mjs (dist/<bundle> → its source)
//   edges  = every string token in a JS/HTML/CSS file that names an existing
//            package-local file (static/dynamic imports, `new Worker(url)`,
//            `chrome.runtime.getURL("…")`, `chrome.scripting.executeScript
//            ({ files: […] })`, `<script src>`, `<link href>`, `@import`).
//            Strings are read with acorn's tokenizer, so a path that only
//            appears in a COMMENT is not an edge.
//   bundles: a reference to `dist/<x>` counts as a reference to the source
//            entry esbuild builds it from (parsed from build.mjs).
//
// The RETAINED map is the owner's inventory: each entry is a file that is
// deliberately kept although no entry point reaches it today, with the reason
// (usually the tracker entry that adopts it). A RETAINED file that becomes
// reachable, or is deleted, is reported as stale so the list never rots.
//
// Runs under node (build.mjs) AND Deno (tests/reachability.test.ts) —
// `readFile`/`readdir` are injectable for the test; acorn is the only import.
import { fileURLToPath, pathToFileURL } from "node:url";
import { tokenizer } from "acorn";

export const SHIPPED_EXTENSIONS = new Set([".js", ".mjs", ".html", ".css"]);
export const SKIPPED_DIRS = new Set(["dist", "dist-versions", "dist-archives", "node_modules"]);

// file (relative to extension/) → the reason it stays although no entry point
// reaches it. Files a RETAINED module imports are kept with it (the walk
// continues from every RETAINED root), so only roots are listed; run with
// --list to see the full reached/RETAINED inventory.
//
// Two kinds of reason appear:
//   * an owner directive or an OPEN tracker entry that adopts the module;
//   * "only tests import it" — the module ships to users for no reason, but
//     its tests live under tests/ and are cut together with the module in a
//     follow-up (this cut does not touch tests/). Each such line names the
//     tests so the follow-up is a mechanical delete.
export const RETAINED = {

  "lib/code-mode-sandbox.js":
    "The code-mode sandbox bounds + tool-call SDK configuration (jao1.4, CAP-SECURE-ENCLAVE Stage 4): the SW wiring (script-host integration + tool-call bridging) is the NEXT slice; tests/code-mode-sandbox.test.ts pins the bounds and isolation contract meanwhile.",
  // (lib/service-tools.js was RETAINED at jao1.3; jao1.5's wiring merged the
  // synthesized tools into the agent loop's extraTools — REACHED now, so the
  // RETAINED line is gone. tests/service-tools.test.ts still pins it.)
  // (lib/secret-vault.js was RETAINED at jao1.1; jao1.2 wired the enclave proxy
  // route in the service worker, which imports the vault — REACHED now, so the
  // RETAINED line is gone. tests/secret-vault.test.ts still pins the contract.)
  // ── owner directives (TASKS.md CAP-FB-20260830-DEAD-CODE-CUT-01 Acceptance, 2026-08-30) ──
  // (lib/agent-cards.js was RETAINED here per the same directive; pu7n wired it
  // into ntp.js — Share/Import agent — so it is REACHED from an entry point now
  // and the RETAINED line is gone. tests/agent-cards.test.ts still pins it.)
  "lib/bundled-tool-packages.js":
    "Owner directive 2026-08-30: the WASI bundled-package inventory API must not change; tests/bundled-tool-packages.test.ts pins it (the service worker reads the generated *.data.js modules directly).",
  // (lib/bundled-inventory.js was RETAINED here; ltkj.2 reachable now via lib/wasm-package-admission.js)
  // ── surfaces or modules another OPEN entry owns ──
  "lib/archive-target-registry.js":
    "CAP-FB-20260905-UNBOUNDED-DATA-ARCHIVE-01 (11rm / qcuf): classification authority for durable targets. Its sanitizer family stayed tests-only; 8wbb shipped the agentConfig authority separately (lib/logical-site-agent-config.js) — this module ships when the 11rm streaming converter lands.",
  "lib/tabular-diff-artifacts.js":
    "CAP-FB-20260822-TABULAR-DIFF-ARTIFACTS-01 is OPEN, not ABANDONED; the adapter and lib/tabular-diff-artifacts-core.js stay until it lands or closes (tests/tabular-diff-artifacts.test.ts).",
  "lib/code-diff-artifacts.js":
    "Holds the sha256 retention helpers CAP-FB-20260830-ARTIFACT-VERSIONS-01 folds into the versions store; that entry deletes it (tests/code-diff-artifacts.test.ts).",
  // ── only tests import these; cut together with the named tests in a follow-up ──
  // (chrome-agent-platform-9bse: js-minifier-tools.js + jwt-decode-tools.js,
  // their lib trees, worker bundles and named tests were cut here — the
  // follow-up the entries above waited for.)
  "lib/opfs-tool-workspace.js":
    "Only tests/opfs-tool-workspace.test.ts imports it.",
  "lib/profile-store.js":
    "Layer 1 of the form-filler direction: the shipped form-filler skill (skill-registry, Data Wrangler and three other templates) fills fields 'from the user's stored profile in memory' — this schema-validated, grant-gated, audited store is that profile substrate (chrome-agent-platform-xtwv: retained, not orphaned).",
  // (lib/tar-stream.js was RETAINED per 11rm.1 "encoder without product
  // wiring"; 0ymn wired the streaming EXPORT driver into options.js, so it is
  // REACHED from an entry point now and the RETAINED line is gone.
  // tests/tar-stream.test.ts still pins it.)
  "lib/preference-bridge.js":
    "No page mounts the preference bridge (docs/PREFERENCE-PERCOLATION.md describes the design); only tests/security.test.ts imports it to pin the message validation.",
};

// Exported functions with no caller in reached files that are deliberately kept
// with an explicit reason (e.g. public API surface, external spec parity, or planned cut).
// Rot (entry is deleted or becomes reached) is reported as stale.
export const RETAINED_EXPORTS = {
};

// Parse the esbuild entries out of build.mjs: `const X = path.join(STAGE, "<dist rel>")`
// paired with `entryPoints: [path.join(EXT_DIR, "<source rel>")], outfile: X`.
export function parseBundleMap(buildSource) {
  const outfiles = new Map();
  for (const m of buildSource.matchAll(/const\s+([A-Z_]+)\s*=\s*path\.join\(STAGE,\s*"([^"]+)"\)/g)) {
    outfiles.set(m[1], m[2]);
  }
  const bundles = new Map();
  for (const m of buildSource.matchAll(/entryPoints:\s*\[path\.join\(EXT_DIR,\s*"([^"]+)"\)\],\s*outfile:\s*([A-Z_]+)/g)) {
    const distRel = outfiles.get(m[2]);
    if (!distRel) throw new Error(`check-reachability: build.mjs outfile ${m[2]} has no STAGE path`);
    bundles.set(`dist/${distRel}`, m[1]);
  }
  if (bundles.size === 0) throw new Error("check-reachability: no esbuild entries found in build.mjs");
  return bundles;
}

// Manifest seeds: every path the browser itself loads.
export function manifestSeeds(manifest) {
  const seeds = new Set();
  const add = (p) => { if (typeof p === "string" && p) seeds.add(p.replace(/^\/+/, "")); };
  add(manifest?.background?.service_worker);
  for (const cs of manifest?.content_scripts ?? []) for (const f of cs.js ?? []) add(f);
  for (const v of Object.values(manifest?.chrome_url_overrides ?? {})) add(v);
  add(manifest?.side_panel?.default_path);
  add(manifest?.options_page);
  add(manifest?.options_ui?.page);
  add(manifest?.action?.default_popup);
  for (const p of manifest?.sandbox?.pages ?? []) add(p);
  for (const war of manifest?.web_accessible_resources ?? []) for (const r of war.resources ?? []) add(r);
  return seeds;
}

const PATH_LIKE = /^(?:\.{1,2}\/)*[A-Za-z0-9_@][A-Za-z0-9_./@-]*\.(?:js|mjs|html|css)$/;

// Every string/template chunk in a JS source, comments excluded.
export function jsStrings(source, file = "<js>") {
  const out = [];
  try {
    for (const tok of tokenizer(source, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true })) {
      const label = tok.type?.label;
      if (label === "string" && typeof tok.value === "string") out.push(tok.value);
      else if (label === "template" && typeof tok.value === "string") out.push(tok.value);
    }
  } catch (error) {
    throw new Error(`check-reachability: cannot tokenize ${file}: ${error?.message ?? error}`);
  }
  return out;
}

// Candidate references from any shipped file (attribute URLs + inline script strings).
export function candidateRefs(rel, source) {
  const ext = rel.slice(rel.lastIndexOf("."));
  const refs = [];
  if (ext === ".js" || ext === ".mjs") {
    refs.push(...jsStrings(source, rel));
  } else if (ext === ".html") {
    for (const m of source.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/g)) refs.push(m[1]);
    for (const m of source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
      if (m[1].trim()) refs.push(...jsStrings(m[1], `${rel} (inline script)`));
    }
  } else if (ext === ".css") {
    for (const m of source.matchAll(/@import\s+(?:url\()?["']?([^"')\s;]+)["']?\)?/g)) refs.push(m[1]);
    for (const m of source.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) refs.push(m[1]);
  }
  return refs.map((r) => r.split(/[?#]/)[0]).filter((r) => PATH_LIKE.test(r));
}

/**
 * Extract exported function and symbol names from a JS/MJS source.
 * Excludes comments using acorn's tokenizer.
 */
export function exportedFunctions(source, file = "<js>") {
  const exports = new Set();
  const tokens = [];
  try {
    for (const tok of tokenizer(source, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true })) {
      tokens.push(tok);
    }
  } catch (error) {
    throw new Error(`check-reachability: cannot tokenize ${file} for exports: ${error?.message ?? error}`);
  }

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type?.keyword === "export" || t.type?.label === "export") {
      let j = i + 1;
      if (j >= tokens.length) break;

      // export default function foo
      if (tokens[j].type?.keyword === "default") {
        j++;
        if (tokens[j]?.type?.keyword === "function") {
          j++;
          if (tokens[j]?.type?.label === "name") {
            exports.add(tokens[j].value);
          }
        }
        continue;
      }

      // export async function foo
      if (tokens[j]?.type?.label === "name" && tokens[j]?.value === "async") {
        j++;
      }

      // export function foo
      if (tokens[j]?.type?.keyword === "function" || tokens[j]?.type?.label === "function") {
        j++;
        if (tokens[j]?.type?.label === "name") {
          exports.add(tokens[j].value);
        }
        continue;
      }

      // export const / let / var foo = ...
      if (
        ["const", "var"].includes(tokens[j]?.type?.keyword) ||
        (tokens[j]?.type?.label === "name" && ["let", "const", "var"].includes(tokens[j]?.value))
      ) {
        j++;
        if (tokens[j]?.type?.label === "name") {
          exports.add(tokens[j].value);
        }
        continue;
      }

      // export { a, b as c }
      if (tokens[j]?.type?.label === "{") {
        j++;
        while (j < tokens.length && tokens[j]?.type?.label !== "}") {
          if (tokens[j]?.type?.label === "name") {
            let exportedName = tokens[j].value;
            if (tokens[j + 1]?.type?.label === "name" && tokens[j + 1]?.value === "as" && tokens[j + 2]?.type?.label === "name") {
              exportedName = tokens[j + 2].value;
              j += 2;
            }
            exports.add(exportedName);
          }
          j++;
        }
        continue;
      }
    }
  }
  return [...exports].sort();
}

/**
 * Scan reached modules for exported functions with no callers in reached files.
 * Policy (CAP-FB-20260922 / kf3h):
 * - Scans reached JS/MJS modules (RETAINED modules are already tracked at file level).
 * - A caller in another reached file clears the export.
 * - An unused `import { fn }` does NOT clear the export (requires actual call/usage beyond import).
 * - Internal composition (same-file usage beyond declaration) clears the export.
 * - RETAINED_EXPORTS provides explicit exemption with reasons; rot (stale/reachable) is reported.
 */
export async function checkExportReachability({
  root,
  reached,
  io,
  retainedExports = RETAINED_EXPORTS,
  strictExports = false,
}) {
  const reachedJs = [...reached].filter((f) => f.endsWith(".js") || f.endsWith(".mjs"));
  const tokenCountsByFile = new Map();
  const importedIdentsByFile = new Map();
  const exportsByFile = new Map();

  for (const rel of reachedJs) {
    const source = await io.readFile(`${root}/${rel}`);
    const counts = new Map();
    const imported = new Set();
    const exported = exportedFunctions(source, rel);

    // Track imported identifiers in this file: import { a, b as c } from "..."
    for (const m of source.matchAll(/\bimport\s*\{([^}]+)\}\s*from/g)) {
      for (const item of m[1].split(",")) {
        const parts = item.trim().split(/\s+as\s+/);
        const local = (parts[1] || parts[0]).trim();
        if (local) imported.add(local);
      }
    }
    importedIdentsByFile.set(rel, imported);

    try {
      for (const tok of tokenizer(source, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true })) {
        if (tok.type?.label === "name" && typeof tok.value === "string") {
          counts.set(tok.value, (counts.get(tok.value) || 0) + 1);
        }
      }
    } catch {
      for (const m of source.matchAll(/[A-Za-z0-9_$]+/g)) {
        counts.set(m[0], (counts.get(m[0]) || 0) + 1);
      }
    }

    tokenCountsByFile.set(rel, counts);
    exportsByFile.set(rel, exported);
  }

  // Also count tokens in reached HTML files (inline scripts)
  for (const rel of reached) {
    if (reachedJs.includes(rel)) continue;
    if (rel.endsWith(".html")) {
      try {
        const html = await io.readFile(`${root}/${rel}`);
        const counts = new Map();
        for (const tok of tokenizer(html, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true })) {
          if (tok.type?.label === "name" && typeof tok.value === "string") {
            counts.set(tok.value, (counts.get(tok.value) || 0) + 1);
          }
        }
        tokenCountsByFile.set(rel, counts);
      } catch {}
    }
  }

  const reachedExports = [];
  const unreachedExports = [];
  const staleRetainedExports = [];
  const retainedReachableExports = [];
  const allKnownExportKeys = new Set();

  for (const [file, funcs] of exportsByFile) {
    for (const fn of funcs) {
      const exportKey = `${file}:${fn}`;
      allKnownExportKeys.add(exportKey);
      let hasCaller = false;

      // 1. Check other reached files
      for (const [otherFile, counts] of tokenCountsByFile) {
        if (otherFile === file) continue;
        const count = counts.get(fn) || 0;
        if (count === 0) continue;
        const importsFn = importedIdentsByFile.get(otherFile)?.has(fn);
        if (importsFn) {
          // If imported, count must be >= 2 (import declaration + at least one usage)
          if (count >= 2) {
            hasCaller = true;
            break;
          }
        } else {
          // Not explicitly imported (e.g. called via namespace or global reference)
          hasCaller = true;
          break;
        }
      }

      // 2. Check internal composition in declaring file (count >= 2: declaration + internal call)
      if (!hasCaller) {
        const ownCount = tokenCountsByFile.get(file)?.get(fn) || 0;
        if (ownCount >= 2) {
          hasCaller = true;
        }
      }

      if (hasCaller) {
        reachedExports.push(exportKey);
        if (retainedExports && Object.prototype.hasOwnProperty.call(retainedExports, exportKey)) {
          retainedReachableExports.push(`${exportKey}: RETAINED_EXPORTS but already reached from a caller — drop the entry`);
        }
      } else {
        if (retainedExports && Object.prototype.hasOwnProperty.call(retainedExports, exportKey)) {
          const reason = retainedExports[exportKey];
          if (typeof reason !== "string" || !reason.trim()) {
            staleRetainedExports.push(`${exportKey}: RETAINED_EXPORTS without a reason`);
          }
        } else {
          unreachedExports.push(`${exportKey}: exported function has no callers in reached files (delete it, or add to RETAINED_EXPORTS in scripts/check-reachability.mjs with a reason)`);
        }
      }
    }
  }

  // Check for stale retained exports (export key in retainedExports that does not exist)
  for (const key of Object.keys(retainedExports || {})) {
    if (!allKnownExportKeys.has(key)) {
      staleRetainedExports.push(`${key}: RETAINED_EXPORTS but no such export exists in reached files`);
    }
  }

  const exportViolations = [
    ...(strictExports ? unreachedExports : []),
    ...staleRetainedExports,
    ...retainedReachableExports,
  ];

  return {
    totalExportedFunctions: allKnownExportKeys.size,
    reachedExports,
    unreachedExports,
    retainedExports: new Set(Object.keys(retainedExports || {})),
    staleRetainedExports,
    retainedReachableExports,
    exportViolations,
  };
}

function normalize(parts) {
  const out = [];
  for (const part of parts.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (out.length === 0) return null; out.pop(); continue; }
    out.push(part);
  }
  return out.join("/");
}

// Resolve a candidate against the shipped set: relative to the referencing
// file first, then package-root-relative; `dist/<bundle>` maps to its source.
export function resolveRef(fromRel, ref, shipped, bundles) {
  const dir = fromRel.includes("/") ? fromRel.slice(0, fromRel.lastIndexOf("/")) : "";
  const candidates = [];
  if (ref.startsWith("./") || ref.startsWith("../")) candidates.push(normalize(`${dir}/${ref}`));
  else { candidates.push(normalize(ref)); candidates.push(normalize(`${dir}/${ref}`)); }
  for (const c of candidates) {
    if (!c) continue;
    if (bundles.has(c)) return bundles.get(c);
    if (shipped.has(c)) return c;
  }
  return null;
}

export async function walkShipped(root, { readdir }) {
  const out = [];
  async function walk(dir, relDir) {
    for (const entry of await readdir(dir)) {
      const name = entry.name;
      const rel = relDir ? `${relDir}/${name}` : name;
      if (entry.isDirectory) {
        if (SKIPPED_DIRS.has(name) || name.startsWith(".")) continue;
        // extension/wasm/ is the content-addressed package store: hash-pinned
        // generated data (inventory assets), never module source. Its files are
        // gated by the generated inventory mapping, the shipped-code/Wasm scans
        // and the admission authority — not by the module graph. The ltkj.2
        // acceptance lane ships runtime .mjs assets there that no bundle imports.
        // Scoped to the exact top-level path: a directory named "wasm" deeper in
        // the tree is still walked.
        if (rel === "wasm") continue;
        await walk(`${dir}/${name}`, rel);
      } else if (SHIPPED_EXTENSIONS.has(name.slice(name.lastIndexOf(".")))) {
        // Generated esbuild outputs are never shipped sources: the bundles in
        // `dist/` are skipped via SKIPPED_DIRS above, and stale copies that a
        // pre-dist-era build left under an old path (e.g. options/options.bundle.js)
        // must not fail the reachability gate. They match the gitignore rule
        // `extension/**/*.bundle.js` and are never entry points.
        if (name.endsWith(".bundle.js")) continue;
        out.push(rel);
      }
    }
  }
  await walk(root, "");
  return out.sort();
}

/**
 * Run the walk. `io.readdir(dir)` returns [{name, isDirectory}], `io.readFile(path)` returns text.
 * Returns { shipped, reached, unreached, staleRetained, retainedReachable, violations }.
 */
export async function checkReachability({
  root,
  buildSource,
  manifest,
  retained = RETAINED,
  retainedExports = RETAINED_EXPORTS,
  strictExports = false,
  io,
}) {
  const shippedList = await walkShipped(root, io);
  const shipped = new Set(shippedList);
  const bundles = parseBundleMap(buildSource);
  for (const [distRel, src] of bundles) {
    if (!shipped.has(src)) throw new Error(`check-reachability: build entry ${src} (for ${distRel}) is not a shipped file`);
  }
  const reached = new Set();
  const queue = [];
  const seed = (p) => {
    const target = bundles.get(p) ?? (shipped.has(p) ? p : null);
    if (target && !reached.has(target)) { reached.add(target); queue.push(target); }
  };
  for (const s of manifestSeeds(manifest)) seed(s);
  for (const src of bundles.values()) seed(src);
  // RETAINED files are walked too: what a kept module imports is kept with it.
  for (const p of Object.keys(retained)) seed(p);
  const retainedSet = new Set(Object.keys(retained));
  const reachedFromEntry = new Set();
  // First pass: walk from real entries only, to know which RETAINED entries are stale.
  {
    const r = new Set();
    const q = [];
    const s2 = (p) => {
      const target = bundles.get(p) ?? (shipped.has(p) ? p : null);
      if (target && !r.has(target)) { r.add(target); q.push(target); }
    };
    for (const s of manifestSeeds(manifest)) s2(s);
    for (const src of bundles.values()) s2(src);
    while (q.length) {
      const rel = q.shift();
      const source = await io.readFile(`${root}/${rel}`);
      for (const ref of candidateRefs(rel, source)) {
        const target = resolveRef(rel, ref, shipped, bundles);
        if (target) s2(target);
      }
    }
    for (const x of r) reachedFromEntry.add(x);
  }
  while (queue.length) {
    const rel = queue.shift();
    const source = await io.readFile(`${root}/${rel}`);
    for (const ref of candidateRefs(rel, source)) {
      const target = resolveRef(rel, ref, shipped, bundles);
      if (target && !reached.has(target)) { reached.add(target); queue.push(target); }
    }
  }
  const unreached = shippedList.filter((f) => !reached.has(f));
  const staleRetained = [];
  const retainedReachable = [];
  for (const [file, reason] of Object.entries(retained)) {
    if (!shipped.has(file)) staleRetained.push(`${file}: RETAINED but no such shipped file`);
    else if (typeof reason !== "string" || !reason.trim()) staleRetained.push(`${file}: RETAINED without a reason`);
    if (reachedFromEntry.has(file)) retainedReachable.push(`${file}: RETAINED but already reached from an entry point — drop the RETAINED line`);
  }

  // Export reachability scan across reached modules (kf3h)
  const exportResult = await checkExportReachability({
    root,
    reached: reachedFromEntry,
    io,
    retainedExports,
    strictExports,
  });

  const violations = [
    ...unreached.map((f) => `${f}: shipped but nothing reaches it (delete it, or add it to RETAINED in scripts/check-reachability.mjs with a reason)`),
    ...staleRetained,
    ...retainedReachable,
    ...exportResult.exportViolations,
  ];

  return {
    shipped: shippedList,
    reached,
    reachedFromEntry,
    unreached,
    staleRetained,
    retainedReachable,
    violations,
    retained: retainedSet,
    // Export reachability outputs
    unreachedExports: exportResult.unreachedExports,
    reachedExports: exportResult.reachedExports,
    retainedExports: exportResult.retainedExports,
    staleRetainedExports: exportResult.staleRetainedExports,
    retainedReachableExports: exportResult.retainedReachableExports,
    exportViolations: exportResult.exportViolations,
  };
}

// Node CLI (build.mjs imports and calls `runNode`; `main` is the standalone command).
export async function runNode({ root, log = console.log, strictExports = false } = {}) {
  const { readFile, readdir } = await import("node:fs/promises");
  const path = await import("node:path");
  const ROOT = root ?? fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
  const extRoot = path.join(ROOT, "extension");
  const result = await checkReachability({
    root: extRoot,
    buildSource: await readFile(path.join(ROOT, "build.mjs"), "utf8"),
    manifest: JSON.parse(await readFile(path.join(extRoot, "manifest.json"), "utf8")),
    strictExports,
    io: {
      readFile: (p) => readFile(p, "utf8"),
      readdir: async (d) => (await readdir(d, { withFileTypes: true })).map((e) => ({ name: e.name, isDirectory: e.isDirectory() })),
    },
  });
  if (result.violations.length > 0) {
    throw new Error(
      `reachability check failed (${result.violations.length} finding(s)):\n` +
      result.violations.map((v) => `  - ${v}`).join("\n"),
    );
  }
  log(`build assertion: every one of ${result.shipped.length} shipped source files is reached (${result.reachedFromEntry.size} from entry points, ${result.retained.size} RETAINED with a reason)`);
  if (result.unreachedExports?.length > 0) {
    log(`reachability report: ${result.unreachedExports.length} exported function(s) with no caller in reached files (${result.retainedExports?.size ?? 0} RETAINED_EXPORTS)`);
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const isStrict = process.argv.includes("--strict-exports");
    const result = await runNode({ strictExports: isStrict });
    if (process.argv.includes("--list")) {
      for (const f of result.shipped) console.log(`${result.reachedFromEntry.has(f) ? "reached " : "RETAINED"} ${f}`);
    }
    if (process.argv.includes("--exports")) {
      console.log(`\n--- Unreached exported functions (${result.unreachedExports.length}) ---`);
      for (const exp of result.unreachedExports) console.log(`  unreached export: ${exp}`);
    }
  } catch (error) {
    console.error(error?.message ?? error);
    process.exit(1);
  }
}
