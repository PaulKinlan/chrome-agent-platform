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

Deno.test("unbuilt-tree-components: 2y7qe recurrence guard passes with docs bundle absent (x3rx7)", async () => {
  const bundlePath = path.join(DOCS_DIR, "diff-core.bundle.js");
  let stashedContent: string | null = null;
  if (fs.existsSync(bundlePath)) {
    stashedContent = fs.readFileSync(bundlePath, "utf8");
    fs.unlinkSync(bundlePath);
  }

  try {
    const cmd = new Deno.Command("deno", {
      args: [
        "test",
        "-A",
        "--config",
        "deno.runner.jsonc",
        "--filter",
        "2y7qe recurrence guard: every cross-module call to components-core is imported and exported",
        "tests/components.test.ts",
      ],
      cwd: ROOT,
      env: { ...Deno.env.toObject(), CAP_TEST_RUNNER: "1" },
    });
    const output = await cmd.output();
    const stdout = new TextDecoder().decode(output.stdout);
    const stderr = new TextDecoder().decode(output.stderr);
    assertEquals(
      output.code,
      0,
      `2y7qe recurrence guard must pass in unbuilt tree without docs/diff-core.bundle.js.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
    assert(
      stdout.includes("ok"),
      `Expected test output to contain 'ok', got:\n${stdout}`,
    );
  } finally {
    if (stashedContent !== null) {
      fs.writeFileSync(bundlePath, stashedContent, "utf8");
    }
  }
});


