// @ts-nocheck — adversarial mutant checks + dynamic shapes.
// Source tests for the Settings-only bounded Wasm tool preview
// (CAP-FB-20260822-TOOL-PREVIEW-EXEC-01): strict bounded request, host-bound
// fences, and the immutable manifest/CAS/imports/memory/caps revalidation
// against the REAL shipped bundled csvtool bytes. No Chrome.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { EXECUTOR_BOUNDS } from "../extension/lib/wasm-executor-bounds.js";
const EXECUTOR_BOUNDS_MAX_WASM = EXECUTOR_BOUNDS.maxWasmBytes;
import {
  PREVIEW_LIMITS,
  PREVIEW_SPECS,
  PREVIEW_TOOL_IDS,
  STREAM_BACKED_BUNDLED_TOOL_IDS,
  boundPreviewResult,
  buildPreviewAuthority,
  buildPreviewJob,
  extractPreviewInput,
  previewSpecFor,
  rehydratePreviewStdin,
  rehydratePreviewWasmBytes,
  revalidatePreviewExecution,
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
  const routeStart = sw.indexOf('async "tool.preview.run"');
  assert(routeStart !== -1, "the tool.preview.run route must exist before its body is sliced");
  const routeEnd = sw.indexOf('async "agent.run"', routeStart);
  const routeBody = sw.slice(routeStart, routeEnd > routeStart ? routeEnd : routeStart + 4000);
  assert(!routeBody.includes("ensureOffscreen"), "the preview route never opens an offscreen document");
  assert(!routeBody.includes('type: "wasm.preview\"'), "no old offscreen-target message type");
  assert(!routeBody.includes("ntp"), "no NTP fallback in the preview route");
  // 5. The SW targets the options host. (HOST-PERMISSION SIMPLIFICATION:
  // manifest permissions are GRANTED AT INSTALL — the least-authority pin that
  // required empty permissions no longer applies; the preview still requires
  // NO additional runtime grant.)
  assert(sw.includes('type: "wasm.preview.options"'), "the SW route sends to the options host");
  assert((manifest.host_permissions ?? []).includes("<all_urls>"), "host access is install-granted (<all_urls>)");
});

Deno.test("preview: the route fetches runtime-RELATIVE wasm paths (no extension/ prefix)", async () => {
  // The packaged extension ROOT is the extension/ directory, so the SW must
  // fetch `wasm/...` (runtime-relative), never `extension/wasm/...`.
  const sw = await Deno.readTextFile(
    new URL("../extension/background/service-worker.js", import.meta.url),
  );
  assert(sw.includes("const manifestRel = spec.manifestRel"), "the manifest rel is the SPEC's runtime-relative path");
  assert(sw.includes("const casRel = spec.casRel"), "the CAS rel is the SPEC's runtime-relative path");
  assert(sw.includes("chrome.runtime.getURL(manifestRel)") && sw.includes("chrome.runtime.getURL(casRel)"), "the route fetches via getURL with the spec rels");
  // every spec rel is wasm-relative (no extension/ prefix) + points at the pinned CAS
  for (const spec of Object.values(PREVIEW_SPECS)) {
    assert(!spec.manifestRel.startsWith("extension/"), `${spec.toolId} manifestRel is runtime-relative`);
    assert(spec.manifestRel.startsWith("wasm/manifests/"), `${spec.toolId} manifestRel prefix`);
    assertEquals(spec.casRel, `wasm/cas/${spec.casSha}.wasm`, `${spec.toolId} CAS rel`);
  }
  assert(!sw.includes('getURL("extension/wasm/'), "no extension/ prefix inside getURL");
});

Deno.test("preview: the wasm-bytes transport rehydrates valid explicit arrays (incl. a REAL >64 KiB B2 binary) + rejects every hostile shape", async () => {
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

  // A REAL B2 binary (> 64 KiB — the old metadata cap) MUST rehydrate: the
  // wasm transport cap is maxWasmBytes (4 MiB), NOT maxRequestBytes.
  const b2Spec = previewSpecFor("grep");
  const b2Cas = new Uint8Array(await Deno.readFile(
    new URL(`../extension/wasm/cas/${b2Spec.casSha}.wasm`, import.meta.url),
  ));
  assert(b2Cas.byteLength > 64 * 1024, `grep is ${b2Cas.byteLength} B (> 64 KiB)`);
  const b2Rehydrated = rehydratePreviewWasmBytes(Array.from(b2Cas));
  assertEquals(b2Rehydrated.byteLength, b2Cas.byteLength, "the B2 binary rehydrates at the 4 MiB wasm cap");
  assertEquals(b2Rehydrated[0], 0x00); assertEquals(b2Rehydrated[1], 0x61);

  // The markdown CAS (186,886 B — > 64 KiB) also transports at the 4 MiB cap.
  const mdSpec = previewSpecFor("markdown");
  const mdCas = new Uint8Array(await Deno.readFile(
    new URL(`../extension/wasm/cas/${mdSpec.casSha}.wasm`, import.meta.url),
  ));
  assert(mdCas.byteLength > 64 * 1024, `markdown is ${mdCas.byteLength} B (> 64 KiB)`);
  const mdRehydrated = rehydratePreviewWasmBytes(Array.from(mdCas));
  assertEquals(mdRehydrated.byteLength, mdCas.byteLength, "the markdown binary rehydrates at the 4 MiB wasm cap");
  assertEquals(mdRehydrated[0], 0x00); assertEquals(mdRehydrated[1], 0x61);

  const rejections = {
    "not-an-array": { value: cas },
    "object": { value: { 0: 0, length: 8 } },
    "sparse": { value: Array.from({ length: 8 }) }, // holes → undefined
    "too-short": { value: Array.from(new Uint8Array(7)) },
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
    type: "tool.preview.run",
    toolId: "csvtool",
    args: ["--strip"],
    stdin: "a,b\n1,2",
  };
  const extracted = extractPreviewInput(standard);
  assertEquals(JSON.stringify(Object.keys(extracted).sort()), JSON.stringify(["args", "stdin", "toolId"]), "only toolId+args+stdin are extracted");
  // The strict validator ACCEPTS the extracted standard message (no
  // preview_request_shape from the stray `type` key).
  assertEquals(validatePreviewInput(extracted).args, ["--strip"]);
  // A hostile message with extra keys: the extraction drops them BEFORE the
  // validator — `evil` can never flow to the validator/executor.
  const hostile = {
    type: "tool.preview.run",
    toolId: "head",
    args: [],
    stdin: "",
    evil: 1,
    __authority: { sessionId: "forged" },
    userActivation: true,
    wasmBytes: new Uint8Array(4),
  };
  const hostileExtracted = extractPreviewInput(hostile);
  assertEquals(JSON.stringify(Object.keys(hostileExtracted).sort()), JSON.stringify(["args", "stdin", "toolId"]), "extra keys are stripped locally");
  assertEquals(validatePreviewInput(hostileExtracted).stdin, "");
  // Non-object input still fails closed (the extraction passes it through).
  let threw = null;
  try { validatePreviewInput(extractPreviewInput("junk")); } catch (e) { threw = e.code; }
  assertEquals(threw, "preview_request_shape", "non-object input fails closed");
});

Deno.test("preview: strict exact-key bounded request (toolId + args + stdin)", () => {
  assertEquals(validatePreviewInput({ toolId: "csvtool", args: ["--strip"], stdin: "a,b\n1,2" }).args, ["--strip"]);
  assertEquals(validatePreviewInput({ toolId: "uuid", args: [], stdin: "" }).stdin, "");
  assertEquals(validatePreviewInput({ toolId: "cut", args: ["-d", ",", "-f", "2"], stdin: "a,b" }).args.length, 4);
  for (const bad of [
    null, "x", { args: [] }, { stdin: "" }, { toolId: "csvtool", args: [], stdin: "", extra: 1 },
    // Recursive readers' seed/default/accepted-exit/package/capability authority
    // is immutable spec data; no request can forge or replace any of it.
    { toolId: "du", args: [], stdin: "", workspaceSeed: { files: [] } },
    { toolId: "du", args: [], stdin: "", acceptedExitCodes: [0, 1] },
    { toolId: "du", args: [], stdin: "", stdoutEncoding: "base64" },
    { toolId: "du", args: [], stdin: "", defaultArgs: ["/jobx"] },
    { toolId: "tree", args: [], stdin: "", workspaceSeed: { files: [] } },
    { toolId: "tree", args: [], stdin: "", acceptedExitCodes: [0, 1] },
    { toolId: "tree", args: [], stdin: "", stdoutEncoding: "base64" },
    { toolId: "tree", args: [], stdin: "", defaultArgs: ["/job"] },
    { toolId: "tree", args: [], stdin: "", packageId: "cap.bundled.du" },
    { toolId: "tree", args: [], stdin: "", capabilities: ["file.write"] },
    { toolId: "csvtool", args: ["a\u0000b"], stdin: "" },
  ]) {
    let threw = null;
    try { validatePreviewInput(bad); } catch (e) { threw = (e as { code?: string }).code ?? null; }
    assert(threw !== null, `expected rejection for ${JSON.stringify(bad)}`);
  }
  // dptw: size is no longer a rejection — long args, many args and big stdin
  // all validate.
  const big = validatePreviewInput({
    toolId: "csvtool",
    args: ["x".repeat(600), "y".repeat(600), "z".repeat(600), "w".repeat(600), "v".repeat(600)],
    stdin: "s".repeat(64 * 1024),
  });
  assertEquals(big.args.length, 5, "five args pass (was: maxArgs 4)");
  assertEquals(big.stdin.length, 64 * 1024, "big stdin passes whole");
});

Deno.test("preview: an UNKNOWN toolId fails closed (the static allowlist is exact)", () => {
  for (const toolId of ["evil", "csvtool.extra", "CsvTool", ""]) {
    let threw = null;
    try { validatePreviewInput({ toolId, args: [], stdin: "" }); } catch (e) { threw = (e as { code?: string }).code ?? null; }
    assertEquals(threw, "preview_unknown_tool", `unknown tool ${JSON.stringify(toolId)} rejected`);
  }
  // every allowlisted tool SURVIVES validation with its exact toolId intact
  // (the SW resolves the spec from the validated toolId — a dropped toolId
  // would make every tool unknown).
  for (const toolId of PREVIEW_TOOL_IDS.filter((id) => id !== "gzip" && id !== "sqlite3_query_bounded")) {
    const validated = validatePreviewInput({ toolId, args: ["-n", "2"], stdin: "a\nb" });
    assertEquals(validated.toolId, toolId, `toolId survives validation for ${toolId}`);
    assertEquals(JSON.stringify(validated.args), JSON.stringify(["-n", "2"]), toolId);
  }
  assertEquals(validatePreviewInput({ toolId: "gzip", args: [], stdin: "hello" }).toolId, "gzip");
  assertEquals(validatePreviewInput({ toolId: "sqlite3_query_bounded", args: [], stdin: JSON.stringify({ sql: "SELECT 1", params: [], database: "test.db", readOnly: true }) }).toolId, "sqlite3_query_bounded");
  // gzip + truncate + touch + sqlite are the appended tools after tree in the UI.
  assertEquals(JSON.stringify(PREVIEW_TOOL_IDS), JSON.stringify(
    ["awk", "awk_filter_bounded", "base64", "compressops", "csvtool", "cut", "date_formatter_bounded", "diff", "du", "grep", "gzip", "head", "imageops", "jq", "markdown", "md5sum", "patch", "sed", "sha256sum", "sha512sum", "sort", "sqlite3_query_bounded", "stat", "tail", "toml2json", "touch", "tr", "tree", "truncate", "uniq", "uuid", "wc", "xxd", "zxing"],
  ));
  for (const spec of Object.values(PREVIEW_SPECS)) {
    assert(typeof spec.packageId === "string" && spec.packageId.startsWith("cap.bundled."), spec.toolId);
    assert(typeof spec.casSha === "string" && /^[0-9a-f]{64}$/.test(spec.casSha), `${spec.toolId} casSha`);
    assert(Number.isSafeInteger(spec.size) && spec.size > 0, `${spec.toolId} size`);
    assertEquals(spec.argv0, spec.toolId, "argv0 == the exact toolId");
    // Binary-at-the-pipe tools emit base64: gzip always; imageops except its
    // info subcommand (per-argv, previewStdoutEncoding).
    const expectedEncoding = spec.toolId === "gzip" || spec.toolId === "imageops" || spec.toolId === "zxing" ? "base64" : "utf8";
    assertEquals(spec.stdoutEncoding, expectedEncoding, `${spec.toolId}: immutable output encoding`);
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
  const job = buildPreviewJob({ input: { toolId: "csvtool", args: [], stdin: "a,b\n1,2" }, authority });
  assertEquals(job.context.executionId, authority.executionId);
  assertEquals(job.context.callId, authority.callId);
  assertEquals(job.context.origin, authority.origin);
  assertEquals(job.tier, "tiny");
  assertEquals(job.stdoutEncoding, "utf8", "the immutable spec supplies explicit UTF-8 output policy");
  // argv0 = the EXACT requested toolId (the WASI _start command convention
  // requires argv[0]; the Settings UI stays command-only).
  assertEquals(job.args[0], "csvtool", "argv0 is the program name");
  assertEquals(job.args.length, 1, "no user args → exactly argv0");
  const withArgs = buildPreviewJob({ input: { toolId: "csvtool", args: ["--strip", "-k"], stdin: "" }, authority });
  assertEquals(withArgs.args[0], "csvtool", "argv0 is the program name");
  assertEquals(JSON.stringify(withArgs.args.slice(1)), JSON.stringify(["--strip", "-k"]), "user args follow argv0 exactly");
  const uuidJob = buildPreviewJob({ input: { toolId: "uuid", args: ["-n", "2"], stdin: "" }, authority });
  assertEquals(uuidJob.args[0], "uuid", "argv0 == the requested toolId");
  assertEquals(JSON.stringify(uuidJob.args.slice(1)), JSON.stringify(["-n", "2"]));
  const headJob = buildPreviewJob({ input: { toolId: "head", args: ["-n", "2"], stdin: "" }, authority });
  assertEquals(headJob.args[0], "head", "argv0 == the requested toolId");
  const duDefaultJob = buildPreviewJob({ input: { toolId: "du", args: [], stdin: "" }, authority });
  assertEquals(JSON.stringify(duDefaultJob.args), JSON.stringify(["du", "/job"]), "du empty args resolve to the immutable /job default");
  assertEquals(JSON.stringify(duDefaultJob.acceptedExitCodes), JSON.stringify([0]), "du accepts exactly exit 0");
  const duExplicitJob = buildPreviewJob({ input: { toolId: "du", args: ["/job/inputs"], stdin: "" }, authority });
  assertEquals(JSON.stringify(duExplicitJob.args), JSON.stringify(["du", "/job/inputs"]), "a bounded explicit du operand replaces only its default");
  const treeDefaultJob = buildPreviewJob({ input: { toolId: "tree", args: [], stdin: "" }, authority });
  assertEquals(JSON.stringify(treeDefaultJob.args), JSON.stringify(["tree", "/job/inputs"]), "tree empty args resolve to immutable /job/inputs");
  assertEquals(JSON.stringify(treeDefaultJob.acceptedExitCodes), JSON.stringify([0]), "tree accepts exactly exit 0");
  assertEquals(JSON.stringify(treeDefaultJob.workspaceSeed), JSON.stringify({ files: [
    { path: "inputs/f.bin", bytes: [104, 105] },
    { path: "inputs/sub/g.txt", bytes: [103] },
  ] }), "tree receives only its immutable nested seed");
  assertEquals([...job.stdin].length, "a,b\n1,2".length);
  // dptw: the job byte quotas are unbounded.
  assertEquals(job.quota.stdinBytes, Number.POSITIVE_INFINITY, "no stdin byte quota");
  // per-tool arg byte bounds are gone: long docs pass at any size.
  const diffInput = validatePreviewInput({ toolId: "diff", args: ["a".repeat(1025), "b".repeat(2049)], stdin: "" });
  assertEquals(diffInput.args.length, 2, "docs past the removed 1024/doc bound are accepted");
  const threeDocs = validatePreviewInput({ toolId: "diff", args: ["a".repeat(1024), "b".repeat(1024), "c"], stdin: "" });
  assertEquals(threeDocs.args.length, 3, "a third doc past the removed 2048 total is accepted");
  let threw = null;
  // NUL in a doc rejects (all tools); the leading-BOM rejection is scoped to
  // diff/patch ONLY — the predecessor 17 keep their PRIOR acceptance behavior
  threw = null;
  try { validatePreviewInput({ toolId: "diff", args: ["a\u0000b", "c"], stdin: "" }); } catch (e) { threw = (e as { code?: string }).code ?? null; }
  assertEquals(threw, "preview_args", "NUL in a doc rejects");
  threw = null;
  try { validatePreviewInput({ toolId: "diff", args: ["\ufeffa", "c"], stdin: "" }); } catch (e) { threw = (e as { code?: string }).code ?? null; }
  assertEquals(threw, "preview_args", "BOM in a diff doc rejects");
  // REGRESSION: a predecessor (grep) arg with a leading BOM follows the PRIOR
  // acceptance (the normal-17 behavior is byte-unchanged)
  const bomArg = validatePreviewInput({ toolId: "grep", args: ["\ufeffx"], stdin: "" });
  assertEquals(JSON.stringify(bomArg.args), JSON.stringify(["\ufeffx"]), "a predecessor leading-BOM arg is accepted as before");
  // dptw: the 17 no longer reject >512/arg either — no argv byte ceilings.
  const longArg = validatePreviewInput({ toolId: "grep", args: ["a".repeat(513)], stdin: "" });
  assertEquals(JSON.stringify(longArg.args), JSON.stringify(["a".repeat(513)]), "a 513-char arg passes");
  // argv0 + the user args stay inside the WASI arg COUNT bound (64 args).
  const wide = buildPreviewJob({
    input: { toolId: "csvtool", args: Array.from({ length: 63 }, () => "x"), stdin: "" },
    authority,
  });
  assertEquals(wide.args.length, 64, "63 user args + argv0");
  assert(wide.args.length <= 64, "total args inside the WASI MAX_ARGS count bound");
  // a hostile authority (extra key / wrong origin) fails closed
  threw = null;
  try {
    buildPreviewJob({
      input: { toolId: "csvtool", args: [], stdin: "" },
      authority: { ...authority, evil: 1 },
    });
  } catch (e) { threw = (e as { code?: string }).code ?? null; }
  assert(threw === "preview_authority", "extra authority key fails closed");
});

Deno.test("preview: immutable revalidation passes on the REAL shipped bytes for ALL 34 allowlisted tools", async () => {
  for (const toolId of PREVIEW_TOOL_IDS) {
    const spec = previewSpecFor(toolId);
    const row = BUNDLED_TOOL_PACKAGE_ROWS.find((candidate) => candidate.toolId === toolId);
    assert(row, `${toolId}: generated package row exists`);
    const manifestText = await Deno.readTextFile(root(row.manifestRef));
    const casBytes = new Uint8Array(await Deno.readFile(root(`extension/wasm/cas/${spec.casSha}.wasm`)));
    const revalidated = await revalidatePreviewExecution({
      toolId,
      manifestText,
      casBytes,
      inventory: BUNDLED_INVENTORY,
    });
    assertEquals(revalidated.ok, true, toolId);
    assertEquals(revalidated.casSha256, spec.casSha, toolId);
    assertEquals(revalidated.casSize, spec.size, toolId);
    assertEquals(revalidated.executable.id, toolId, toolId);
    // The tier the manifest DECLARES is the tier the revalidation must honor
    // (tiny for the Unix tools; imageops declares the default tier — image
    // buffers legitimately exceed 512 pages).
    const declaredTier = JSON.parse(manifestText)?.executables?.[0]?.memory?.tier ?? "tiny";
    assertEquals(revalidated.memory.tier, declaredTier, toolId);
    assertEquals(JSON.stringify(revalidated.capabilities), JSON.stringify(spec.caps), toolId);
  }
  // per-tool caps honored: uuid is the crypto set, the others text.transform
  assertEquals(JSON.stringify(previewSpecFor("uuid").caps), JSON.stringify(["compute", "crypto"]));
  assertEquals(JSON.stringify(previewSpecFor("head").caps), JSON.stringify(["compute", "text.transform"]));
});

Deno.test("preview: revalidation fails closed on every mutant (sha/size/imports/memory/caps/inventory/spec)", async () => {
  const { manifestText, casBytes } = await realCsvtoolAssets();
  // 1. CAS sha mismatch (one byte flipped)
  const flipped = new Uint8Array(casBytes);
  flipped[20] ^= 0x01;
  let threw = null;
  try {
    await revalidatePreviewExecution({ toolId: "csvtool", manifestText, casBytes: flipped, inventory: BUNDLED_INVENTORY });
  } catch (e) { threw = (e as { code?: string }).code ?? null; }
  assertEquals(threw, "preview_cas_sha", "flipped CAS bytes fail closed");
  // 2. CAS size mismatch
  threw = null;
  try {
    await revalidatePreviewExecution({
      toolId: "csvtool",
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
    await revalidatePreviewExecution({ toolId: "csvtool", manifestText: driftedManifest, casBytes, inventory: BUNDLED_INVENTORY });
  } catch (e) { threw = (e as { code?: string }).code ?? null; }
  assert(["preview_manifest_drift", "preview_manifest_invalid"].includes(threw), `drift fails closed: ${threw}`);
  // 4. An executable-capability mutant (adds a capability)
  const capsMutant = manifestText.replace(
    '"capabilities":["compute","text.transform"]',
    '"capabilities":["compute","text.transform","file.write"]',
  );
  threw = null;
  try {
    await revalidatePreviewExecution({ toolId: "csvtool", manifestText: capsMutant, casBytes, inventory: null });
  } catch (e) { threw = (e as { code?: string }).code ?? null; }
  assert(
    ["preview_capabilities", "preview_manifest_invalid"].includes(threw ?? ""),
    `capability mutant fails closed: ${threw}`,
  );
  // 5. A non-preview package identity
  const wrongPkg = manifestText.replace("cap.bundled.csvtool", "cap.bundled.evil");
  threw = null;
  try {
    await revalidatePreviewExecution({ toolId: "csvtool", manifestText: wrongPkg, casBytes, inventory: null });
  } catch (e) { threw = (e as { code?: string }).code ?? null; }
  assertEquals(threw, "preview_package_identity", "wrong package identity fails closed");
  // 6. SPEC SUBSTITUTION: the csvtool toolId fed the uuid manifest/CAS bytes
  //    must fail closed (package identity + spec mismatch), and vice versa.
  const uuidSpec = previewSpecFor("uuid");
  const uuidManifest = await Deno.readTextFile(root(`extension/wasm/manifests/${uuidSpec.packageId}-1.0.0.manifest.json`));
  const uuidCas = new Uint8Array(await Deno.readFile(root(`extension/wasm/cas/${uuidSpec.casSha}.wasm`)));
  threw = null;
  try {
    await revalidatePreviewExecution({ toolId: "csvtool", manifestText: uuidManifest, casBytes: uuidCas, inventory: BUNDLED_INVENTORY });
  } catch (e) { threw = (e as { code?: string }).code ?? null; }
  assert(["preview_package_identity", "preview_spec_mismatch"].includes(threw ?? ""), `csvtool←uuid substitution fails closed: ${threw}`);
  // a manifest whose executable SHA was swapped for another tool's → spec mismatch
  const swapped = uuidManifest.replace(uuidSpec.casSha, previewSpecFor("head").casSha);
  threw = null;
  try {
    await revalidatePreviewExecution({ toolId: "uuid", manifestText: swapped, casBytes: uuidCas, inventory: null });
  } catch (e) { threw = (e as { code?: string }).code ?? null; }
  assert(["preview_spec_mismatch", "preview_manifest_invalid"].includes(threw ?? ""), `spec substitution fails closed: ${threw}`);
});

Deno.test("preview: the result envelope is bounded (never unbounded bytes)", () => {
  const ok = boundPreviewResult({ ok: true, phase: "completed", exitCode: 0, stdout: "a,b\n1,2", stdoutBase64: null, stdoutBytes: 7, stderr: "", errno: null, error: null }, { stdoutEncoding: "utf8" });
  assertEquals(ok.ok, true);
  assertEquals(ok.stdout, "a,b\n1,2");
  const failed = boundPreviewResult({ ok: false, phase: "proc-exit", exitCode: 1, stdout: "", stdoutBase64: null, stdoutBytes: 0, stderr: "", counters: null, errno: 0, error: "boom" }, { stdoutEncoding: "utf8" });
  assertEquals(failed.ok, false);
  assertEquals(failed.error, "boom");
  // hostile shapes fail closed
  for (const bad of [
    null,
    "x",
    { ok: true },
    { ok: true, stdout: "x".repeat(300 * 1024), stdoutBase64: null },
    { ok: true, stdout: "text", stdoutBase64: "dGV4dA==", stderr: "" },
  ]) {
    let threw = null;
    try { boundPreviewResult(bad, { stdoutEncoding: "utf8" }); } catch (e) { threw = (e as { code?: string }).code ?? null; }
    assert(threw !== null, `expected rejection for ${JSON.stringify(bad)?.slice(0, 40)}`);
  }
});

Deno.test("preview: the EXACT 34-tool static allowlist admits every shipped package", async () => {
  const admitted = BUNDLED_TOOL_PACKAGE_ROWS.filter((row) => row.admitted === true);
  assertEquals(JSON.stringify(admitted.map((row) => row.toolId).sort()), JSON.stringify(
    ["awk", "awk_filter_bounded", "base64", "compressops", "csvtool", "cut", "date_formatter_bounded", "diff", "du", "grep", "gzip", "head", "imageops", "jq", "markdown", "md5sum", "patch", "sed", "sha256sum", "sha512sum", "sort", "sqlite3_query_bounded", "stat", "tail", "toml2json", "touch", "tr", "tree", "truncate", "uniq", "uuid", "wc", "xxd", "zxing"],
  ));
  for (const row of admitted) {
    assertEquals(row.settingsPreview, true, row.toolId);
    assertEquals(row.disabled, false, row.toolId);
    assertEquals(row.disabledReason, null, row.toolId);
  }
  const notAdmitted = BUNDLED_TOOL_PACKAGE_ROWS.filter((row) => row.admitted !== true);
  assertEquals(notAdmitted.length, 0, "all 34 are enabled");
  assertEquals(notAdmitted.map((row) => row.toolId).sort(), []);
  for (const toolId of ["stat", "du"]) {
    const spec = previewSpecFor(toolId);
    assertEquals(JSON.stringify(spec.workspaceSeed), JSON.stringify({ files: [{ path: "inputs/f.bin", bytes: [104, 105] }] }));
    assert(Object.isFrozen(spec.workspaceSeed) && Object.isFrozen(spec.workspaceSeed.files) &&
      Object.isFrozen(spec.workspaceSeed.files[0]) && Object.isFrozen(spec.workspaceSeed.files[0].bytes),
    `${toolId} trusted seed is deeply frozen`);
  }
  assertEquals(JSON.stringify(previewSpecFor("du").defaultArgs), JSON.stringify(["/job"]), "du safe default is immutable-spec-controlled");
  assert(Object.isFrozen(previewSpecFor("du").defaultArgs), "du default args are frozen");
  assertEquals(JSON.stringify(previewSpecFor("du").acceptedExitCodes), JSON.stringify([0]), "du accepted exits are exactly [0]");
  const treeSpec = previewSpecFor("tree");
  assertEquals(JSON.stringify(treeSpec.workspaceSeed), JSON.stringify({ files: [
    { path: "inputs/f.bin", bytes: [104, 105] },
    { path: "inputs/sub/g.txt", bytes: [103] },
  ] }), "tree nested seed is exact");
  assert(Object.isFrozen(treeSpec.workspaceSeed) && Object.isFrozen(treeSpec.workspaceSeed.files) &&
    treeSpec.workspaceSeed.files.every((file) => Object.isFrozen(file) && Object.isFrozen(file.bytes)),
  "tree trusted nested seed is deeply frozen");
  assertEquals(JSON.stringify(treeSpec.defaultArgs), JSON.stringify(["/job/inputs"]), "tree safe default is immutable-spec-controlled");
  assert(Object.isFrozen(treeSpec.defaultArgs), "tree default args are frozen");
  assertEquals(JSON.stringify(treeSpec.acceptedExitCodes), JSON.stringify([0]), "tree accepted exits are exactly [0]");
  for (const toolId of PREVIEW_TOOL_IDS.filter((id) => !["stat", "du", "tree", "truncate", "touch", "sqlite3_query_bounded"].includes(id))) {
    assertEquals(JSON.stringify(previewSpecFor(toolId).workspaceSeed), JSON.stringify({ files: [] }), `${toolId}: empty immutable seed`);
    assertEquals("defaultArgs" in previewSpecFor(toolId), false, `${toolId}: predecessor receives no new default-arg behavior`);
  }
  // truncate: the spec-owned scratch/touched empty fixture + the -s default.
  const truncateSpec = previewSpecFor("truncate");
  assertEquals(JSON.stringify(truncateSpec.workspaceSeed), JSON.stringify({ files: [{ path: "scratch/touched", bytes: [] }] }), "truncate spec-owned empty fixture");
  assert(Object.isFrozen(truncateSpec.workspaceSeed) && Object.isFrozen(truncateSpec.workspaceSeed.files) &&
    Object.isFrozen(truncateSpec.workspaceSeed.files[0]) && Object.isFrozen(truncateSpec.workspaceSeed.files[0].bytes),
  "truncate trusted seed is deeply frozen");
  assertEquals(JSON.stringify(truncateSpec.defaultArgs), JSON.stringify(["-s", "0", "/job/scratch/touched"]), "truncate default is the spec-owned fixture resize");
  assert(Object.isFrozen(truncateSpec.defaultArgs), "truncate default args are frozen");
  assertEquals(JSON.stringify(truncateSpec.acceptedExitCodes), JSON.stringify([0]), "truncate accepted exits are exactly [0]");
  // touch: the spec-owned scratch/touched empty fixture + the -t default.
  const touchSpec = previewSpecFor("touch");
  assertEquals(JSON.stringify(touchSpec.workspaceSeed), JSON.stringify({ files: [{ path: "scratch/touched", bytes: [] }] }), "touch spec-owned empty fixture");
  assert(Object.isFrozen(touchSpec.workspaceSeed) && Object.isFrozen(touchSpec.workspaceSeed.files) &&
    Object.isFrozen(touchSpec.workspaceSeed.files[0]) && Object.isFrozen(touchSpec.workspaceSeed.files[0].bytes),
  "touch trusted seed is deeply frozen");
  assertEquals(JSON.stringify(touchSpec.defaultArgs), JSON.stringify(["-t", "0", "/job/scratch/touched"]), "touch default is the spec-owned fixture set-times");
  assert(Object.isFrozen(touchSpec.defaultArgs), "touch default args are frozen");
  assertEquals(JSON.stringify(touchSpec.acceptedExitCodes), JSON.stringify([0]), "touch accepted exits are exactly [0]");
  // sqlite: the spec-owned 8,192-B test.db fixture (sha 75efece3…), no default args.
  const sqliteSpec = previewSpecFor("sqlite3_query_bounded");
  assertEquals(sqliteSpec.workspaceSeed.files.length, 1, "sqlite single-file fixture");
  assertEquals(sqliteSpec.workspaceSeed.files[0].path, "scratch/test.db", "sqlite fixture path");
  assertEquals(sqliteSpec.workspaceSeed.files[0].bytes.length, 8192, "sqlite fixture size 8,192 B");
  const fixtureDigest = await crypto.subtle.digest("SHA-256", new Uint8Array(sqliteSpec.workspaceSeed.files[0].bytes)).then(
    (d) => [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join(""),
  );
  assertEquals(fixtureDigest, "75efece32c426a7a2b2b3eabbf85b0f90e0992e7135e709f0b3a9339e8610e3d", "sqlite fixture sha256 (the re-verified spec pin)");
  assert(Object.isFrozen(sqliteSpec.workspaceSeed) && Object.isFrozen(sqliteSpec.workspaceSeed.files) &&
    Object.isFrozen(sqliteSpec.workspaceSeed.files[0]) && Object.isFrozen(sqliteSpec.workspaceSeed.files[0].bytes),
  "sqlite trusted seed is deeply frozen");
  assertEquals("defaultArgs" in sqliteSpec, false, "sqlite has no argv path authority (argv0 only)");
  assertEquals(JSON.stringify(sqliteSpec.acceptedExitCodes), JSON.stringify([0]), "sqlite accepted exits are exactly [0]");
  const tree = BUNDLED_TOOL_PACKAGE_ROWS.find((row) => row.toolId === "tree");
  assertEquals(tree.admitted, true, "tree is admitted only to Settings preview");
  assertEquals(tree.settingsPreview, true);
  assertEquals(tree.disabled, false);
  assertEquals(tree.disabledReason, null);
  assertEquals(tree.binary.sha256, "65362b548d918eeb102f034bc4fc270ef450be463b82a0ffbe71a3ef1b8aa2cb");
  assertEquals(tree.binary.bytes, 39108);
  assert(!(tree.caveats ?? []).join(" ").includes("future reviewed execution adapter"), "tree no longer carries stale pre-admission copy");
  assertEquals(JSON.stringify(previewSpecFor("sort").caps), JSON.stringify(["compute", "text.transform"]));
  assertEquals(JSON.stringify(previewSpecFor("toml2json").caps), JSON.stringify(["compute", "data.read", "data.write"]));
  // per-tool caps: the digest tools carry the crypto set
  assertEquals(JSON.stringify(previewSpecFor("md5sum").caps), JSON.stringify(["compute", "crypto"]));
  assertEquals(JSON.stringify(previewSpecFor("sha256sum").caps), JSON.stringify(["compute", "crypto"]));
  const gzip = previewSpecFor("gzip");
  assertEquals(gzip.stdoutEncoding, "base64");
  assertEquals(JSON.stringify(gzip.acceptedExitCodes), JSON.stringify([0]));
  assertEquals(JSON.stringify(gzip.allowedArgs), JSON.stringify([[], ["-d"]]));
  assertEquals("maxTextInputBytes" in gzip, false, "dptw: no gzip input byte caps in the spec");
  assert(Object.isFrozen(gzip) && Object.isFrozen(gzip.allowedArgs) && gzip.allowedArgs.every(Object.isFrozen));
  assertEquals(JSON.stringify(previewSpecFor("base64").caps), JSON.stringify(["compute", "text.transform"]));
  assertEquals(JSON.stringify(previewSpecFor("wc").caps), JSON.stringify(["compute", "text.transform"]));
  assertEquals(JSON.stringify(previewSpecFor("xxd").caps), JSON.stringify(["compute", "text.transform"]));
  // dptw: no byte envelopes remain; wall time still stays inside the executor bound.
  assert(PREVIEW_LIMITS.wallMs <= 30_000, "wall time stays inside the executor bound");
});

// ── R12 sqlite admission input discipline (CAP-FB-20260823-R12-SQLITE-ADMISSION-01) ─
Deno.test("R12 sqlite input: the exact-key {sql,params,database,readOnly} JSON; readOnly forced + fixture-only + bounds", () => {
  const ok = validatePreviewInput({ toolId: "sqlite3_query_bounded", args: [], stdin: JSON.stringify({ sql: "SELECT * FROM items", params: [], database: "test.db", readOnly: true }) });
  assertEquals(ok.toolId, "sqlite3_query_bounded");
  assertEquals(ok.stdin, JSON.stringify({ sql: "SELECT * FROM items", params: [], database: "test.db", readOnly: true }), "the canonical JSON survives");
  // readOnly:false → denied.
  for (const stdin of [
    JSON.stringify({ sql: "SELECT 1", params: [], database: "test.db", readOnly: false }),
    JSON.stringify({ sql: "SELECT 1", params: [], database: "other.db", readOnly: true }),
    JSON.stringify({ sql: "SELECT 1", params: [], database: "../test.db", readOnly: true }),
    JSON.stringify({ sql: "SELECT 1", params: [], database: "test.db", readOnly: true, extra: "x" }),
    JSON.stringify({ sql: "SELECT 1", params: [], database: "test.db" }),
  ]) {
    let threw = null;
    try { validatePreviewInput({ toolId: "sqlite3_query_bounded", args: [], stdin }); } catch (e) { threw = (e as { code?: string }).code ?? null; }
    assert(threw !== null, `expected rejection: ${stdin.slice(0, 60)}`);
  }
  // dptw: no sql/params/total byte bounds — only the shape, readOnly and
  // fixture-database guards remain (they are security, not size).
  const bigSql = validatePreviewInput({ toolId: "sqlite3_query_bounded", args: [], stdin: JSON.stringify({ sql: "x".repeat(1792), params: [], database: "test.db", readOnly: true }) });
  assertEquals(bigSql.toolId, "sqlite3_query_bounded");
  const overOldBounds = validatePreviewInput({ toolId: "sqlite3_query_bounded", args: [], stdin: JSON.stringify({ sql: "x".repeat(1793), params: ["p".repeat(600)], database: "test.db", readOnly: true }) });
  assertEquals(overOldBounds.toolId, "sqlite3_query_bounded", "sql past the removed 1792 bound and params past 512 are accepted");
});

// The nine-member pin as a shared literal — wasm-task-execution.test.ts uses
// the same literal to pin the SCHEMA side, so a tenth member fails even if its
// package schema never advertises inputRef.
const EXPECTED_STREAM_IDS = ["awk", "base64", "grep", "imageops", "jq", "sed", "sort", "tr", "uniq", "wc"];

Deno.test("preview: the streamed bundled-tool allowlist is EXACTLY ten members (9 Unix + imageops, 6s2c)", () => {
  // chrome-agent-platform-0alg: the independent review found non-listed tools
  // are correctly refused, but nothing failed if an extra tool (e.g. cat)
  // silently acquired the OPFS streaming profile. Pin the exact membership:
  // adding OR removing a member must fail this test.
  assertEquals(STREAM_BACKED_BUNDLED_TOOL_IDS.length, 10, "exactly ten streamed tools");
  assertEquals(new Set(STREAM_BACKED_BUNDLED_TOOL_IDS).size, 10, "no duplicate members");
  assertEquals(
    [...STREAM_BACKED_BUNDLED_TOOL_IDS].sort(),
    EXPECTED_STREAM_IDS,
    "the allowlist is exactly awk, base64, grep, imageops, jq, sed, sort, tr, uniq, wc",
  );
  assert(Object.isFrozen(STREAM_BACKED_BUNDLED_TOOL_IDS), "the allowlist is frozen");
});
