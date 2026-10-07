// tests/build-smoke.test.ts — fast smoke assertion for build.mjs in npm test (chrome-agent-platform-h65e).
// Invariant: while heavy build-behaviour KATs (build-bootstrap, build-debug-mode, build-tool-bundling)
// run in the dedicated gate (npm run test:build), npm test still runs this smoke assertion so a
// broken build cannot go unnoticed: a store build of THIS tree must have exited 0, and the live
// dist.complete marker must validate against the tree.
//
// WHAT "exited 0" MEANS HERE, stated exactly (chrome-agent-platform-jjsz): `storeBuildOnce` either
// RUNS `node build.mjs --target=store` now, or REUSES the record build.mjs itself writes — and
// build.mjs writes it only after its LAST fatal step (staging cleanup, lock release) and only when
// the process is about to exit 0 (tests/build-parallel-discipline.test.ts pins that ordering). The
// reuse is trusted only while the live marker validates and its commit + source-authority key equals
// the record's (tests/fixtures/build-once.mjs). So this test does not always execute build.mjs
// itself; it proves a build of this exact tree exited 0 and left a valid marker.
import { fileURLToPath } from "node:url";
import { assert, assertEquals } from "jsr:@std/assert@1";
import { join } from "node:path";
import { validateDistCompleteMarker } from "../scripts/dist-complete.mjs";
import { storeBuildOnce } from "./fixtures/build-once.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

Deno.test("build smoke: a store build of this tree exited 0 (run now or recorded by build.mjs) and its dist marker validates", async () => {
  const distDir = join(ROOT, "extension", "dist");

  // Run or reuse the store build via storeBuildOnce (kj9s / h65e)
  const res = await storeBuildOnce({ root: ROOT });
  assertEquals(res.code, 0, `build.mjs must exit 0, got ${res.code} (source: ${res.source})\n${res.stdout}`);

  // Validate the resulting dist.complete marker
  const marker = await validateDistCompleteMarker({
    root: ROOT,
    distRoot: distDir,
    expectedTarget: "store",
  });
  assert(marker && typeof marker === "object", "dist.complete marker must be a valid store build");
});
