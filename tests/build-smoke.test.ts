// tests/build-smoke.test.ts — fast smoke assertion for build.mjs in npm test (chrome-agent-platform-h65e).
// Invariant: while heavy build-behaviour KATs (build-bootstrap, build-debug-mode, build-tool-bundling)
// run in the dedicated gate (npm run test:build), npm test still runs this smoke assertion to prove
// that build.mjs runs cleanly and emits a valid dist.complete marker.
import { fileURLToPath } from "node:url";
import { assert, assertEquals } from "jsr:@std/assert@1";
import { join } from "node:path";
import { validateDistCompleteMarker } from "../scripts/dist-complete.mjs";
import { storeBuildOnce } from "./fixtures/build-once.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

Deno.test("build smoke: build.mjs completes with code 0 and emits a valid dist marker", async () => {
  const distDir = join(ROOT, "extension", "dist");

  // Run or reuse the store build via storeBuildOnce (kj9s / h65e)
  const res = await storeBuildOnce({ root: ROOT });
  assertEquals(res.code, 0, `build.mjs must exit 0, got ${res.code}\n${res.stdout}`);

  // Validate the resulting dist.complete marker
  const marker = await validateDistCompleteMarker({
    root: ROOT,
    distRoot: distDir,
    expectedTarget: "store",
  });
  assert(marker && typeof marker === "object", "dist.complete marker must be a valid store build");
});
