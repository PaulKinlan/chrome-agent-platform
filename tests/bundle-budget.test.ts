// tests/bundle-budget.test.ts — the store-target bundle budget gate
// (CAP-FB-20260830-BUNDLE-BUDGET-01).
//
// The Aug-2026 finding: the SW bundle reached 4.56 MB against the
// constitution's ~2.5 MB note because nothing in the build failed when it
// grew, and the "store = minified" contract was never implemented (the store
// shipped 141k lines of readable JS). The fix: metafile-backed contributor
// reporting on every build, store-target minification after the eval scrub,
// and a hard 3.0 MB gate on the minified SW bundle.
//
// Falsification: set the gate to 1 MB and the store build fails naming the
// top contributors; restore and it passes. The order pin (scrub BEFORE
// minify) is the safety-critical invariant: the eval scrub's textual patterns
// only match unminified code.
// @ts-nocheck

import { assert, assertEquals, assertRejects, assertStringIncludes, assertThrows } from "jsr:@std/assert@1";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { assertNoDynamicEvaluators } from "../scripts/lib/dynamic-evaluator-scan.mjs";
import {
  assertBundleBudget,
  BUDGET_REPORTED_BUNDLES,
  bundleBudgetReport,
  duplicateAiSdkInputs,
  duplicateStoreInputs,
  formatContributors,
  nonDenoStoreInputs,
  STORE_BUNDLE_BUDGETS,
  STORE_SW_BUDGET_BYTES,
  topContributors,
  zodCjsInputs,
} from "../scripts/bundle-budget.mjs";
import { DIST_COMPLETE_OUTPUTS } from "../scripts/dist-complete.mjs";
import { BUNDLE_ARCHIVE_MAP } from "../scripts/store-target-policy.mjs";

Deno.test("bundle budget: the store SW budget is exactly the constitution number (3.0 MB)", () => {
  assertEquals(STORE_SW_BUDGET_BYTES, 3_000_000);
  assert(BUDGET_REPORTED_BUNDLES.includes("background/service-worker.js"));
});

Deno.test("bundle budget: topContributors sorts largest-first and truncates", () => {
  const metafile = {
    inputs: {
      "small.js": { bytes: 10 },
      "big.js": { bytes: 9000 },
      "mid.js": { bytes: 500 },
    },
  };
  const top = topContributors(metafile, 2);
  assertEquals(top, [
    { input: "big.js", bytes: 9000 },
    { input: "mid.js", bytes: 500 },
  ]);
  assertStringIncludes(formatContributors(metafile), "big.js");
  assertEquals(topContributors(null), []);
  assertEquals(topContributors({}), []);
});

Deno.test("bundle budget: sizes return measured bytes; an over-reference bundle is REPORTED, not thrown (owner decision 2026-10-05)", () => {
  assertEquals(assertBundleBudget({ label: "x.js", bytes: 100 }), 100);
  assertEquals(assertBundleBudget({ label: "x.js", bytes: 3_000_000 }), 3_000_000, "the exact boundary passes");
  // OWNER DECISION (Paul, 2026-10-05): a size over the reference no longer
  // fails the build — it is reported. The falsifiable property is now: the
  // call RETURNS the size (never throws for size) and the REPORT names the
  // bundle, the actual size, the reference size and the top contributors.
  const metafile = { inputs: { "huge-dep.js": { bytes: 9_999_999 } } };
  assertEquals(assertBundleBudget({ label: "background/service-worker.js", bytes: 4_500_000, metafile }), 4_500_000, "an over-reference size returns instead of throwing");
  const report = bundleBudgetReport({ label: "background/service-worker.js", bytes: 4_500_000, metafile });
  assertStringIncludes(report, "4500000", "the report names the actual size");
  assertStringIncludes(report, "3000000", "the report names the reference size");
  assertStringIncludes(report, "huge-dep.js", "the report names the top contributor");
  assertStringIncludes(report, "service-worker", "the report names the bundle");
  assertStringIncludes(report, "reported, not enforced", "the report states the policy");
  assertEquals(bundleBudgetReport({ label: "x.js", bytes: 100 }), "", "an under-reference bundle reports nothing");

  assertThrows(() => assertBundleBudget({ label: "x.js", bytes: NaN }), undefined, "not measurable");
});

Deno.test("bundle budget: build.mjs wires the metafile report, the store gate, and scrub-BEFORE-minify", async () => {
  const source = await Deno.readTextFile("extension/../build.mjs");
  // The SW build carries the metafile the report + gate consume.
  assertStringIncludes(source, "metafile: true");
  // Store-only minification — the developer build keeps readable code +
  // source maps (CAP-FB-20260826-OBSERVABILITY-01).
  assertStringIncludes(source, "if (!DEBUG_BUILD) {");
  assertStringIncludes(source, "minify: true");
  // The gate iterates the ONE budget table and holds every bundle against its
  // own ceiling with its own metafile (9epn.4).
  assertStringIncludes(source, "for (const [rel, budgetBytes] of Object.entries(STORE_BUNDLE_BUDGETS))");
  assertStringIncludes(source, "assertBundleBudget({ label: rel, bytes: size, budgetBytes, metafile })");
  // SAFETY ORDER: the eval scrub (textual, unminified-only patterns) runs
  // BEFORE minification, and the minified output is re-scanned.
  const scrubAt = source.indexOf("new Function\\s*\\(");
  const minifyAt = source.indexOf("minify: true");
  assert(scrubAt !== -1 && minifyAt !== -1, "both the scrub and the minify step exist");
  assert(scrubAt < minifyAt, "the eval scrub must run BEFORE minification");
  assertStringIncludes(source, "minified bundle", "the minified bytes are re-scanned for eval sites");
});

Deno.test("bundle budget: no shipped source or built bundle references a CDN (Pyodide is bundled+pinned)", async () => {
  // The security half of the bead: the Python runtime must never fetch
  // unpinned remote code. It ships as verified bytes staged from
  // wasm-tools/python/ — no CDN URL may appear in any extension source.
  const files: string[] = [];
  async function collect(dir: string) {
    for await (const entry of Deno.readDir(dir)) {
      const p = `${dir}/${entry.name}`;
      if (entry.isDirectory) {
        if (entry.name === "dist-versions" || entry.name === "dist-archives") continue;
        await collect(p);
      } else if (/\.(js|mjs|html|json|ts)$/.test(entry.name)) {
        files.push(p);
      }
    }
  }
  await collect("extension");
  for (const file of files) {
    const text = await Deno.readTextFile(file);
    assert(
      !text.includes("cdn.jsdelivr.net"),
      `${file}: no cdn.jsdelivr.net — runtime code is bundled and hash-verified, never fetched`,
    );
  }
});

Deno.test("bundle budget: a store-built dist reports the SW size against the reference (report-only; owner decision 2026-10-05)", async () => {
  // build-bootstrap regenerates dist with --target=store ahead of this file
  // in the serial suite; when the marker says store, the REAL bytes are
  // REPORTED here (sizes are measured and reported, not enforced). A
  // developer or absent dist skips honestly.
  let marker;
  try {
    marker = JSON.parse(await Deno.readTextFile("extension/dist/dist.complete"));
  } catch {
    return; // no built dist in this environment
  }
  if (marker?.target !== "store") return; // developer build: unminified by design
  const size = (await Deno.stat("extension/dist/background/service-worker.js")).size;
  const report = bundleBudgetReport({ label: "background/service-worker.js", bytes: size });
  if (report) console.log(report);
  else console.log(`bundle budget: store background/service-worker.js ${size} bytes <= ${STORE_SW_BUDGET_BYTES} reference`);
});

// ── chrome-agent-platform-9epn.4: a ceiling for EVERY surface ──────────────
// Only the SW (3.0 MB) and the worker (2.0 MB) had a number; ntp / sidepanel /
// options / diff-core grew unobserved. The table STORE_BUNDLE_BUDGETS is the
// one place every ceiling lives, the store build gates each entry, and the
// marker records each bundle's size so this file can hold the SAME numbers
// against the bytes that actually shipped.

Deno.test("9epn.4 bundle budget: every generated bundle has a ceiling and the gate bites per entry", () => {
  const entries = Object.entries(STORE_BUNDLE_BUDGETS);
  assertEquals(
    [...Object.keys(STORE_BUNDLE_BUDGETS)].sort(),
    [...DIST_COMPLETE_OUTPUTS].sort(),
    "the budget table and the marker's output list name the SAME bundles — a bundle recorded without a ceiling (or a ceiling for a bundle the marker does not record) is the gap this bead closed",
  );
  assertEquals(BUDGET_REPORTED_BUNDLES, Object.keys(STORE_BUNDLE_BUDGETS));
  // Every surface by name: agreement between two lists is not a pin if
  // both can lose the same entry. o2t3 added the six SECONDARY bundles, which
  // declared a budget in build.mjs but were reported by nothing at all.
  assertEquals(
    [...Object.keys(STORE_BUNDLE_BUDGETS)].sort(),
    [
      "artifacts.bundle.js",
      "artifact.bundle.js",
      "background/service-worker.js",
      "directory.bundle.js",
      "ntp.bundle.js",
      "offscreen.bundle.js",
      "options.bundle.js",
      "privacy.bundle.js",
      "shared/diff-core.bundle.js",
      "sidepanel.bundle.js",
      "user-wasm-store-client.bundle.js",
      "workers/agent-worker.js",
      // Sorted here rather than by hand: the actual list is sorted, and the two
      // "artifact" names differ only at the 9th character ('.' < 's'), which is
      // exactly the kind of hand-ordering that fails for the wrong reason.
    ].sort(),
  );
  for (const [surface, budget] of entries) {
    assert(Number.isSafeInteger(budget) && budget > 0, `${surface} has a positive integer ceiling (got ${budget})`);
  }
  for (const [label, budgetBytes] of entries) {
    // At the reference: passes and returns the size.
    assertEquals(assertBundleBudget({ label, bytes: budgetBytes, budgetBytes }), budgetBytes, `${label}: the exact reference passes`);
    // One byte over (owner decision 2026-10-05): REPORTED, not thrown — the
    // call returns the size and the report names bundle, size and reference.
    assertEquals(assertBundleBudget({ label, bytes: budgetBytes + 1, budgetBytes }), budgetBytes + 1, `${label}: an over-reference size returns instead of throwing`);
    const report = bundleBudgetReport({ label, bytes: budgetBytes + 1, budgetBytes });
    assertStringIncludes(report, label, `${label}: the report names the bundle`);
    assertStringIncludes(report, String(budgetBytes + 1), `${label}: the report names the actual size`);
    assertStringIncludes(report, String(budgetBytes), `${label}: the report names the reference size`);
    assertEquals(bundleBudgetReport({ label, bytes: budgetBytes, budgetBytes }), "", `${label}: at or under the reference reports nothing`);
  }
});

Deno.test("9epn.4 bundle budget: dist.complete records every generated bundle, reported against its reference (store build; report-only)", async () => {
  // build-bootstrap regenerates dist with --target=store ahead of this file in
  // the serial suite. An ABSENT marker is a failure here, not a skip: a size
  // report that cannot read its subject must refuse rather than pass.
  let marker;
  try {
    marker = JSON.parse(await Deno.readTextFile("extension/dist/dist.complete"));
  } catch {
    throw new Error("9epn.4: dist.complete is missing — run `npm run build:production` first; the per-surface sizes are reported from the marker.");
  }
  const recorded = Array.isArray(marker?.outputs) ? marker.outputs : [];
  assertEquals(
    recorded.map((o) => o.path),
    [...DIST_COMPLETE_OUTPUTS],
    "dist.complete lists every generated bundle in the marker's fixed order",
  );
  const sizeOf = new Map(recorded.map((o) => [o.path, o.size]));
  for (const [path, size] of sizeOf) {
    assert(Number.isSafeInteger(size) && size > 0, `${path}: the marker records a positive byte size (got ${size})`);
    assertEquals(size, (await Deno.stat(`extension/dist/${path}`)).size, `${path}: the recorded size is the shipped file's size`);
  }
  if (marker.target !== "store") return; // developer build: unminified by design; the references measure the store bytes
  // OWNER DECISION (Paul, 2026-10-05): sizes over a reference are REPORTED,
  // not gated. The report stays LOUD — one line per budgeted entry, so
  // growth is visible in every suite run — but it can never redden the build.
  for (const [path, budget] of Object.entries(STORE_BUNDLE_BUDGETS)) {
    const size = sizeOf.get(path);
    assert(size !== undefined, `${path}: budgeted but not recorded in dist.complete`);
    const report = bundleBudgetReport({ label: path, bytes: size, budgetBytes: budget });
    if (report) console.log(report);
    else console.log(`bundle budget: store ${path} ${size} bytes <= ${budget} reference`);
  }
});

// ── chrome-agent-platform-63et: one AI SDK instance per bundle ─────────────
// The SW bundle carried the AI SDK stack TWICE (Deno peer-context subtrees:
// root resolves ai@7.0.66 in a zod@3 context, agent-do hard-depends zod ^4 →
// ai@7.0.66_1 + provider-utils 5.0.27/_1 + zod@4.4.3), and a mis-installed
// worktree silently produced a 272KB-bloated bundle while the primary
// checkout measured 2,999,957. Both failure classes are now fail-closed
// guards on the budget path.

Deno.test("63et duplicateAiSdkInputs: one .deno instance per AI SDK package is clean", () => {
  const metafile = { inputs: {
    "node_modules/.deno/ai@7.0.66/node_modules/ai/dist/index.js": { bytes: 100 },
    "node_modules/.deno/zod@3.25.76/node_modules/zod/v3/types.js": { bytes: 100 },
    "node_modules/.deno/@ai-sdk+provider-utils@5.0.33/node_modules/@ai-sdk/provider-utils/dist/index.js": { bytes: 100 },
    "node_modules/.deno/@ai-sdk+google@4.0.44/node_modules/@ai-sdk/google/dist/index.js": { bytes: 100 },
    "extension/lib/agent.js": { bytes: 10 },
  } };
  assertEquals(duplicateAiSdkInputs(metafile), {});
  assertEquals(duplicateAiSdkInputs(null), {});
});

Deno.test("63et duplicateAiSdkInputs: same-version peer-context duplicates are named; DISTINCT versions are legitimate and pass", () => {
  const metafile = { inputs: {
    // ai: same version, peer-context _1 duplicate — FLAGGED.
    "node_modules/.deno/ai@7.0.66/node_modules/ai/dist/index.js": { bytes: 100 },
    "node_modules/.deno/ai@7.0.66_1/node_modules/ai/dist/index.js": { bytes: 100 },
    // provider-utils: two DISTINCT versions (the providers pin incompatible
    // lines — a blanket alias broke @ai-sdk/anthropic) — NOT flagged.
    "node_modules/.deno/@ai-sdk+provider-utils@5.0.33/node_modules/@ai-sdk/provider-utils/dist/index.js": { bytes: 100 },
    "node_modules/.deno/@ai-sdk+provider-utils@5.0.27/node_modules/@ai-sdk/provider-utils/dist/index.js": { bytes: 100 },
    // zod: two distinct majors (owner-scope migration) — NOT flagged…
    "node_modules/.deno/zod@3.25.76/node_modules/zod/v3/types.js": { bytes: 100 },
    "node_modules/.deno/zod@4.4.3/node_modules/zod/v4/index.js": { bytes: 100 },
    // …but a same-version zod _1 duplicate WOULD be.
    "node_modules/.deno/zod@4.4.3_1/node_modules/zod/v4/index.js": { bytes: 100 },
  } };
  const dups = duplicateAiSdkInputs(metafile);
  assertEquals(Object.keys(dups).sort(), ["ai@7.0.66", "zod@4.4.3"]);
  assertEquals(dups["ai@7.0.66"], [".deno/ai@7.0.66", ".deno/ai@7.0.66_1"]);
  assertEquals(dups["zod@4.4.3"], [".deno/zod@4.4.3", ".deno/zod@4.4.3_1"]);
});

Deno.test("63et nonDenoStoreInputs: bare node_modules inputs are named; .deno paths and repo sources pass", () => {
  const metafile = { inputs: {
    "node_modules/ai/dist/index.js": { bytes: 1 },
    "node_modules/.deno/ai@7.0.66/node_modules/ai/dist/index.js": { bytes: 1 },
    "extension/lib/agent.js": { bytes: 1 },
    "node_modules/zod/v3/types.js": { bytes: 1 },
  } };
  assertEquals(nonDenoStoreInputs(metafile), ["node_modules/ai/dist/index.js", "node_modules/zod/v3/types.js"]);
  assertEquals(nonDenoStoreInputs(null), []);
});

Deno.test("63et assertBundleBudget fails closed on a duplicated AI SDK instance even under budget", () => {
  const metafile = { inputs: {
    "node_modules/.deno/ai@7.0.66/node_modules/ai/dist/index.js": { bytes: 10 },
    "node_modules/.deno/ai@7.0.66_1/node_modules/ai/dist/index.js": { bytes: 10 },
  } };
  const error = assertThrows(() =>
    assertBundleBudget({ label: "background/service-worker.js", bytes: 100, metafile })
  );
  assertStringIncludes(error.message, "duplicated same-version package instances");
  assertStringIncludes(error.message, "ai@7.0.66: .deno/ai@7.0.66, .deno/ai@7.0.66_1");
});

Deno.test("63et assertBundleBudget fails closed on lockfile drift (non-Deno-store inputs) even under budget", () => {
  const metafile = { inputs: { "node_modules/ai/dist/index.js": { bytes: 10 } } };
  const error = assertThrows(() =>
    assertBundleBudget({ label: "background/service-worker.js", bytes: 100, metafile })
  );
  assertStringIncludes(error.message, "lockfile drift");
  assertStringIncludes(error.message, "node_modules/ai/dist/index.js");
});

// ── chrome-agent-platform-9epn.3: the duplicate gate covers EVERY package ──
// The 63et detector matched only ai|zod|@ai-sdk/provider-utils, so the
// 2026-10-01 audit found @modelcontextprotocol+sdk@1.30.0 AND …@1.30.0_1 (the
// same SDK twice, 175KB pre-minify each) plus zod-to-json-schema@3.25.2 twice
// in the store SW with the gate green. One instance per exact version is the
// invariant for ALL packages; the fixture below is the falsifier the bead
// names (foo@1.0.0 + foo@1.0.0_1 must fail).

Deno.test("9epn.3 duplicateStoreInputs: a same-version _N duplicate of ANY package is flagged (foo@1.0.0 + foo@1.0.0_1); distinct versions pass", () => {
  const metafile = { inputs: {
    "node_modules/.deno/foo@1.0.0/node_modules/foo/index.js": { bytes: 1 },
    "node_modules/.deno/foo@1.0.0_1/node_modules/foo/index.js": { bytes: 1 },
    // scoped package, same version, _2 suffix — flagged with the scope restored
    "node_modules/.deno/@modelcontextprotocol+sdk@1.30.0/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js": { bytes: 1 },
    "node_modules/.deno/@modelcontextprotocol+sdk@1.30.0_2/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js": { bytes: 1 },
    // distinct versions of an arbitrary package — legitimate
    "node_modules/.deno/bar@2.0.0/node_modules/bar/index.js": { bytes: 1 },
    "node_modules/.deno/bar@2.1.0/node_modules/bar/index.js": { bytes: 1 },
    // prerelease version with a suffix — the suffix is what is stripped, not the prerelease tag
    "node_modules/.deno/baz@3.0.0-beta.1/node_modules/baz/index.js": { bytes: 1 },
    "node_modules/.deno/baz@3.0.0-beta.1_1/node_modules/baz/index.js": { bytes: 1 },
    "extension/lib/agent.js": { bytes: 1 },
  } };
  const dups = duplicateStoreInputs(metafile);
  assertEquals(Object.keys(dups).sort(), ["@modelcontextprotocol/sdk@1.30.0", "baz@3.0.0-beta.1", "foo@1.0.0"]);
  assertEquals(dups["foo@1.0.0"], [".deno/foo@1.0.0", ".deno/foo@1.0.0_1"]);
  assertEquals(dups["@modelcontextprotocol/sdk@1.30.0"], [".deno/@modelcontextprotocol+sdk@1.30.0", ".deno/@modelcontextprotocol+sdk@1.30.0_2"]);
  assertEquals(dups["baz@3.0.0-beta.1"], [".deno/baz@3.0.0-beta.1", ".deno/baz@3.0.0-beta.1_1"]);
  // The 63et name is the same detector.
  assertEquals(duplicateAiSdkInputs(metafile), dups);
});

Deno.test("9epn.3 assertBundleBudget fails closed on a duplicated NON-AI-SDK package (foo@1.0.0 + foo@1.0.0_1) even under budget", () => {
  const metafile = { inputs: {
    "node_modules/.deno/foo@1.0.0/node_modules/foo/index.js": { bytes: 10 },
    "node_modules/.deno/foo@1.0.0_1/node_modules/foo/index.js": { bytes: 10 },
  } };
  const error = assertThrows(() =>
    assertBundleBudget({ label: "background/service-worker.js", bytes: 100, metafile })
  );
  assertStringIncludes(error.message, "foo@1.0.0: .deno/foo@1.0.0, .deno/foo@1.0.0_1");
});

/** Read a .build metafile the production build wrote, or refuse. */
async function readBuildReport(name: string): Promise<{ inputs: Record<string, { bytes: number; imports?: { path: string; original?: string }[] }> }> {
  const repo = fileURLToPath(new URL("../", import.meta.url));
  const report = join(repo, ".build", name);
  let metafile;
  try {
    metafile = JSON.parse(await Deno.readTextFile(report));
  } catch {
    throw new Error(`bundle budget: ${report} is missing — run \`npm run build:production\` first; a check that cannot read its subject must refuse rather than pass.`);
  }
  assert(Object.keys(metafile.inputs ?? {}).length > 10, `${name} must describe a real bundle`);
  return metafile;
}

/** The distinct `.deno/<store-name>@<version>` prefixes of one package in a metafile. */
function storeInstances(metafile: { inputs: Record<string, unknown> }, storeName: string): string[] {
  const re = new RegExp(`\\.deno/(${storeName.replaceAll("+", "\\+")}@[^/]+)/`);
  const seen = new Set<string>();
  for (const input of Object.keys(metafile.inputs)) {
    const m = input.match(re);
    if (m) seen.add(m[1]);
  }
  return [...seen].sort();
}

for (const report of ["bundle-report.json", "bundle-report-worker.json"]) {
  Deno.test(`9epn.3 ${report}: exactly ONE @modelcontextprotocol+sdk and ONE zod-to-json-schema instance ship, and zero same-version duplicates of any package`, async () => {
    const metafile = await readBuildReport(report);
    const sdk = storeInstances(metafile, "@modelcontextprotocol+sdk");
    assertEquals(sdk.length, 1, `${report}: one SDK instance (got ${sdk.join(", ") || "none"})`);
    const z2j = storeInstances(metafile, "zod-to-json-schema");
    assertEquals(z2j.length, 1, `${report}: one zod-to-json-schema instance (got ${z2j.join(", ") || "none"})`);
    // The package-wide invariant on the real bundle — the gate the build runs.
    assertEquals(duplicateStoreInputs(metafile), {}, `${report}: no same-version duplicate of ANY package`);
  });

  Deno.test(`9epn.3 ${report}: agent-do's MCP path resolves into the same single SDK instance as the extension's, on the same zod`, async () => {
    const metafile = await readBuildReport(report);
    const [sdkInstance] = storeInstances(metafile, "@modelcontextprotocol+sdk");
    assert(sdkInstance, `${report} must carry the SDK`);
    const sdkPrefix = `node_modules/.deno/${sdkInstance}/`;
    // agent-do's MCP client is IN the bundle (positive control: this test
    // cannot pass on a bundle that simply dropped agent-do's mcp.js)…
    const agentDoMcp = Object.entries(metafile.inputs).find(([p]) => p.endsWith("/agent-do/dist/src/mcp.js"));
    assert(agentDoMcp, `${report}: agent-do/dist/src/mcp.js is an input`);
    const agentDoSdkEdges = (agentDoMcp[1].imports ?? []).filter((i) => i.original?.startsWith("@modelcontextprotocol/sdk/"));
    assert(agentDoSdkEdges.length >= 3, `${report}: agent-do's mcp.js imports the SDK client, sse and streamableHttp (got ${agentDoSdkEdges.length})`);
    for (const edge of agentDoSdkEdges) {
      assert(edge.path.startsWith(sdkPrefix), `${report}: agent-do's ${edge.original} must resolve into ${sdkInstance}, got ${edge.path}`);
    }
    // …and in the SW the extension's own client resolves into the SAME instance.
    if (report === "bundle-report.json") {
      const capClient = metafile.inputs["extension/lib/mcp-client.js"];
      assert(capClient, "extension/lib/mcp-client.js is an SW input");
      const capEdges = (capClient.imports ?? []).filter((i) => i.original?.startsWith("@modelcontextprotocol/sdk/"));
      assert(capEdges.length >= 3, "lib/mcp-client.js imports the SDK client, sse and streamableHttp");
      for (const edge of capEdges) {
        assert(edge.path.startsWith(sdkPrefix), `lib/mcp-client.js's ${edge.original} must resolve into ${sdkInstance}, got ${edge.path}`);
      }
    }
    // The SDK's zod edges land on the zod store dir agent-do itself uses: one
    // zod for the agent loop and its MCP client (the peer the extension's
    // client was always KAT-proven against).
    const zodDirOf = (p: string) => p.match(/node_modules\/\.deno\/(zod@[^/]+)\//)?.[1] ?? null;
    const agentDoZod = new Set<string>();
    const sdkZod = new Set<string>();
    for (const [input, info] of Object.entries(metafile.inputs)) {
      for (const edge of info.imports ?? []) {
        const z = zodDirOf(edge.path);
        if (!z) continue;
        if (input.includes("/agent-do/")) agentDoZod.add(z);
        if (input.startsWith(sdkPrefix)) sdkZod.add(z);
      }
    }
    assertEquals([...agentDoZod].length, 1, `${report}: agent-do imports exactly one zod store dir (got ${[...agentDoZod].join(", ")})`);
    assertEquals([...sdkZod], [...agentDoZod], `${report}: the SDK's zod peer is agent-do's zod`);
  });
}

Deno.test("2eb5: an oversize REPORT names a symlinked node_modules — and stays silent with a real one", async () => {
  // The environmental-vs-product distinction must cost zero gate runs: a
  // symlinked dependency root measured 688 bytes over budget with source
  // unchanged, so the oversize REPORT must say when that is the case.
  // (Re-anchored by the 74pb owner decision, 2026-10-05: sizes report instead
  // of throwing — the note lives in bundleBudgetReport now. The old
  // throwing pin was proven live by failing this file's first run on the
  // changed module.)
  const root = durableDir("cap-budget-symlink/root");
  const real = durableDir("cap-budget-symlink/real");
  const plain = durableDir("cap-budget-symlink/plain");
  for (const d of [root, real, plain]) await Deno.mkdir(d, { recursive: true }).catch(() => {});
  try {
    // Symlinked dependency root: the note names it (in the REPORT — the call
    // itself no longer throws on size).
    await Deno.symlink(real, `${root}/node_modules`);
    assertEquals(assertBundleBudget({ label: "background/service-worker.js", bytes: 3_000_001, root }), 3_000_001, "an oversize call returns its size (74pb)");
    const symlinkReport = bundleBudgetReport({ label: "background/service-worker.js", bytes: 3_000_001, root });
    assertStringIncludes(symlinkReport, "SYMLINK");
    assertStringIncludes(symlinkReport, "node_modules");
    assertStringIncludes(symlinkReport, "before treating this as product growth");
    // A real node_modules directory: no environmental note.
    await Deno.mkdir(`${plain}/node_modules`, { recursive: true }).catch(() => {});
    const plainReport = bundleBudgetReport({ label: "background/service-worker.js", bytes: 3_000_001, root: plain });
    assert(!plainReport.includes("SYMLINK"), "a real node_modules carries no symlink note");
    // A passing call is untouched in both worlds, and an in-reference size
    // reports nothing at all.
    assertEquals(assertBundleBudget({ label: "background/service-worker.js", bytes: 100, root }), 100);
    assertEquals(bundleBudgetReport({ label: "background/service-worker.js", bytes: 100, root }), "");
  } finally {
    await Deno.remove(durableDir("cap-budget-symlink"), { recursive: true }).catch(() => {});
  }
});

// ── the ycez pin: the SW bundle carries no Emscripten decoder ─────────────────────────────────────
// WHY THE METAFILE AND NOT A SOURCE WALK (ycez / ltkj.2, 2026-09-25): `background/service-worker.js`
// names `options/options.html`, so the source-level reachability walk folds the OPTIONS bundle into the
// SW's reachable set and cannot answer "what is in the SW bundle". The metafile can: it is esbuild's
// own module list for this bundle. With the authority importing the validator and the auditor
// directly, both were SW inputs and the bundle was 3,009,120 against the unchanged 3,000,000 (over
// 9,120); clean main is 2,982,877, and with the options-document broker the SW is 2,984,188.
Deno.test("bundle budget: the service-worker bundle carries no Emscripten decoder (ycez)", async () => {
  const repo = fileURLToPath(new URL("../", import.meta.url));
  const report = join(repo, ".build", "bundle-report.json");
  let metafile: { inputs?: Record<string, unknown> };
  try {
    metafile = JSON.parse(await Deno.readTextFile(report));
  } catch {
    throw new Error(
      `bundle budget: ${report} is missing — run \`npm run build:production\` first. The SW bundle's composition cannot be checked without the metafile the build writes, and a check that cannot read its subject must refuse rather than pass.`,
    );
  }
  const inputs = Object.keys(metafile.inputs ?? {});
  assert(inputs.length > 10, `the metafile must describe the real SW bundle (got ${inputs.length} inputs)`);
  for (const forbidden of ["emscripten-manifest.js", "emscripten-module-audit.js", "emscripten-admission.js"]) {
    assertEquals(
      inputs.some((input) => input.endsWith(forbidden)),
      false,
      `${forbidden} must not be an input of the service-worker bundle: the Store budget cannot carry the decoder, and the contract pins schema-2 validation to the options document (ycez)`,
    );
  }
  // POSITIVE CONTROL: the authority IS an SW input (background/service-worker.js reaches it through
  // lib/tool-exec-preview.js). A metafile that names nothing cannot pass this test by accident.
  assert(
    inputs.some((input) => input.endsWith("wasm-package-authority.js")),
    "the SW bundle must carry the authority — otherwise this exclusion proves nothing",
  );
});

// ── d885.1 bundle composition pins ──────────────────────────────────────────

Deno.test("d885.1 zodCjsInputs: flags .cjs files from zod, passes clean ESM inputs", () => {
  const dirty = { inputs: {
    "node_modules/zod/v4/index.cjs": { bytes: 100 },
    "node_modules/zod/v4/locales/en.cjs": { bytes: 50 },
    "node_modules/zod/v4/index.js": { bytes: 100 },
  } };
  assertEquals(zodCjsInputs(dirty), [
    "node_modules/zod/v4/index.cjs",
    "node_modules/zod/v4/locales/en.cjs",
  ]);
  const clean = { inputs: {
    "node_modules/zod/v4/index.js": { bytes: 100 },
    "node_modules/zod/v4/core/schemas.js": { bytes: 100 },
  } };
  assertEquals(zodCjsInputs(clean), []);
  assertEquals(zodCjsInputs(null), []);
});

Deno.test("bundle budget: zero .cjs inputs from zod in service-worker.js and agent-worker.js (d885.1)", async () => {
  const repo = fileURLToPath(new URL("../", import.meta.url));
  const swReportPath = join(repo, ".build", "bundle-report.json");
  const workerReportPath = join(repo, ".build", "bundle-report-worker.json");

  let swMeta: { inputs?: Record<string, unknown> };
  let workerMeta: { inputs?: Record<string, unknown> };
  try {
    swMeta = JSON.parse(await Deno.readTextFile(swReportPath));
    workerMeta = JSON.parse(await Deno.readTextFile(workerReportPath));
  } catch {
    throw new Error(
      `bundle budget: metafile reports are missing — run \`npm run build:production\` first.`,
    );
  }

  const swInputs = Object.keys(swMeta.inputs ?? {});
  const workerInputs = Object.keys(workerMeta.inputs ?? {});

  assert(swInputs.length > 10, `swMeta must describe real SW bundle (got ${swInputs.length})`);
  assert(workerInputs.length > 10, `workerMeta must describe real worker bundle (got ${workerInputs.length})`);

  // Assertion 1: Zero .cjs inputs from zod exist in service-worker.js or agent-worker.js metafile inputs
  const swZodCjs = swInputs.filter((p) => p.includes("zod") && p.endsWith(".cjs"));
  assertEquals(swZodCjs, [], `service-worker.js must not carry .cjs zod inputs (found: ${swZodCjs.join(", ")})`);

  const workerZodCjs = workerInputs.filter((p) => p.includes("zod") && p.endsWith(".cjs"));
  assertEquals(workerZodCjs, [], `agent-worker.js must not carry .cjs zod inputs (found: ${workerZodCjs.join(", ")})`);

  // Positive controls: zod ESM (.js) inputs MUST be present
  assert(swInputs.some((p) => p.includes("zod") && p.endsWith(".js")), "service-worker.js must carry ESM zod inputs");
  assert(workerInputs.some((p) => p.includes("zod") && p.endsWith(".js")), "agent-worker.js must carry ESM zod inputs");
});

Deno.test("bundle budget: options.bundle.js does NOT include provider.js or durable-runs.js (d885.1)", async () => {
  const repo = fileURLToPath(new URL("../", import.meta.url));
  const optReportPath = join(repo, ".build", "bundle-report-options.json");

  let optMeta: { inputs?: Record<string, unknown> };
  try {
    optMeta = JSON.parse(await Deno.readTextFile(optReportPath));
  } catch {
    throw new Error(
      `bundle budget: ${optReportPath} is missing — run \`npm run build:production\` first.`,
    );
  }

  const optInputs = Object.keys(optMeta.inputs ?? {});
  assert(optInputs.length > 10, `options metafile must describe real options bundle (got ${optInputs.length})`);

  // Assertion 2: options.bundle.js metafile inputs do NOT include extension/lib/provider.js or extension/lib/durable-runs.js
  assertEquals(
    optInputs.some((p) => p.endsWith("extension/lib/provider.js") || p.endsWith("lib/provider.js")),
    false,
    "options.bundle.js must NOT include provider.js (AI SDK model layer isolation)",
  );
  assertEquals(
    optInputs.some((p) => p.endsWith("extension/lib/durable-runs.js") || p.endsWith("lib/durable-runs.js")),
    false,
    "options.bundle.js must NOT include durable-runs.js (SW store isolation)",
  );

  // Positive controls: options bundle carries provider-catalog.js and agent-projection.js
  assert(
    optInputs.some((p) => p.endsWith("extension/lib/provider-catalog.js") || p.endsWith("lib/provider-catalog.js")),
    "options.bundle.js must carry provider-catalog.js",
  );
  assert(
    optInputs.some((p) => p.endsWith("extension/lib/agent-projection.js") || p.endsWith("lib/agent-projection.js")),
    "options.bundle.js must carry agent-projection.js",
  );
});

Deno.test("bundle budget: ntp.bundle.js does NOT include durable-runs.js (d885.1)", async () => {
  const repo = fileURLToPath(new URL("../", import.meta.url));
  const ntpReportPath = join(repo, ".build", "bundle-report-ntp.json");

  let ntpMeta: { inputs?: Record<string, unknown> };
  try {
    ntpMeta = JSON.parse(await Deno.readTextFile(ntpReportPath));
  } catch {
    throw new Error(
      `bundle budget: ${ntpReportPath} is missing — run \`npm run build:production\` first.`,
    );
  }

  const ntpInputs = Object.keys(ntpMeta.inputs ?? {});
  assert(ntpInputs.length > 10, `ntp metafile must describe real ntp bundle (got ${ntpInputs.length})`);

  // Assertion 3: ntp.bundle.js metafile inputs do NOT include extension/lib/durable-runs.js
  assertEquals(
    ntpInputs.some((p) => p.endsWith("extension/lib/durable-runs.js") || p.endsWith("lib/durable-runs.js")),
    false,
    "ntp.bundle.js must NOT include durable-runs.js (SW store isolation)",
  );

  // Positive control: ntp bundle carries agent-projection.js
  assert(
    ntpInputs.some((p) => p.endsWith("extension/lib/agent-projection.js") || p.endsWith("lib/agent-projection.js")),
    "ntp.bundle.js must carry agent-projection.js",
  );
});

// ── chrome-agent-platform-9epn.7: tree-shake @ai-sdk/gateway from store SW/worker ───

Deno.test("bundle budget: store service-worker and worker metafiles contain zero @ai-sdk/gateway or @vercel/oidc inputs (9epn.7)", async () => {
  const repo = fileURLToPath(new URL("../", import.meta.url));
  const swReportPath = join(repo, ".build", "bundle-report.json");
  const workerReportPath = join(repo, ".build", "bundle-report-worker.json");

  let swMeta: { inputs?: Record<string, unknown> };
  let workerMeta: { inputs?: Record<string, unknown> };
  try {
    swMeta = JSON.parse(await Deno.readTextFile(swReportPath));
    workerMeta = JSON.parse(await Deno.readTextFile(workerReportPath));
  } catch {
    throw new Error(
      `bundle budget: metafile reports are missing — run \`npm run build:production\` first.`,
    );
  }

  const swInputs = Object.keys(swMeta.inputs ?? {});
  const workerInputs = Object.keys(workerMeta.inputs ?? {});

  assert(swInputs.length > 10, `swMeta must describe real SW bundle (got ${swInputs.length})`);
  assert(workerInputs.length > 10, `workerMeta must describe real worker bundle (got ${workerInputs.length})`);

  // Assertion: @ai-sdk/gateway and @vercel/oidc inputs are absent in store builds
  const swForbidden = swInputs.filter((p) => p.includes("@ai-sdk/gateway") || p.includes("@vercel/oidc"));
  assertEquals(swForbidden, [], `service-worker.js must not carry @ai-sdk/gateway or @vercel/oidc inputs (found: ${swForbidden.join(", ")})`);

  const workerForbidden = workerInputs.filter((p) => p.includes("@ai-sdk/gateway") || p.includes("@vercel/oidc"));
  assertEquals(workerForbidden, [], `agent-worker.js must not carry @ai-sdk/gateway or @vercel/oidc inputs (found: ${workerForbidden.join(", ")})`);

  // Positive control: ai package IS present
  assert(swInputs.some((p) => p.includes("/ai/")), "service-worker.js must carry ai package inputs");
  assert(workerInputs.some((p) => p.includes("/ai/")), "agent-worker.js must carry ai package inputs");
});

Deno.test("bundle budget: @ai-sdk/gateway stub throws GatewayDisabledError (9epn.7)", async () => {
  const { gateway, createGateway, GatewayDisabledError, GatewayError } = await import("../scripts/stubs/gateway-stub.mjs");
  const err = assertThrows(() => gateway(), GatewayDisabledError, "@ai-sdk/gateway is disabled in store builds");
  assertEquals(err.code, "gateway_disabled_in_extension");
  assertThrows(() => createGateway(), GatewayDisabledError, "@ai-sdk/gateway is disabled in store builds");
  assert(new GatewayDisabledError() instanceof GatewayError);
});

Deno.test("bundle budget: @vercel/oidc stub throws VercelOidcDisabledError (9epn.7)", async () => {
  const {
    getContext,
    getVercelOidcToken,
    getVercelOidcTokenSync,
    getVercelToken,
    VercelOidcDisabledError,
  } = await import("../scripts/stubs/vercel-oidc-stub.mjs");

  const err = await assertRejects(() => getVercelOidcToken(), VercelOidcDisabledError);
  assertEquals(err.code, "vercel_oidc_disabled_in_extension");

  const syncErr = assertThrows(() => getContext(), VercelOidcDisabledError);
  assertEquals(syncErr.code, "vercel_oidc_disabled_in_extension");

  const syncTokenErr = assertThrows(() => getVercelOidcTokenSync(), VercelOidcDisabledError);
  assertEquals(syncTokenErr.code, "vercel_oidc_disabled_in_extension");

  await assertRejects(() => getVercelToken(), VercelOidcDisabledError);
});

// ── chrome-agent-platform-9epn.5: bundled surface entries ───────────────────

Deno.test("9epn.5 surfaces are bundled: HTML documents and dynamic imports load dist/ bundles, not raw components.js", async () => {
  const artifactsHtml = await Deno.readTextFile("extension/artifacts/index.html");
  const artifactHtml = await Deno.readTextFile("extension/artifact/artifact.html");
  const directoryHtml = await Deno.readTextFile("extension/directory/directory.html");
  const privacyHtml = await Deno.readTextFile("extension/privacy/privacy.html");
  const offscreenHtml = await Deno.readTextFile("extension/offscreen/offscreen.html");
  const userWasmPanelJs = await Deno.readTextFile("extension/options/user-wasm-panel.js");

  // None of the four pages loads raw components.js directly in HTML
  for (const [name, html] of [
    ["artifacts", artifactsHtml],
    ["artifact", artifactHtml],
    ["directory", directoryHtml],
    ["privacy", privacyHtml],
  ]) {
    assert(
      !html.includes('src="../shared/components.js"'),
      `${name} must not load raw components.js directly (bundled into dist/ instead)`,
    );
  }

  // Each page references its pre-bundled dist/ script
  assertStringIncludes(artifactsHtml, 'src="../dist/artifacts.bundle.js"');
  assertStringIncludes(artifactHtml, 'src="../dist/artifact.bundle.js"');
  assertStringIncludes(directoryHtml, 'src="../dist/directory.bundle.js"');
  assertStringIncludes(privacyHtml, 'src="../dist/privacy.bundle.js"');
  assertStringIncludes(offscreenHtml, 'src="../dist/offscreen.bundle.js"');
  assertStringIncludes(userWasmPanelJs, 'dist/user-wasm-store-client.bundle.js');
  assert(!userWasmPanelJs.includes('lib/user-wasm-store-client.js'));

  // Each of the four HTML documents loads <= 2 script tags total
  for (const [name, html] of [
    ["artifacts", artifactsHtml],
    ["artifact", artifactHtml],
    ["directory", directoryHtml],
    ["privacy", privacyHtml],
  ]) {
    const scripts = html.match(/<script\b[^>]*>/gi) ?? [];
    assert(
      scripts.length <= 2,
      `${name} must have <= 2 script tags (found ${scripts.length})`,
    );
  }
});

Deno.test("9epn.5 bundle budget: offscreen.bundle.js <= 250 KB minified and all surface bundles have metafile reports", async () => {
  const repo = fileURLToPath(new URL("../", import.meta.url));
  const offscreenBundle = join(repo, "extension", "dist", "offscreen.bundle.js");

  try {
    const stat = await Deno.stat(offscreenBundle);
    assert(
      stat.size <= 250_000,
      `offscreen.bundle.js must be <= 250 KB minified (actual: ${stat.size} bytes)`,
    );
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      throw new Error(`dist/offscreen.bundle.js missing — run npm run build:production first`);
    }
    throw e;
  }

  // All 6 surface bundles have generated metafile reports
  const surfaceNames = [
    "artifacts",
    "artifact",
    "directory",
    "privacy",
    "offscreen",
    "user-wasm-store-client",
  ];
  for (const name of surfaceNames) {
    const reportPath = join(repo, ".build", `bundle-report-${name}.json`);
    const meta = JSON.parse(await Deno.readTextFile(reportPath));
    const inputs = Object.keys(meta.inputs ?? {});
    assert(inputs.length >= 1, `metafile report for ${name} must describe its inputs`);
  }
});

Deno.test("9epn.5 dynamic evaluator gate covers all surface bundles without dynamic evaluators", async () => {
  const repo = fileURLToPath(new URL("../", import.meta.url));
  const bundles = [
    "artifacts.bundle.js",
    "artifact.bundle.js",
    "directory.bundle.js",
    "privacy.bundle.js",
    "offscreen.bundle.js",
    "user-wasm-store-client.bundle.js",
  ];

  for (const b of bundles) {
    const bundlePath = join(repo, "extension", "dist", b);
    const source = await Deno.readTextFile(bundlePath);
    assertNoDynamicEvaluators(source, b);
  }
});

Deno.test("9epn.5 self-contained single bundles: zero runtime relative imports to ../lib/ or ../shared/ (1 JS file instead of 18–22 unbundled requests)", async () => {
  const repo = fileURLToPath(new URL("../", import.meta.url));
  const surfaceBundles = [
    "artifacts.bundle.js",
    "directory.bundle.js",
    "artifact.bundle.js",
    "privacy.bundle.js",
    "offscreen.bundle.js",
  ];

  for (const bundleName of surfaceBundles) {
    const bundlePath = join(repo, "extension", "dist", bundleName);
    const source = await Deno.readTextFile(bundlePath);

    // Verify bundle has zero runtime import statements targeting relative lib/ or shared/ modules
    const relativeImportPattern = /(?:import|export)\s+(?:(?:[\w*\s{},]*)\s+from\s+)?["'](\.\.\/(?:lib|shared)\/[^"']+)["']/g;
    const matches = [...source.matchAll(relativeImportPattern)].map((m) => m[1]);
    assertEquals(
      matches,
      [],
      `${bundleName} must not contain relative imports to ../lib/ or ../shared/ (found: ${matches.join(", ")})`,
    );

    // Also check dynamic import(...) expressions targeting ../lib/ or ../shared/
    const dynamicImportPattern = /import\s*\(\s*["'](\.\.\/(?:lib|shared)\/[^"']+)["']\s*\)/g;
    const dynamicMatches = [...source.matchAll(dynamicImportPattern)].map((m) => m[1]);
    assertEquals(
      dynamicMatches,
      [],
      `${bundleName} must not contain dynamic relative imports to ../lib/ or ../shared/ (found: ${dynamicMatches.join(", ")})`,
    );

    // Metafile output verification: verify from esbuild metafile that output declares zero external imports to lib/ or shared/
    const reportName = bundleName.replace(".bundle.js", "");
    const reportPath = join(repo, ".build", `bundle-report-${reportName}.json`);
    const meta = JSON.parse(await Deno.readTextFile(reportPath));
    for (const output of Object.values(meta.outputs ?? {}) as any[]) {
      const externalImports = (output.imports ?? []).filter((imp: any) =>
        imp.kind === "import-statement" && (imp.path.includes("lib/") || imp.path.includes("shared/"))
      );
      assertEquals(
        externalImports,
        [],
        `${bundleName} metafile outputs must declare 0 imports to lib/ or shared/`,
      );
    }
  }
});

Deno.test("bd06: build.mjs auto-materializes node_modules/.deno via deno install before resolving canonical dependencies", async () => {
  const source = await Deno.readTextFile("extension/../build.mjs");

  // 1. Order pin: checking/materializing denoStoreDir MUST happen BEFORE
  // requireFromRoot / CANON_ANTHROPIC / CANON_PU / CANON_ZOD_V4 / CANON_ZOD_DIR.
  // If npm ci/install wiped node_modules/.deno, resolving before deno install
  // would resolve CANON_* to flat node_modules/ instead of node_modules/.deno/,
  // or readdirSync(denoStoreDir) would throw raw ENOENT.
  const denoInstallCheck = source.indexOf('execFileSync("deno", ["install"]');
  const requireFromRootPos = source.indexOf('createRequire(path.join(ROOT, "package.json"))');
  const canonAnthropicPos = source.indexOf('CANON_ANTHROPIC = resolveCanonical("@ai-sdk/anthropic"');
  const canonZodDirPos = source.indexOf('CANON_ZOD_DIR = realpathSync(path.join(ROOT, "node_modules", "zod"))');

  assert(denoInstallCheck !== -1, "build.mjs must contain automatic deno install invocation");
  assert(requireFromRootPos !== -1, "build.mjs must define requireFromRoot");
  assert(canonAnthropicPos !== -1, "build.mjs must define CANON_ANTHROPIC");
  assert(canonZodDirPos !== -1, "build.mjs must define CANON_ZOD_DIR");

  assert(
    denoInstallCheck < requireFromRootPos,
    "deno install auto-materialization must run BEFORE createRequire/requireFromRoot",
  );
  assert(
    denoInstallCheck < canonAnthropicPos,
    "deno install auto-materialization must run BEFORE resolving CANON_ANTHROPIC",
  );
  assert(
    denoInstallCheck < canonZodDirPos,
    "deno install auto-materialization must run BEFORE resolving CANON_ZOD_DIR",
  );

  // 2. Fails closed with cap-deno-store-resolve if deno install fails or store missing
  assertStringIncludes(
    source,
    "cap-deno-store-resolve:",
    "build.mjs must surface cap-deno-store-resolve on failure instead of raw ENOENT",
  );
  assertStringIncludes(
    source,
    'startsWith("@modelcontextprotocol+sdk@")',
    "build.mjs must verify @modelcontextprotocol+sdk@* exists in node_modules/.deno",
  );

  // 3. Behavioral simulation: verify that when denoStoreDir is missing and
  // deno install fails, cap-deno-store-resolve is thrown instead of raw ENOENT.
  const simulateBootstrap = (fakeReaddir: (p: string) => string[], fakeExec: () => void) => {
    const store = "/fake/node_modules/.deno";
    let entries: string[] = [];
    try {
      entries = fakeReaddir(store);
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err;
    }
    if (!entries.some((d) => d.startsWith("@modelcontextprotocol+sdk@"))) {
      try {
        fakeExec();
        entries = fakeReaddir(store);
      } catch (err: any) {
        throw new Error(
          `cap-deno-store-resolve: ${store} is missing or incomplete and automatic \`deno install\` failed (${err?.message || err}) — run \`deno install\` and retry.`,
        );
      }
    }
    return entries;
  };

  const err = assertThrows(() =>
    simulateBootstrap(
      () => {
        const e: any = new Error("ENOENT: no such file or directory");
        e.code = "ENOENT";
        throw e;
      },
      () => {
        throw new Error("deno: command not found");
      },
    )
  );
  assertStringIncludes(err.message, "cap-deno-store-resolve:");
  assertStringIncludes(err.message, "automatic `deno install` failed");
});



// chrome-agent-platform-o2t3. The gap this closes was structural, not a typo:
// build.mjs declared `budget:` for six secondary surface bundles that neither
// STORE_BUNDLE_BUDGETS (which the build's reporting loop iterates) nor
// DIST_COMPLETE_OUTPUTS knew about, so they could neither be observed to grow nor
// lose their recorded hash. Two pins, because the two halves fail differently:
//   1. every budget build.mjs DECLARES is a budget this table REPORTS, at the same
//      ceiling — a new bundle cannot land size-unreported;
//   2. every bundle the store ARCHIVES is RECORDED in the marker — a shipped bundle
//      cannot silently drop out of dist.complete.
Deno.test("o2t3: the declared budgets and the reported/marked bundle sets cannot drift apart", async () => {
  const buildSrc = await Deno.readTextFile(new URL("../build.mjs", import.meta.url));
  const decls = [...buildSrc.matchAll(/\{\s*name:\s*"([^"]+)"[^}]*?out:\s*"([^"]+)"[^}]*?budget:\s*([0-9_]+)\s*\}/gs)]
    .map((m) => ({ name: m[1], out: m[2], budget: Number(m[3].replace(/_/g, "")) }));

  // A parse that silently matches nothing would make every assertion below vacuous.
  assert(decls.length > 0, "build.mjs must declare at least one bundle budget for this pin to mean anything");
  assert(
    decls.length >= 6,
    `build.mjs declares the six secondary surface budgets (parsed ${decls.length}: ${decls.map((d) => d.out).join(", ")})`,
  );

  for (const { name, out, budget } of decls) {
    assertEquals(
      STORE_BUNDLE_BUDGETS[out],
      budget,
      `${out} (surface "${name}") declares a budget in build.mjs, so STORE_BUNDLE_BUDGETS must report it at the SAME ceiling`,
    );
    assert(
      DIST_COMPLETE_OUTPUTS.includes(out),
      `${out} is a shipped dist output, so the marker must record its size and hash`,
    );
  }

  // The marker half, from the list that already knew the truth: BUNDLE_ARCHIVE_MAP
  // maps every bundle into the store archive.
  const archived = [...BUNDLE_ARCHIVE_MAP.keys()].map((k) => k.replace(/^dist\//u, ""));
  const unrecorded = archived.filter((p) => !DIST_COMPLETE_OUTPUTS.includes(p));
  assertEquals(
    unrecorded,
    [],
    "every bundle the store archives must be recorded in the dist marker (a shipped bundle with no recorded size or hash is the o2t3 gap)",
  );
});
