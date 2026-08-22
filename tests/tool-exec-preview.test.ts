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
  extractPreviewInput,
  rehydratePreviewStdin,
  rehydratePreviewWasmBytes,
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

Deno.test("preview: the host lives ONLY in the options page — SW-only sender, no offscreen/NTP/content fallback, permissions stay []", async () => {
  const options = await Deno.readTextFile(
    new URL("../extension/options/options.js", import.meta.url),
  );
  const sw = await Deno.readTextFile(
    new URL("../extension/background/service-worker.js", import.meta.url),
  );
  const offscreen = await Deno.readTextFile(
    new URL("../extension/offscreen/offscreen.js", import.meta.url),
  );
  const manifestText = await Deno.readTextFile(
    new URL("../extension/manifest.json", import.meta.url),
  );
  const manifest = JSON.parse(manifestText);
  // 1. The host listener lives in the options page with the unique type.
  assert(options.includes('"wasm.preview.options"'), "the options page hosts the preview listener");
  assert(options.includes('chrome.runtime.onMessage.addListener'), "the listener is a runtime listener");
  // 2. The ONLY accepted sender is the same-extension SW: id exact + no tab.
  assert(options.includes("sender?.id !== chrome.runtime.id || sender?.tab != null"), "the SW-only sender gate is present");
  // 3. It uses the canonical Gate-2 executor + worker (no new Worker literal).
  assert(options.includes('createOffscreenWasmHost'), "the options host uses the reviewed offscreen host contract");
  assert(options.includes('chrome.runtime.getURL("lib/wasm-execution-worker.js")'), "the fresh canonical worker URL");
  // 4. NO offscreen document, NTP or content-script fallback for the preview.
  assert(!offscreen.includes("wasm.preview"), "the offscreen document has no preview listener");
  const routeStart = sw.indexOf('async "tool.preview.csvtool"');
  const routeEnd = sw.indexOf('async "agent.run"', routeStart);
  const routeBody = sw.slice(routeStart, routeEnd > routeStart ? routeEnd : routeStart + 4000);
  assert(!routeBody.includes("ensureOffscreen"), "the preview route never opens an offscreen document");
  assert(!routeBody.includes('type: "wasm.preview\"'), "no old offscreen-target message type");
  assert(!routeBody.includes("ntp"), "no NTP fallback in the preview route");
  // 5. The SW targets the options host + the manifest required permissions stay [].
  assert(sw.includes('type: "wasm.preview.options"'), "the SW route sends to the options host");
  assertEquals(manifest.permissions, [], "required permissions remain [] (least authority)");
});

Deno.test("preview: the route fetches runtime-RELATIVE wasm paths (no extension/ prefix)", async () => {
  // The packaged extension ROOT is the extension/ directory, so the SW must
  // fetch `wasm/...` (runtime-relative), never `extension/wasm/...`.
  const sw = await Deno.readTextFile(
    new URL("../extension/background/service-worker.js", import.meta.url),
  );
  assert(sw.includes('const manifestRel = "wasm/manifests/cap.bundled.csvtool-1.0.0.manifest.json"'), "the manifest rel is runtime-relative");
  assert(sw.includes('const casRel = "wasm/cas/5c8210c93d390893f961943093ccad314e87500b29eafe9f166b0b3327333d81.wasm"'), "the CAS rel is runtime-relative");
  assert(sw.includes("chrome.runtime.getURL(manifestRel)") && sw.includes("chrome.runtime.getURL(casRel)"), "the route fetches via getURL with the rel vars");
  assert(!sw.includes('const manifestRel = "extension/wasm/') && !sw.includes('const casRel = "extension/wasm/'), "no extension/ prefix in the runtime fetch paths");
  assert(!sw.includes('getURL("extension/wasm/'), "no extension/ prefix inside getURL");
});

Deno.test("preview: the wasm-bytes transport rehydrates a valid explicit array + rejects every hostile shape", async () => {
  // The SW sends Array.from(casBytes) (runtime messaging JSON-serializes
  // typed arrays); the options host strictly validates + rehydrates.
  const cas = new Uint8Array(await Deno.readFile(
    new URL("../extension/wasm/cas/5c8210c93d390893f961943093ccad314e87500b29eafe9f166b0b3327333d81.wasm", import.meta.url),
  ));
  const rehydrated = rehydratePreviewWasmBytes(Array.from(cas));
  assertEquals(rehydrated instanceof Uint8Array, true, "a genuine Uint8Array is produced");
  assertEquals(rehydrated.byteLength, cas.byteLength);
  assertEquals(rehydrated[0], 0x00); assertEquals(rehydrated[1], 0x61); // wasm magic survives
  assertEquals(rehydrated[7], 0x00);

  const rejections = {
    "not-an-array": { value: cas },
    "object": { value: { 0: 0, length: 8 } },
    "sparse": { value: Array.from({ length: 8 }) }, // holes → undefined
    "too-short": { value: Array.from(new Uint8Array(7)) },
    "overbound": { value: Array.from(new Uint8Array(64 * 1024 + 1)) },
    "fractional": { value: Array.from(cas.slice(0, 8)).map((b, i) => i === 3 ? 0.5 : b) },
    "negative": { value: Array.from(cas.slice(0, 8)).map((b, i) => i === 3 ? -1 : b) },
    "out-of-range": { value: Array.from(cas.slice(0, 8)).map((b, i) => i === 3 ? 256 : b) },
    "string": { value: Array.from(cas.slice(0, 8)).map((b, i) => i === 3 ? "1" : b) },
  };
  for (const [label, shape] of Object.entries(rejections)) {
    let threw = null;
    try { rehydratePreviewWasmBytes(shape.value); } catch (e) { threw = e.code; }
    assertEquals(threw, "preview_wasm_transport", `${label} must fail closed`);
  }
});

Deno.test("preview: the stdin transport rehydrates a dense byte array + rejects every hostile shape", () => {
  // createWasiJob emits stdin as a FROZEN PLAIN byte array; the options host
  // strictly rehydrates it back to a genuine Uint8Array before handleJob.
  const empty = rehydratePreviewStdin([]);
  assertEquals(empty instanceof Uint8Array, true);
  assertEquals(empty.byteLength, 0, "empty stdin is valid");
  const sample = rehydratePreviewStdin([65, 44, 66, 10]);
  assertEquals(sample instanceof Uint8Array, true);
  assertEquals([...sample].join(","), "65,44,66,10", "the frozen array bytes survive");

  const rejections = {
    "not-array": { value: "a,b" },
    "object": { value: { 0: 65, length: 1 } },
    "sparse": { value: Array.from({ length: 4 }) },
    "overbound": { value: Array.from({ length: PREVIEW_LIMITS.maxStdinBytes + 1 }, () => 0) },
    "fractional": { value: [65, 0.5] },
    "negative": { value: [65, -1] },
    "out-of-range": { value: [65, 256] },
    "string": { value: [65, "1"] },
  };
  for (const [label, shape] of Object.entries(rejections)) {
    let threw = null;
    try { rehydratePreviewStdin(shape.value); } catch (e) { threw = e.code; }
    assertEquals(threw, "preview_stdin_transport", `${label} must fail closed`);
  }
});

Deno.test("preview: route-shaped messages strip ONLY type — extra keys never flow", () => {
  // The runtime route receives the dispatch body WITH `type` (dispatchRoute
  // passes the message body through; the global dispatcher is NOT modified).
  const standard = {
    type: "tool.preview.csvtool",
    args: ["--strip"],
    stdin: "a,b\n1,2",
  };
  const extracted = extractPreviewInput(standard);
  assertEquals(JSON.stringify(Object.keys(extracted).sort()), JSON.stringify(["args", "stdin"]), "only args+stdin are extracted");
  // The strict validator ACCEPTS the extracted standard message (no
  // preview_request_shape from the stray `type` key).
  assertEquals(validatePreviewInput(extracted).args, ["--strip"]);
  // A hostile message with extra keys: the extraction drops them BEFORE the
  // validator — `evil` can never flow to the validator/executor.
  const hostile = {
    type: "tool.preview.csvtool",
    args: [],
    stdin: "",
    evil: 1,
    __authority: { sessionId: "forged" },
    userActivation: true,
    wasmBytes: new Uint8Array(4),
  };
  const hostileExtracted = extractPreviewInput(hostile);
  assertEquals(JSON.stringify(Object.keys(hostileExtracted).sort()), JSON.stringify(["args", "stdin"]), "extra keys are stripped locally");
  assertEquals(validatePreviewInput(hostileExtracted).stdin, "");
  // Non-object input still fails closed (the extraction passes it through).
  let threw = null;
  try { validatePreviewInput(extractPreviewInput("junk")); } catch (e) { threw = e.code; }
  assertEquals(threw, "preview_request_shape", "non-object input fails closed");
});

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
  // argv0 = the program name (the WASI _start command convention requires
  // argv[0]; the Settings UI stays command-only).
  assertEquals(job.args[0], "csvtool", "argv0 is the program name");
  assertEquals(job.args.length, 1, "no user args → exactly argv0");
  const withArgs = buildPreviewJob({ input: { args: ["--strip", "-k"], stdin: "" }, authority });
  assertEquals(withArgs.args[0], "csvtool", "argv0 is the program name");
  assertEquals(JSON.stringify(withArgs.args.slice(1)), JSON.stringify(["--strip", "-k"]), "user args follow argv0 exactly");
  assertEquals([...job.stdin].length, "a,b\n1,2".length);
  // quota is bounded by the preview limits
  assertEquals(job.quota.stdinBytes, PREVIEW_LIMITS.maxStdinBytes);
  // argv0 + the user args stay inside the WASI arg bounds (64 args / 4096 bytes)
  const wide = buildPreviewJob({
    input: { args: Array.from({ length: PREVIEW_LIMITS.maxArgs }, () => "x"), stdin: "" },
    authority,
  });
  assertEquals(wide.args.length, PREVIEW_LIMITS.maxArgs + 1, "max user args + argv0");
  assert(wide.args.length <= 64, "total args inside the WASI MAX_ARGS bound");
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
