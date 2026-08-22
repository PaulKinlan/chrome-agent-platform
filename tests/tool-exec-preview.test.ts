// @ts-nocheck — adversarial mutant checks + dynamic shapes.
// Source tests for the Settings-only bounded Wasm tool preview
// (CAP-FB-20260822-TOOL-PREVIEW-EXEC-01): strict bounded request, host-bound
// fences, and the immutable manifest/CAS/imports/memory/caps revalidation
// against the REAL shipped bundled csvtool bytes. No Chrome.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  PREVIEW_LIMITS,
  PREVIEW_PACKAGE_ID,
  PREVIEW_TOOL_ID,
  boundPreviewResult,
  buildPreviewAuthority,
  buildPreviewJob,
  revalidateCsvtoolExecution,
  validatePreviewInput,
} from "../extension/lib/tool-exec-preview.js";
import { BUNDLED_INVENTORY } from "../extension/lib/bundled-inventory-data.js";
import { BUNDLED_TOOL_PACKAGE_ROWS } from "../extension/lib/bundled-tool-packages.data.js";

const root = (rel: string): string => new URL(`../${rel}`, import.meta.url).pathname;

async function realCsvtoolAssets() {
  const manifestText = await Deno.readTextFile(
    root("extension/wasm/manifests/cap.bundled.csvtool-1.0.0.manifest.json"),
  );
  const casBytes = new Uint8Array(
    await Deno.readFile(
      root("extension/wasm/cas/5c8210c93d390893f961943093ccad314e87500b29eafe9f166b0b3327333d81.wasm"),
    ),
  );
  return { manifestText, casBytes };
}

Deno.test("preview: strict exact-key bounded request (args + stdin only)", () => {
  assertEquals(validatePreviewInput({ args: ["--strip"], stdin: "a,b\n1,2" }).args, ["--strip"]);
  assertEquals(validatePreviewInput({ args: [], stdin: "" }).stdin, "");
  for (const bad of [
    null, "x", { args: [] }, { stdin: "" }, { args: [], stdin: "", extra: 1 },
    { args: ["x".repeat(PREVIEW_LIMITS.maxArgBytes + 1)], stdin: "" },
    { args: Array.from({ length: PREVIEW_LIMITS.maxArgs + 1 }, () => "a"), stdin: "" },
    { args: ["a\u0000b"], stdin: "" },
    { args: [], stdin: "x".repeat(PREVIEW_LIMITS.maxStdinBytes + 1) },
    { args: ["a".repeat(600), "b".repeat(600)], stdin: "" }, // total arg bytes
  ]) {
    let threw = null;
    try { validatePreviewInput(bad); } catch (e) { threw = (e as { code?: string }).code ?? null; }
    assert(threw !== null, `expected rejection for ${JSON.stringify(bad)}`);
  }
});

Deno.test("preview: authority fences are synthesized + exact-key", () => {
  const authority = buildPreviewAuthority({ origin: "https://settings.cap" });
  for (const key of ["sessionId", "executionId", "callId", "agentId", "origin", "documentId"]) {
    assert(typeof authority[key] === "string" && authority[key].length > 0, key);
  }
  assertEquals(authority.agentId, "settings-owner");
  assertEquals(authority.origin, "https://settings.cap");
  // distinct per call
  const second = buildPreviewAuthority({ origin: "https://settings.cap" });
  assert(authority.sessionId !== second.sessionId);
  assert(authority.executionId !== second.executionId);
});

Deno.test("preview: the bounded job binds the authority fences", () => {
  const authority = buildPreviewAuthority({ origin: "https://settings.cap" });
  const job = buildPreviewJob({ input: { args: [], stdin: "a,b\n1,2" }, authority });
  assertEquals(job.context.executionId, authority.executionId);
  assertEquals(job.context.callId, authority.callId);
  assertEquals(job.context.origin, authority.origin);
  assertEquals(job.tier, "tiny");
  assertEquals([...job.stdin].length, "a,b\n1,2".length);
  // quota is bounded by the preview limits
  assertEquals(job.quota.stdinBytes, PREVIEW_LIMITS.maxStdinBytes);
  // a hostile authority (extra key / wrong origin) fails closed
  let threw = null;
  try {
    buildPreviewJob({
      input: { args: [], stdin: "" },
      authority: { ...authority, evil: 1 },
    });
  } catch (e) { threw = (e as { code?: string }).code ?? null; }
  assert(threw === "preview_authority", "extra authority key fails closed");
});

Deno.test("preview: immutable revalidation passes on the REAL shipped csvtool bytes", async () => {
  const { manifestText, casBytes } = await realCsvtoolAssets();
  const revalidated = await revalidateCsvtoolExecution({
    manifestText,
    casBytes,
    inventory: BUNDLED_INVENTORY,
  });
  assertEquals(revalidated.ok, true);
  assertEquals(revalidated.casSha256, "5c8210c93d390893f961943093ccad314e87500b29eafe9f166b0b3327333d81");
  assertEquals(revalidated.casSize, 10581);
  assertEquals(revalidated.executable.id, PREVIEW_TOOL_ID);
  assertEquals(revalidated.memory.tier, "tiny");
  assertEquals(revalidated.capabilities.join(","), "compute,text.transform");
});

Deno.test("preview: revalidation fails closed on every mutant (sha/size/imports/memory/caps/inventory)", async () => {
  const { manifestText, casBytes } = await realCsvtoolAssets();
  // 1. CAS sha mismatch (one byte flipped)
  const flipped = new Uint8Array(casBytes);
  flipped[20] ^= 0x01;
  let threw = null;
  try {
    await revalidateCsvtoolExecution({ manifestText, casBytes: flipped, inventory: BUNDLED_INVENTORY });
  } catch (e) { threw = (e as { code?: string }).code ?? null; }
  assertEquals(threw, "preview_cas_sha", "flipped CAS bytes fail closed");
  // 2. CAS size mismatch
  threw = null;
  try {
    await revalidateCsvtoolExecution({
      manifestText,
      casBytes: new Uint8Array(casBytes.slice(0, casBytes.byteLength - 1)),
      inventory: BUNDLED_INVENTORY,
    });
  } catch (e) { threw = (e as { code?: string }).code ?? null; }
  assertEquals(threw, "preview_cas_size", "truncated CAS fails closed");
  // 3. Manifest drift vs the immutable inventory (a mutated manifest)
  const driftedManifest = manifestText.replace(
    '"toolchain":"clang 22.1.8; LLD 22.1.8"',
    '"toolchain":"clang 99.9.9"',
  );
  threw = null;
  try {
    await revalidateCsvtoolExecution({ manifestText: driftedManifest, casBytes, inventory: BUNDLED_INVENTORY });
  } catch (e) { threw = (e as { code?: string }).code ?? null; }
  assert(["preview_manifest_drift", "preview_manifest_invalid"].includes(threw), `drift fails closed: ${threw}`);
  // 4. An executable-capability mutant (adds a capability)
  const capsMutant = manifestText.replace(
    '"capabilities":["compute","text.transform"]',
    '"capabilities":["compute","text.transform","file.write"]',
  );
  threw = null;
  try {
    await revalidateCsvtoolExecution({ manifestText: capsMutant, casBytes, inventory: null });
  } catch (e) { threw = (e as { code?: string }).code ?? null; }
  assert(
    ["preview_capabilities", "preview_manifest_invalid"].includes(threw ?? ""),
    `capability mutant fails closed: ${threw}`,
  );
  // 5. A non-preview package identity
  const wrongPkg = manifestText.replace(PREVIEW_PACKAGE_ID, "cap.bundled.evil");
  threw = null;
  try {
    await revalidateCsvtoolExecution({ manifestText: wrongPkg, casBytes, inventory: null });
  } catch (e) { threw = (e as { code?: string }).code ?? null; }
  assertEquals(threw, "preview_package_identity", "wrong package identity fails closed");
});

Deno.test("preview: the result envelope is bounded (never unbounded bytes)", () => {
  const ok = boundPreviewResult({ ok: true, phase: "completed", exitCode: 0, stdout: "a,b\n1,2", stderr: "", errno: null, error: null });
  assertEquals(ok.ok, true);
  assertEquals(ok.stdout, "a,b\n1,2");
  const failed = boundPreviewResult({ ok: false, phase: "proc-exit", exitCode: 1, stdout: "", stderr: "", errno: 0, error: "boom" });
  assertEquals(failed.ok, false);
  assertEquals(failed.error, "boom");
  // hostile shapes fail closed
  for (const bad of [null, "x", { ok: true }, { ok: true, stdout: "x".repeat(300 * 1024) }]) {
    let threw = null;
    try { boundPreviewResult(bad); } catch (e) { threw = (e as { code?: string }).code ?? null; }
    assert(threw !== null, `expected rejection for ${JSON.stringify(bad)?.slice(0, 40)}`);
  }
});

Deno.test("preview: the csvtool descriptor is the ONLY admitted settings-preview row", () => {
  const admitted = BUNDLED_TOOL_PACKAGE_ROWS.filter((row) => row.admitted === true);
  assertEquals(admitted.length, 1);
  assertEquals(admitted[0].toolId, "csvtool");
  assertEquals(admitted[0].settingsPreview, true);
  assertEquals(admitted[0].disabled, false);
  // The preview limits are honest against the executor's JSON request budget.
  assert(PREVIEW_LIMITS.maxStdinBytes <= 4 * 1024, "stdin stays inside the 64 KiB executor request envelope");
  assert(PREVIEW_LIMITS.wallMs <= 30_000, "wall time stays inside the executor bound");
});
