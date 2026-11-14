// scripts/lib/gallery-imports.mjs — the PURE walk behind tests/gallery-imports.test.ts.
// chrome-agent-platform-0pjmh.
//
// WHY THIS MODULE EXISTS: the gallery walk used to be inline in the test, so the only
// way to exercise it was to run the whole test file against the real docs/ tree. That
// made it impossible to falsify cheaply — and it hid a real defect. 7tx47 declared the
// suite "177ms, no build input: a cheap always-on guard", but docs/diff-core.bundle.js
// is BUILD OUTPUT (scripts/dist-complete.mjs lists it; scripts/sync-gallery.mjs derives
// it from extension/dist/). The FULL gate runs the build tier and the parallel test
// population at the same time, so the guard could read docs/ before the bundle was
// written and red the gate: "FAILED | 7617 passed | 1 failed — unresolved gallery
// imports: components-artifacts.js → ./diff-core.bundle.js (missing)".
//
// An always-on guard must be TRUE ON AN UNBUILT TREE — that is what "always-on" buys.
// But it must not go blind either: a generated docs file whose SOURCE is also missing
// is a real broken import, so the walk asserts the source authority instead of the
// artifact (the same resolution tests/components.test.ts's 2y7qe guard uses, and the
// same rule scripts/sync-gallery.mjs already applies when a sync source is absent).
// The source asserted is the GIT module the copy is bundled from, never the built
// artifact: asserting the artifact would fail on a fresh clone, which is this defect
// repeated one layer down.
//
// The walk is a pure function over three injected oracles so the build-absent case can
// be asserted without moving any file and without spawning a nested test runner.

/**
 * Walk the synced docs module graph from `entrypoints`.
 *
 * @param {object} opts
 * @param {string[]} opts.entrypoints      docs-relative files to start from.
 * @param {(file: string) => string[]} opts.specifiers   the import/export specifiers of a file.
 * @param {(docsRelPath: string) => boolean} opts.exists  does this docs-relative path exist?
 * @param {Map<string, string>} [opts.generatedSources]  docs-relative path → its repo-relative
 *        SOURCE, for entries that are generated build output (absent on an unbuilt tree).
 * @param {(repoRelPath: string) => boolean} [opts.sourceExists] does the build SOURCE exist?
 * @param {string} [opts.docsPrefix] `/docs/`-style pathname prefix that a resolved target must
 *        stay inside; anything escaping it cannot exist on the deployed site.
 * @returns {{ unvisited: string[], unresolved: string[], buildPending: string[], visited: string[] }}
 */
export function walkGalleryImports({
  entrypoints,
  specifiers,
  exists,
  generatedSources = new Map(),
  sourceExists = () => false,
  docsPrefix = "/docs/",
}) {
  /** @type {string[]} */ const unresolved = [];
  /** @type {string[]} */ const buildPending = [];
  /** @type {string[]} */ const unvisited = [];
  const seen = new Set();
  const queue = [...entrypoints];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    let specs;
    try {
      specs = specifiers(file);
    } catch {
      // A queued file that has vanished mid-walk is an unresolved import, not a crash:
      // the walk reports it BY NAME so the failure names the edge, never a stack trace.
      unvisited.push(file);
      continue;
    }
    for (const spec of specs) {
      if (!spec.startsWith("./") && !spec.startsWith("../")) continue;
      const target = resolveDocsRelative(file, spec);
      if (target === null) {
        // Escapes docs/: a ../lib/… path cannot exist on the deployed site.
        unresolved.push(`${file} → ${spec} (escapes ${docsPrefix})`);
        continue;
      }
      if (exists(target)) {
        queue.push(target);
        continue;
      }
      if (generatedSources.has(target)) {
        const source = generatedSources.get(target);
        if (sourceExists(source)) {
          // Build output, source present: legitimate on an unbuilt tree. Recorded, not
          // hidden — the landing full gate builds first and will walk the real artifact.
          buildPending.push(`${file} → ${spec} (generated ${target} absent; source ${source} present)`);
          continue;
        }
        unresolved.push(`${file} → ${spec} (generated ${target} absent AND its source ${source} is missing)`);
        continue;
      }
      unresolved.push(`${file} → ${spec} (missing)`);
    }
  }
  return { unvisited, unresolved, buildPending, visited: [...seen] };
}

/**
 * Resolve a relative specifier the way the BROWSER would: against the importing file's
 * own directory, normalising `.` and `..`. Returns the docs-relative target, or null when
 * the result climbs out of `docs/`.
 */
export function resolveDocsRelative(fromFile, spec) {
  const segments = fromFile.split("/");
  segments.pop(); // drop the file name
  for (const part of spec.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  if (segments.length === 0) return null;
  return segments.join("/");
}
