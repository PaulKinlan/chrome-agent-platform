// tests/store-doc-denial.test.ts — chrome-agent-platform-tptx (+4f3j, absorbed):
// the pinned Zod Doc.compile denial is wired over ALL FOUR generated bundles
// pre-minify, and the final published Store bytes carry ZERO recognized dynamic
// evaluator sites. This is the evidence-level gate; the PERMANENT post-minify
// gate is chrome-agent-platform-kdax (blocked on this change).
//
// Behavior note (deliberate, reviewed): with the Options bundle inside the scrub
// loop, zod's allowsEval probe throws inside zod's own try/catch there too, so
// OPT runs zod's jitless interpreter BY DESIGN. Validation parity is pinned in
// tests/zod-jitless-fallback.test.ts.
// @ts-nocheck — build output text + AST classifier over real bundles.
import { fileURLToPath } from "node:url";
import { assertEquals, assertMatch } from "jsr:@std/assert@1";
import { parse } from "npm:acorn";
import { findDynamicEvaluators } from "../scripts/lib/dynamic-evaluator-scan.mjs";

const { execFileSync } = await import("node:child_process");
const { readFile } = await import("node:fs/promises");
const path = (await import("node:path")).default;

const ROOT = fileURLToPath(new URL("..", import.meta.url));

Deno.test("store: the pinned Doc.compile denial fires and no evaluator survives in any bundle", async () => {
  const output = execFileSync("node", ["build.mjs", "--target=store"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 180_000,
  });
  // Tooth: the build must report at least one pinned denial — a rotted
  // class-body pin (zod bump, pipeline change) reads as 0 and fails this.
  assertMatch(
    output,
    /removed \d+ new-Function \+ \d+ probes \+ [1-9]\d* pinned Doc\.compile methods/,
    "the build must report a nonzero pinned Doc.compile denial count",
  );
  for (const rel of ["background/service-worker.js", "options.bundle.js", "shared/diff-core.bundle.js", "workers/agent-worker.js"]) {
    const bytes = await readFile(path.join(ROOT, "extension", "dist", rel), "utf8");
    const sites = findDynamicEvaluators(parse(bytes, { ecmaVersion: "latest", sourceType: "module" }));
    assertEquals(sites.length, 0, `${rel} must carry no dynamic evaluator site`);
  }
});
