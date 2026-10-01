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

import { assert, assertEquals, assertStringIncludes, assertThrows } from "jsr:@std/assert@1";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  assertBundleBudget,
  BUDGET_REPORTED_BUNDLES,
  duplicateAiSdkInputs,
  formatContributors,
  nonDenoStoreInputs,
  STORE_SW_BUDGET_BYTES,
  topContributors,
  zodCjsInputs,
} from "../scripts/bundle-budget.mjs";

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

Deno.test("bundle budget: under-budget passes; over-budget throws naming file, actual, budget and contributors", () => {
  assertEquals(assertBundleBudget({ label: "x.js", bytes: 100 }), 100);
  assertEquals(assertBundleBudget({ label: "x.js", bytes: 3_000_000 }), 3_000_000, "the exact boundary passes");

  const metafile = { inputs: { "huge-dep.js": { bytes: 9_999_999 } } };
  const error = assertThrows(() =>
    assertBundleBudget({ label: "background/service-worker.js", bytes: 4_500_000, metafile })
  );
  assertStringIncludes(error.message, "4_500_000".replaceAll("_", ""), "names the actual size");
  assertStringIncludes(error.message, "3000000", "names the budget");
  assertStringIncludes(error.message, "huge-dep.js", "names the top contributor");
  assertStringIncludes(error.message, "service-worker", "names the bundle");

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
  // The gate calls the shared module with the SW size.
  assertStringIncludes(source, 'assertBundleBudget({ label: "background/service-worker.js"');
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

Deno.test("bundle budget: a store-built dist ships a minified SW at or under budget (when present)", async () => {
  // build-bootstrap regenerates dist with --target=store ahead of this file
  // in the serial suite; when the marker says store, the REAL bytes are
  // gated here too (CI-visible). A developer or absent dist skips honestly.
  let marker;
  try {
    marker = JSON.parse(await Deno.readTextFile("extension/dist/dist.complete"));
  } catch {
    return; // no built dist in this environment
  }
  if (marker?.target !== "store") return; // developer build: unminified by design
  const size = (await Deno.stat("extension/dist/background/service-worker.js")).size;
  assert(
    size <= STORE_SW_BUDGET_BYTES,
    `store-built SW bundle is ${size} bytes — over the ${STORE_SW_BUDGET_BYTES} budget`,
  );
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
  assertStringIncludes(error.message, "duplicated same-version AI SDK instances");
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

Deno.test("2eb5: an oversize error names a symlinked node_modules — and stays silent with a real one", async () => {
  // The environmental-vs-product distinction must cost zero gate runs: a
  // symlinked dependency root measured 688 bytes over budget with source
  // unchanged, so the error must say when that is the case.
  const root = durableDir("cap-budget-symlink/root");
  const real = durableDir("cap-budget-symlink/real");
  const plain = durableDir("cap-budget-symlink/plain");
  for (const d of [root, real, plain]) await Deno.mkdir(d, { recursive: true }).catch(() => {});
  try {
    // Symlinked dependency root: the note names it.
    await Deno.symlink(real, `${root}/node_modules`);
    const symlinkError = assertThrows(() =>
      assertBundleBudget({ label: "background/service-worker.js", bytes: 3_000_001, root })
    );
    assertStringIncludes(symlinkError.message, "SYMLINK");
    assertStringIncludes(symlinkError.message, "node_modules");
    assertStringIncludes(symlinkError.message, "before treating this as product growth");
    // A real node_modules directory: no environmental note.
    await Deno.mkdir(`${plain}/node_modules`, { recursive: true }).catch(() => {});
    const plainError = assertThrows(() =>
      assertBundleBudget({ label: "background/service-worker.js", bytes: 3_000_001, root: plain })
    );
    assert(!plainError.message.includes("SYMLINK"), "a real node_modules carries no symlink note");
    // A passing call is untouched in both worlds.
    assertEquals(assertBundleBudget({ label: "background/service-worker.js", bytes: 100, root }), 100);
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
  assertThrows(() => gateway(), GatewayDisabledError, "@ai-sdk/gateway is disabled in store builds");
  assertThrows(() => createGateway(), GatewayDisabledError, "@ai-sdk/gateway is disabled in store builds");
  assert(new GatewayDisabledError() instanceof GatewayError);
});

