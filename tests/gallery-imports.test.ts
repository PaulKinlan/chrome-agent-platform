// tests/gallery-imports.test.ts — the docs/ gallery is deployed static: every
// relative import in the synced module graph must RESOLVE to a synced file.
// (The round-1 failure: docs/components.js imported ../lib/tool-summary.js —
// no such file under docs/, so components.html failed module resolution.)

import { assert, assertEquals } from "jsr:@std/assert@1";

const DOCS = new URL("../docs/", import.meta.url);
const ENTRYPOINTS = ["components.js", "tool-summary.js", "tool-tree.js", "pure.js"];

async function specifiers(file: string): Promise<string[]> {
  const src = await Deno.readTextFile(new URL(file, DOCS));
  const out = [];
  for (const m of src.matchAll(/(?:import|export)[^'"]*?from\s*["']([^"']+)["']/g)) out.push(m[1]);
  for (const m of src.matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]);
  return out;
}

Deno.test("gallery: every relative import in the synced docs module graph resolves", async () => {
  const seen = new Set();
  const queue = [...ENTRYPOINTS];
  const unresolved = [];
  while (queue.length > 0) {
    const f = queue.pop();
    if (f === undefined || seen.has(f)) continue;
    seen.add(f);
    for (const spec of await specifiers(f)) {
      if (!spec.startsWith("./") && !spec.startsWith("../")) continue;
      const resolved = new URL(spec, new URL(f, DOCS));
      // Anything escaping docs/ (a ../lib/… path) cannot exist on the site.
      if (!resolved.pathname.includes("/docs/")) {
        unresolved.push(`${f} → ${spec} (escapes docs/)`);
        continue;
      }
      try {
        await Deno.stat(resolved);
        const rel = resolved.pathname.split("/docs/")[1];
        if (rel) queue.push(rel);
      } catch {
        unresolved.push(`${f} → ${spec} (missing)`);
      }
    }
  }
  assertEquals(unresolved, [], `unresolved gallery imports: ${unresolved.join("; ")}`);
});

Deno.test("gallery: the synced deploy copies match the canonical sources (sync-gallery --check)", async () => {
  const { syncGallery } = await import("../scripts/sync-gallery.mjs");
  assert(await syncGallery({ check: true }), "docs/ drifted from extension/ — run node scripts/sync-gallery.mjs");
});
