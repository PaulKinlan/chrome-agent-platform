// @ts-nocheck
// tests/build-if-needed.test.ts — the FAST gate must build when (and only when) the run needs a
// certified dist, must reuse a marker that already validates, and must never re-stamp one.
//
// chrome-agent-platform-0eq00 (architect arch-0eq00). The falsifiers this file pins:
//   * a change with no dist-consuming selection and no build input must SKIP the build
//     (otherwise the decision is decorative);
//   * a dist-reading selection must ALWAYS build (never test against a dist the gate cannot certify);
//   * a build that leaves an invalid marker must FAIL the run, not pass it.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import {
  GATE_BUILD_TARGET,
  STATIC_DIST_CONSUMERS,
  decideBuild,
  ensureStoreBuild,
  findDistConsumers,
  isBuildInput,
  referencesDistTree,
} from "../scripts/build-if-needed.mjs";
import { ALWAYS_ON, CORE } from "../scripts/select-tests.mjs";
import { READ_ONLY_DIST } from "../scripts/test-partition.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const readReal = (rel) => readFileSync(join(ROOT, rel), "utf8");

// Probe strings are ASSEMBLED here on purpose: a literal `build.mjs` or `extension/dist` in this
// file's own text would classify it as a build-artifact hazard and force these parallel-safe pure
// decision tests into the serial phase (scripts/test-partition.mjs's partition guard, the same idiom
// tests/test-partition-guard.test.ts uses for its reference-scoping probes).
const BUILD_MJS = "build" + ".mjs";
const DIST_ROOT = "extension/" + "dist";
const DIST_MARKER = `${DIST_ROOT}/dist.complete`;
const DIST_BUNDLE = `${DIST_ROOT}/shared/diff-core.bundle.js`;

Deno.test("0eq00 build: build inputs are the bytes and machinery that feed the store build", () => {
  for (const file of [
    BUILD_MJS,
    "package.json",
    "package-lock.json",
    "deno.jsonc",
    "deno.runner.jsonc",
    "deno.lock",
    "scripts/dist-complete.mjs",
    "scripts/lib/build-lock.mjs",
    "scripts/build-" + "bundled-tool-packages.mjs",
    "scripts/bundled-inventory.mjs",
    "extension/lib/memory.js",
    "extension/background/service-worker.js",
    "extension/manifest.json",
  ]) {
    assert(isBuildInput(file), `${file} feeds the store build`);
  }
  for (const file of [
    "tests/gate-manifest.test.ts",
    "docs/DESIGN.md",
    "scripts/select-tests.mjs",
    "scripts/run-tests.mjs",
    DIST_MARKER,
  ]) {
    assert(!isBuildInput(file), `${file} does not feed the store build`);
  }
  assertEquals(isBuildInput(""), false);
});

Deno.test("0eq00 build: a dist reader is detected by content, not by a list that can drift", () => {
  assert(referencesDistTree(`import { x } from "../${DIST_BUNDLE}";`));
  assert(referencesDistTree('const p = new URL("dist/", ROOT);'));
  assert(referencesDistTree(`readFileSync("${DIST_MARKER}")`));
  assert(!referencesDistTree('import { x } from "../extension/lib/pure.js";'));

  const readers = findDistConsumers(["tests/probe.test.ts", "extension/lib/not-a-test.js"], (rel) =>
    rel === "tests/probe.test.ts" ? `new URL("${DIST_ROOT}/", ROOT)` : "// no dist here",
  );
  assert(readers.includes("tests/probe.test.ts"), "a test that references the dist tree is a consumer");
  assert(!readers.includes("extension/lib/not-a-test.js"), "non-test paths are never consulted");
  // An unreadable test file is treated as a consumer: fail closed, never fail silent.
  assert(findDistConsumers(["tests/unreadable.test.ts"], () => null).includes("tests/unreadable.test.ts"));
});

Deno.test("0eq00 build: every reviewed dist reader is a static consumer (no drift)", () => {
  const consumers = findDistConsumers([], () => null);
  for (const file of READ_ONLY_DIST) {
    assert(consumers.includes(file), `${file} reads built artifacts and must force the build`);
  }
  assert(consumers.includes("tests/build-smoke.test.ts"));
  assert(STATIC_DIST_CONSUMERS.length >= READ_ONLY_DIST.size + 1);
});

Deno.test("0eq00 build: the always-on core contains a dist reader, so a subset gate is never build-free", () => {
  // THE MEASURED FACT the architect design did not account for: tests/owner-approval-security.test.ts
  // is always-on AND statically imports extension/dist/shared/diff-core.bundle.js. Therefore the
  // `build: omitted` branch is currently unreachable for any selection — pin it here so nobody
  // "discovers" the omission as a saving without removing this reader from the always-on set (or
  // giving the gate a dist-free core).
  assert(CORE.includes("tests/owner-approval-security.test.ts"), "the reader is in the always-on core");
  const consumers = findDistConsumers(ALWAYS_ON, readReal);
  assert(
    consumers.includes("tests/owner-approval-security.test.ts"),
    "the always-on set must be recognised as dist-consuming",
  );
  const decision = decideBuild({ kind: "subset", selected: ALWAYS_ON, changed: [], distConsumers: consumers });
  assertEquals(decision.required, true);
  assert(decision.reason.includes(`${DIST_ROOT} tree`), decision.reason);
});

Deno.test("0eq00 build: the decision skips a build only when nothing needs one (and says why)", () => {
  const decision = decideBuild({
    kind: "subset",
    selected: ["tests/vocabulary.test.ts"],
    changed: ["tests/vocabulary.test.ts"],
    distConsumers: ["tests/owner-approval-security.test.ts"],
  });
  assertEquals(decision.required, false);
  assert(decision.reason.includes(`no selected test reads ${DIST_ROOT}`), decision.reason);
  assert(decision.reason.includes("no build input changed"), decision.reason);
});

Deno.test("0eq00 build: a full-suite fallback and a build input each force the build", () => {
  const full = decideBuild({ kind: "full", selected: [], changed: [], distConsumers: [] });
  assertEquals(full.required, true);
  assert(full.reason.includes("full suite"), full.reason);

  const input = decideBuild({
    kind: "subset",
    selected: ["tests/vocabulary.test.ts"],
    changed: [BUILD_MJS],
    distConsumers: [],
  });
  assertEquals(input.required, true);
  assert(input.reason.includes(BUILD_MJS), input.reason);
});

Deno.test("0eq00 build: a valid marker is REUSED and the build is never paid for", async () => {
  let built = 0;
  const result = await ensureStoreBuild({
    required: true,
    reason: "selected tests read dist",
    root: ROOT,
    validate: async () => ({ ok: true, commit: "abc" }),
    runBuild: async () => {
      built += 1;
      return 0;
    },
  });
  assertEquals(result.disposition, "reused");
  assertEquals(result.markerCommit, "abc");
  assertEquals(built, 0, "the whole point: a valid dist must not cost a build");
});

Deno.test("0eq00 build: an invalid marker builds once, then certifies the result", async () => {
  let built = 0;
  let validations = 0;
  const result = await ensureStoreBuild({
    required: true,
    reason: "selected tests read dist",
    root: ROOT,
    validate: async () => {
      validations += 1;
      return validations === 1 ? { ok: false, error: "marker is missing" } : { ok: true, commit: "def" };
    },
    runBuild: async () => {
      built += 1;
      return 0;
    },
  });
  assertEquals(result.disposition, "ran");
  assertEquals(result.markerCommit, "def");
  assertEquals(built, 1);
  assertEquals(validations, 2);
});

Deno.test("0eq00 build: a build that does not certify the dist FAILS the run (never re-stamped)", async () => {
  let built = 0;
  const failedBuild = await ensureStoreBuild({
    required: true,
    reason: "selected tests read dist",
    root: ROOT,
    validate: async () => ({ ok: false, error: "marker is missing" }),
    runBuild: async () => {
      built += 1;
      return 2;
    },
  });
  assertEquals(failedBuild.disposition, "failed");
  assertEquals(built, 1, "a failing build is not retried inside the decision");

  const stillInvalid = await ensureStoreBuild({
    required: true,
    reason: "selected tests read dist",
    root: ROOT,
    validate: async () => ({ ok: false, error: "marker commit is stale" }),
    runBuild: async () => {
      built += 1;
      return 0;
    },
  });
  assertEquals(stillInvalid.disposition, "failed");
  assert(stillInvalid.reason.includes("still does not validate"), stillInvalid.reason);
  assertEquals(built, 2);
});

Deno.test("0eq00 build: an omitted build is explicit and runs nothing", async () => {
  let built = 0;
  const result = await ensureStoreBuild({
    required: false,
    reason: "nothing selected reads dist",
    root: ROOT,
    validate: async () => ({ ok: false, error: "not consulted" }),
    runBuild: async () => {
      built += 1;
      return 0;
    },
  });
  assertEquals(result.disposition, "omitted");
  assertEquals(result.reason, "nothing selected reads dist");
  assertEquals(built, 0);
  assertEquals(GATE_BUILD_TARGET, "store");
});
