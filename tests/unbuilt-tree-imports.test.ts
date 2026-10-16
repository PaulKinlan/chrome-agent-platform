/**
 * @fileoverview Protects unbuilt tree / fresh clone test executions against
 * static imports pointing into extension/dist/ (chrome-agent-platform-phif1).
 *
 * Background:
 * In a fresh clone or clean worktree, extension/dist/ does not exist until
 * `npm run build` is executed. Source files in `extension/` must never statically
 * import from `dist/` — doing so causes any unit test importing those components
 * (such as tests/artifact-preview-lazy.test.ts or tests/vocabulary.test.ts) to fail
 * with TS2307 / Module not found "file:///.../extension/dist/...".
 */

import { assert, assertEquals } from "jsr:@std/assert";
import * as path from "node:path";
import * as fs from "node:fs";

const ROOT = path.resolve(import.meta.dirname ?? ".", "..");
const EXTENSION_DIR = path.join(ROOT, "extension");

Deno.test("unbuilt-tree-imports: no JS module in extension/ statically imports from dist/", () => {
  const violations: string[] = [];

  function scanDir(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "dist" || entry.name === "node_modules" || entry.name.startsWith(".")) {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath);
      } else if (entry.name.endsWith(".js") || entry.name.endsWith(".mjs")) {
        const content = fs.readFileSync(fullPath, "utf8");
        // Check for static import/export statements referencing dist/
        const staticImportRegex = /(?:import|export)\s+(?:[\w*\s{},]*\s+from\s+)?["']([^"']*\bdist\/[^"']*)["']/g;
        let match;
        while ((match = staticImportRegex.exec(content)) !== null) {
          violations.push(`${path.relative(ROOT, fullPath)}: imports "${match[1]}"`);
        }
      }
    }
  }

  scanDir(EXTENSION_DIR);
  assertEquals(
    violations,
    [],
    `Source files in extension/ must import from source, not dist build artifacts:\n${violations.join("\n")}`,
  );
});

Deno.test("unbuilt-tree-imports: components-artifacts.js and artifacts.js import diff-core from source", async () => {
  const compArtifactsPath = path.join(EXTENSION_DIR, "shared", "components-artifacts.js");
  const compArtifactsContent = await Deno.readTextFile(compArtifactsPath);
  assert(
    compArtifactsContent.includes('from "./diff-core.js"'),
    "components-artifacts.js must import lineDiffSummary from ./diff-core.js",
  );
  assert(
    !compArtifactsContent.includes("dist/shared/diff-core.bundle.js"),
    "components-artifacts.js must not reference dist/shared/diff-core.bundle.js",
  );

  const artifactsPath = path.join(EXTENSION_DIR, "lib", "artifacts.js");
  const artifactsContent = await Deno.readTextFile(artifactsPath);
  assert(
    artifactsContent.includes('from "../shared/diff-core.js"'),
    "extension/lib/artifacts.js must import lineDiffSummary from ../shared/diff-core.js",
  );
  assert(
    !artifactsContent.includes("dist/shared/diff-core.bundle.js"),
    "extension/lib/artifacts.js must not reference dist/shared/diff-core.bundle.js",
  );
});

Deno.test("unbuilt-tree-imports: diff-core source module exports lineDiffSummary", async () => {
  const diffCore = await import("../extension/shared/diff-core.js");
  assertEquals(typeof diffCore.lineDiffSummary, "function");
  const summary = diffCore.lineDiffSummary("a\nb\n", "a\nc\n");
  assertEquals(summary.added, 1);
  assertEquals(summary.removed, 1);
  assertEquals(summary.hunks.length, 1);
});
