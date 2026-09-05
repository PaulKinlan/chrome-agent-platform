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
  // ── owner directives (TASKS.md CAP-FB-20260830-DEAD-CODE-CUT-01 Acceptance, 2026-08-30) ──
  "lib/agent-cards.js":
    "Owner directive 2026-08-30: adopted by CAP-FB-20260830-AGENT-SHARING-01; tests/agent-cards.test.ts pins it.",
  "lib/bundled-tool-packages.js":
    "Owner directive 2026-08-30: the WASI bundled-package inventory API must not change; tests/bundled-tool-packages.test.ts pins it (the service worker reads the generated *.data.js modules directly).",
  "lib/bundled-inventory.js":
    "Owner directive 2026-08-30: part of the WASI bundled-package inventory (imported by lib/bundled-tool-packages.js); tests/bundled-tool-packages.test.ts pins it.",
  // ── surfaces or modules another OPEN entry owns ──
  "lib/table-join-pivot.js":
    "chrome-agent-platform-def.2 (OPEN): strict-core joins and pivots over lib/table-core.js; the service-worker tool route is a follow-up that removes this RETAINED entry (tests/table-join-pivot.test.ts pins it).",
  "lib/table-formula.js":
    "Standalone bounded formula engine; def.4 removes this RETAINED entry when its production route imports the module.",
  "lib/tabular-diff-artifacts.js":
    "CAP-FB-20260822-TABULAR-DIFF-ARTIFACTS-01 is OPEN, not ABANDONED; the adapter and lib/tabular-diff-artifacts-core.js stay until it lands or closes (tests/tabular-diff-artifacts.test.ts).",
  "lib/code-diff-artifacts.js":
    "Holds the sha256 retention helpers CAP-FB-20260830-ARTIFACT-VERSIONS-01 folds into the versions store; that entry deletes it (tests/code-diff-artifacts.test.ts).",
  // ── only tests import these; cut together with the named tests in a follow-up ──
  "lib/js-minifier-tools.js":
    "No tool registers the bounded minifier today; only tests/js-minifier.test.ts imports it. It pulls js-minifier.js, js-minifier-lifecycle.js and the terser/csso/html-minifier worker bundles, which tests/scan-shipped.test.ts reads from disk (the scanner's canonical WorkerCtor exemption is bound to js-minifier-lifecycle.js:13).",
  "lib/jwt-decode-tools.js":
    "No tool registers the bounded JWT decoder today; only tests/jwt-decode.test.ts imports it. It pulls jwt-decode.js, jwt-decode-worker.js and jwt-decode-core.js, which tests/scan-shipped.test.ts reads from disk (canonical new Worker exemption at jwt-decode.js:60).",
  "lib/opfs-tool-workspace.js":
    "Only tests/opfs-tool-workspace.test.ts imports it.",
  "lib/profile-store.js":
    "Only tests/profile-store.test.ts imports it.",
  "lib/run-log-wal-memory.js":
    "An in-memory WAL double: eight tests import it (durable-runs, memory, failed-runs-lifecycle, thread-log-redesign, thread-reload-fidelity, tool-result-full-json, ux008-failed-dispatch, agent-worker-durability); it belongs under tests/ and moves there with them.",
  "lib/preference-bridge.js":
    "No page mounts the preference bridge (docs/PREFERENCE-PERCOLATION.md describes the design); only tests/security.test.ts imports it to pin the message validation.",
  "shared/agent-candidates.js":
    "shared/agent-registry.js replaced it in the product; scripts/sync-gallery.mjs still copies it into docs/ and tests/agent-command.test.ts, tests/site-agent-copy.test.ts, tests/webmcp-page-identity.test.ts import it.",
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
        if (SKIPPED_DIRS.has(name)) continue;
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
export async function checkReachability({ root, buildSource, manifest, retained = RETAINED, io }) {
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
  const violations = [
    ...unreached.map((f) => `${f}: shipped but nothing reaches it (delete it, or add it to RETAINED in scripts/check-reachability.mjs with a reason)`),
    ...staleRetained,
    ...retainedReachable,
  ];
  return { shipped: shippedList, reached, reachedFromEntry, unreached, staleRetained, retainedReachable, violations, retained: retainedSet };
}

// Node CLI (build.mjs imports and calls `runNode`; `main` is the standalone command).
export async function runNode({ root, log = console.log } = {}) {
  const { readFile, readdir } = await import("node:fs/promises");
  const path = await import("node:path");
  const ROOT = root ?? new URL("..", import.meta.url).pathname.replace(/\/$/, "");
  const extRoot = path.join(ROOT, "extension");
  const result = await checkReachability({
    root: extRoot,
    buildSource: await readFile(path.join(ROOT, "build.mjs"), "utf8"),
    manifest: JSON.parse(await readFile(path.join(extRoot, "manifest.json"), "utf8")),
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
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const result = await runNode();
    if (process.argv.includes("--list")) {
      for (const f of result.shipped) console.log(`${result.reachedFromEntry.has(f) ? "reached " : "RETAINED"} ${f}`);
    }
  } catch (error) {
    console.error(error?.message ?? error);
    process.exit(1);
  }
}
