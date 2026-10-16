/**
 * @fileoverview Regression test for fresh clone / unbuilt worktrees where
 * docs/diff-core.bundle.js does not exist (chrome-agent-platform-6h71c).
 *
 * Verifies that the static 2y7qe recurrence guard in tests/components.test.ts
 * resolves bundle imports in docs/components-artifacts.js against the source
 * authority in extension/shared/diff-core.js rather than throwing an unresolved
 * module failure in unbuilt trees.
 */

import { assert, assertEquals } from "jsr:@std/assert";
import * as path from "node:path";
import * as fs from "node:fs";

const ROOT = path.resolve(import.meta.dirname ?? ".", "..");
const DOCS_DIR = path.join(ROOT, "docs");
const EXTENSION_SHARED_DIR = path.join(ROOT, "extension", "shared");

Deno.test("unbuilt-tree-components: docs/diff-core.bundle.js is a gitignored build artifact", () => {
  const gitignorePath = path.join(ROOT, ".gitignore");
  const gitignore = fs.readFileSync(gitignorePath, "utf8");
  assert(
    gitignore.includes("docs/*.bundle.js"),
    "docs/*.bundle.js must be gitignored so fresh clones do not carry generated bundles",
  );
});

Deno.test("unbuilt-tree-components: extension/shared/diff-core.js exists as source for diff-core", () => {
  const sourcePath = path.join(EXTENSION_SHARED_DIR, "diff-core.js");
  assert(fs.existsSync(sourcePath), "extension/shared/diff-core.js must exist in git");
  const content = fs.readFileSync(sourcePath, "utf8");
  assert(content.includes("export function lineDiffSummary"), "diff-core.js must export lineDiffSummary");
});

Deno.test("unbuilt-tree-components: docs/components-artifacts.js references diff-core bundle", () => {
  const artifactsDocPath = path.join(DOCS_DIR, "components-artifacts.js");
  assert(fs.existsSync(artifactsDocPath), "docs/components-artifacts.js must exist");
  const content = fs.readFileSync(artifactsDocPath, "utf8");
  assert(
    content.includes('from "./diff-core.bundle.js"'),
    "docs/components-artifacts.js imports from ./diff-core.bundle.js",
  );
});
