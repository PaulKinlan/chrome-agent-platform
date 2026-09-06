// @ts-nocheck
// The offscreen WASI-job lane runs every admitted default-tier tool
// (chrome-agent-platform-az4k).
//
// ten9 opened the job lane for every non-stream bundled tool, but the job it
// built hardcoded tier "tiny" (tool-exec-preview.js buildPreviewJob) and the
// offscreen worker audits the binary against THAT tier's ceiling (512 pages).
// The shipped compressops (y75s) and zxing (2htn) declare the default tier
// (2048 pages): both were admitted, findable, dispatched — and refused by the
// worker with phase "memory-rejected" on every live run. Nobody saw it because
// the ten9 KAT drives only tiny-tier tools through the lane and the admission
// tests run the stream worker.
//
// This is the dispatch-check canon for every future admission: drive the REAL
// job-worker entry (runWorkerJob, the same function the offscreen Worker runs)
// over the REAL CAS bytes with the job built EXACTLY as the service worker
// builds it (buildPreviewJob) — no Chrome, no fakes between the request and
// the binary.
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { runWorkerJob } from "../extension/lib/wasm-execution-worker.js";
import {
  buildPreviewAuthority,
  buildPreviewJob,
  isStreamBackedBundledTool,
  PREVIEW_SPECS,
  validatePreviewInput,
} from "../extension/lib/tool-exec-preview.js";
import { createWasiJob } from "../extension/lib/wasm-host-types.js";
import { WASM_PACKAGE_LIMITS } from "../extension/lib/wasm-package-authority.js";
import { BUNDLED_TOOL_PACKAGE_ROWS } from "../extension/lib/bundled-tool-packages.data.js";

const authority = buildPreviewAuthority({ origin: "https://agent.cap", documentId: "job-lane-tier", now: () => 1 });

/** The stdin each tool's validator accepts (sqlite's is a JSON shape). */
function stdinFor(toolId) {
  if (toolId === "sqlite3_query_bounded") {
    return JSON.stringify({ sql: "SELECT 1", params: [], database: "test.db", readOnly: true });
  }
  return "";
}

/** Every admitted tool that dispatches through the job lane: not stream-backed,
 *  not call-export. */
function jobLaneRows() {
  return BUNDLED_TOOL_PACKAGE_ROWS.filter((row) =>
    row.admitted === true && row.callexport !== true && !isStreamBackedBundledTool(row.toolId)
  );
}

/** Drive the real worker entry; the respond payload carries phase/error at
 *  its top level (result is the separate stdout envelope). */
async function runThroughWorker(row, job) {
  const wasmBytes = await Deno.readFile(`extension/wasm/cas/${row.binary.sha256}.wasm`);
  let outcome = null;
  await runWorkerJob({ sessionId: "s", job, wasmBytes, post: () => {}, respond: (r) => { outcome = r; } });
  return { phase: String(outcome?.phase ?? "?"), error: String(outcome?.error ?? "") };
}

/** Re-derive a job from a built one with a different tier: buildPreviewJob
 *  returns a frozen job whose stdin is a plain array; createWasiJob wants the
 *  bytes as a Uint8Array. Everything else rides through unchanged. */
function withTier(job, tier) {
  return createWasiJob({ ...job, stdin: new Uint8Array(job.stdin), tier });
}

Deno.test("az4k: the job lane carries each tool's DECLARED tier — every admitted job-lane tool runs, none is memory-rejected", async () => {
  const rows = jobLaneRows();
  assert(rows.length >= 20, `the job lane serves the non-stream tools (${rows.length})`);
  const defaultTier = rows.filter((r) => r.binary.tier === "default").map((r) => r.toolId).sort();
  assert(defaultTier.length >= 2, `default-tier job-lane tools exist to prove the class on (${defaultTier})`);
  const refused = [];
  const ran = [];
  for (const row of rows) {
    const job = buildPreviewJob({
      input: validatePreviewInput({ toolId: row.toolId, args: [], stdin: stdinFor(row.toolId) }),
      authority,
    });
    assertEquals(job.tier, row.binary.tier, `${row.toolId}: the job carries the tool's declared tier`);
    const { phase, error } = await runThroughWorker(row, job);
    if (phase === "memory-rejected" || phase === "import-rejected" || phase === "compile-bounded" || phase === "instantiation-error") {
      refused.push(`${row.toolId} (declared ${row.binary.tier}/${row.binary.maxPages}): ${phase} ${error}`);
    } else {
      ran.push(row.toolId);
    }
  }
  assertEquals(refused, [], "an admitted tool was refused by the job worker before it ran — the lane must carry the declared tier");
  for (const toolId of defaultTier) assert(ran.includes(toolId), `${toolId} (default tier) actually ran through the job worker`);
});

Deno.test("az4k detector honesty: the worker STILL enforces the ceiling — a default-tier binary under a tiny-tier job is memory-rejected", async () => {
  const row = jobLaneRows().find((r) => r.binary.tier === "default");
  assert(row, "a default-tier job-lane tool exists");
  const declared = buildPreviewJob({ input: validatePreviewInput({ toolId: row.toolId, args: [], stdin: "" }), authority });
  // The same job, with the tier forced back to what buildPreviewJob used to hardcode.
  const forcedTiny = withTier(declared, "tiny");
  const { phase, error } = await runThroughWorker(row, forcedTiny);
  assertEquals(phase, "memory-rejected", `${row.toolId}: the audit fires when the tier does not cover the binary (${error})`);
  assert(/memory_exceeds_ceiling/.test(error), `the refusal names the ceiling: ${error}`);
});

Deno.test("az4k: the spec's tier is the generated row's declared tier — spec authority, never request-borne — and large stays refused", () => {
  for (const [toolId, spec] of Object.entries(PREVIEW_SPECS)) {
    const row = BUNDLED_TOOL_PACKAGE_ROWS.find((r) => r.toolId === toolId);
    assertEquals(spec.tier, row.binary.tier, `${toolId}: spec.tier == row.binary.tier`);
    assertEquals(spec.maxPages, row.binary.maxPages, `${toolId}: spec.maxPages == row.binary.maxPages`);
    assert(spec.tier === "tiny" || spec.tier === "default", `${toolId}: only the two lane tiers are admitted (${spec.tier})`);
    assert(spec.maxPages <= WASM_PACKAGE_LIMITS.TIERS[spec.tier].maxPages, `${toolId}: declared max within its tier`);
  }
  // The request cannot pick a tier: validatePreviewInput only admits toolId/args/stdin.
  assertThrows(
    () => validatePreviewInput({ toolId: "compressops", args: [], stdin: "", tier: "large" }),
    Error,
    undefined,
    "a request carrying a tier is refused (the shape is exact)",
  );
  // The large tier is never a job tier, whatever a spec said.
  const declared = buildPreviewJob({ input: validatePreviewInput({ toolId: "compressops", args: [], stdin: "" }), authority });
  assertThrows(() => withTier(declared, "large"), Error, "job_tier", "large is refused at the job boundary");
  // …and the re-derivation itself is sound: the two lane tiers round-trip.
  assertEquals(withTier(declared, "default").tier, "default");
  assertEquals(withTier(declared, "tiny").tier, "tiny");
});
