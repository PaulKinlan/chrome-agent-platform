// @ts-nocheck
// Extended Unix/system tool family admission — sed_filter_bounded + jq_filter_bounded
// (CAP-FB-20260823-EXTENDED-TOOL-FAMILIES-01). Provenance/reproducibility of the
// evidence-tree binaries, identity of the shipped CAS artifacts, Settings-preview
// posture, per-tool runtime KATs over the SHIPPED CAS bytes, hostile-input rejection,
// and past-bound inputs (larger than any previously removed cap still work whole).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { crypto } from "jsr:@std/crypto";
import { BUNDLED_TOOL_PACKAGE_ROWS } from "../extension/lib/bundled-tool-packages.data.js";
import { BUNDLED_INVENTORY } from "../extension/lib/bundled-inventory-data.js";
import {
  WasmPackageAuthority,
  auditWasmBinary,
  canonicalJson,
  WASM_PACKAGE_LIMITS,
} from "../extension/lib/wasm-package-authority.js";
import { PREVIEW_TOOL_IDS, previewSpecFor } from "../extension/lib/tool-exec-preview.js";

const root = (rel) => `${new URL("..", import.meta.url).pathname}${rel}`;
const digest = async (bytes) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
  .map((b) => b.toString(16).padStart(2, "0")).join("");
const read = (rel) => Deno.readFile(root(rel));
const readText = (rel) => Deno.readTextFile(root(rel));

// Evidence-pinned identities (must equal the committed artifacts' real digests).
const SED_SHA = "2c06b0adbbdf33b6f051393a339548ab25219348c3667c96efc3b903cc3803e3";
const SED_BYTES = 49977;
const JQ_SHA = "55543604db368e4526cf1e7554312863323797c128b68bb08acea053055cb8c0";
const JQ_BYTES = 501522;

/** Run a WASI binary with argv + stdin under node's preview1 runtime. */
async function runWasi(wasmPath, args, input = "") {
  const code = `
    import { WASI } from "node:wasi";
    import { readFileSync } from "node:fs";
    const wasm = readFileSync(${JSON.stringify(wasmPath)});
    const wasi = new WASI({ version: "preview1", args: ["tool", ...${JSON.stringify(args)}], returnOnExit: true });
    const { instance } = await WebAssembly.instantiate(wasm, { wasi_snapshot_preview1: wasi.wasiImport });
    process.exitCode = wasi.start(instance);
  `;
  const cmd = new Deno.Command("node", {
    args: ["--input-type=module", "-e", code],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(input));
  await writer.close();
  const output = await child.output();
  const scrub = (t) => t.replace(/\(node:\d+\) ExperimentalWarning[\s\S]*?trace-warnings[\s\S]*?\)\n?/g, "").trim();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: scrub(new TextDecoder().decode(output.stderr)),
  };
}

const casPath = (toolId) => {
  const row = BUNDLED_TOOL_PACKAGE_ROWS.find((r) => r.toolId === toolId);
  assert(row?.admitted === true, `${toolId} must be admitted`);
  return root(`extension/wasm/cas/${row.binary.sha256}.wasm`);
};

Deno.test("sed/jq evidence: docs binaries are pure-WASI + pinned sha + byte-identical retained rebuilds", async () => {
  for (const [toolId, lane, sha, bytes, binaryName] of [
    ["sed_filter_bounded", "sed", SED_SHA, SED_BYTES, "sed.wasm"],
    ["jq_filter_bounded", "jq", JQ_SHA, JQ_BYTES, "jq.wasm"],
  ]) {
    const base = toolId.startsWith("jq") ? "docs/admissions/jq-filter-bounded" : "docs/admissions/t3-trio/sed";
    const bin = await read(`${base}/binaries/${binaryName}`);
    assertEquals(await digest(bin), sha, `${toolId} binary sha matches the pin`);
    assertEquals(bin.length, bytes, `${toolId} binary size matches`);
    const rebuild = await read(`${base}/metadata/rebuild-${binaryName}`);
    assertEquals(rebuild, bin, `${toolId} retained rebuild is byte-identical`);
    const hashRecord = await readText(`${base}/metadata/binary-sha256.txt`);
    assertEquals(hashRecord, `${sha}  binaries/${binaryName}\n`, `${toolId} hash record is relative and exact`);
    const receipt = await readText(`${base}/metadata/build-receipt.txt`);
    assert(receipt.includes(`binary_sha256=${sha}`), `${toolId} receipt pins the sha`);
    assert(receipt.includes(`binary_bytes=${bytes}`), `${toolId} receipt pins the size`);
    assert(!receipt.includes("/home/"), `${toolId} receipt has no private path`);
    const mod = new WebAssembly.Module(bin);
    const imports = WebAssembly.Module.imports(mod);
    assertEquals([...new Set(imports.map((i) => i.module))], ["wasi_snapshot_preview1"], `${toolId} only WASI preview-1 imports`);
    assert(imports.filter((i) => i.kind === "memory").length === 0, `${toolId} no imported memory`);
    assert(bin.length <= 16 * 1024 * 1024, `${toolId} tier size bound`);
    await Deno.stat(root(`${base}/sbom.cdx.json`));
    await Deno.stat(root(`${base}/NOTICES.md`));
    await Deno.stat(root(`${base}/spec-contract.md`));
  }
});

Deno.test("sed/jq admission: manifest + CAS identities revalidate through the REAL authority", async () => {
  for (const toolId of ["sed_filter_bounded", "jq_filter_bounded"]) {
    const spec = previewSpecFor(toolId);
    assert(spec, `${toolId} resolves in the preview spec map`);
    assertEquals(spec.argv0, toolId, "argv0 == exact toolId");
    assertEquals(spec.toolId, toolId);
    const row = BUNDLED_TOOL_PACKAGE_ROWS.find((r) => r.toolId === toolId);
    assertEquals(row.settingsPreview, true, toolId);
    assertEquals(row.disabled, false, toolId);
    assertEquals(row.disabledReason, null, toolId);
    assertEquals(row.canonicalNameClaim, false, toolId);
    const manifestRef = row.manifestRef.startsWith("extension/") ? row.manifestRef : `extension/${row.manifestRef}`;
    const manifestRaw = await readText(manifestRef);
    assertEquals(manifestRaw, canonicalJson(JSON.parse(manifestRaw)), `${toolId} manifest canonical bytes`);
    const probe = new WasmPackageAuthority();
    const validated = probe.validateManifest(manifestRaw);
    assert(validated.ok, `${toolId} manifest: ${validated.error}`);
    const inventoryRow = BUNDLED_INVENTORY.manifests.find((m) => m.pkg === row.packageId);
    assertEquals(validated.manifestDigest, inventoryRow.digest, `${toolId} inventory digest`);
    assertEquals(validated.manifest.tools[0].toolId, toolId);
    assertEquals(validated.manifest.tools[0].digest, row.binary.sha256, `${toolId} manifest binary sha`);
    const casBytes = await read(`extension/wasm/cas/${row.binary.sha256}.wasm`);
    assertEquals(casBytes.length, row.binary.bytes, `${toolId} CAS size`);
    assertEquals(await digest(casBytes), row.binary.sha256, `${toolId} CAS sha`);
    // the shipped CAS bytes re-audit cleanly against the declared executable
    auditWasmBinary(casBytes, validated.manifest.executables[0], { limits: WASM_PACKAGE_LIMITS });
    assertEquals(JSON.stringify([...validated.manifest.executables[0].capabilities].sort()), JSON.stringify([...spec.caps].sort()), `${toolId} spec caps == manifest caps`);
  }
  assert(PREVIEW_TOOL_IDS.includes("sed_filter_bounded") && PREVIEW_TOOL_IDS.includes("jq_filter_bounded"), "both new tools are in the preview allowlist");
});

Deno.test("sed KAT over the shipped CAS: substitute/delete/address + hostile script rejection + past-bound input", async () => {
  const sed = casPath("sed_filter_bounded");
  // substitute (bare script operand)
  const out1 = await runWasi(sed, ["s/foo/XXX/"], "hello world\nfoo bar\n");
  assertEquals(out1.code, 0);
  assert(out1.stdout.includes("XXX bar") && out1.stdout.includes("hello world"), out1.stdout);
  // -e + delete
  const out2 = await runWasi(sed, ["-e", "/skip/d"], "keep\nskip\nkeep2\n");
  assertEquals(out2.code, 0);
  assertEquals(out2.stdout, "keep\nkeep2\n");
  // -n + anchored print
  const out3 = await runWasi(sed, ["-n", "-e", "/^b/p"], "alpha\nbeta\ngamma\n");
  assertEquals(out3.code, 0);
  assertEquals(out3.stdout, "beta\n");
  // hostile: unterminated regex fails nonzero with bounded stderr
  const bad = await runWasi(sed, ["/unterminated"], "x\n");
  assertEquals(bad.code, 2, bad.stderr);
  assertEquals(bad.stdout, "");
  assert(bad.stderr.length > 0 && bad.stderr.length < 512, "bounded diagnostic: " + bad.stderr);
  const bad2 = await runWasi(sed, ["s/a/b"], "x\n"); // missing closing slash
  assert(bad2.code !== 0, "malformed program must fail: " + bad2.stderr);
  // past-bound: an 8 KiB input (beyond every removed 2 KiB cap) transforms whole
  const big = Array.from({ length: 700 }, (_, i) => `line-${i} alpha`).join("\n");
  assert(big.length > 8 * 1024, "fixture exceeds 8 KiB");
  const past = await runWasi(sed, ["s/alpha/omega/"], big);
  assertEquals(past.code, 0);
  assert(past.stdout.length === big.length, "whole input transformed, nothing dropped");
  assert(past.stdout.includes("line-299 omega") && !past.stdout.includes("alpha"), "substitution reached the final line");
});

Deno.test("jq KAT over the shipped CAS: select/transform + hostile input rejection + past-bound document", async () => {
  const jq = casPath("jq_filter_bounded");
  const doc = '{"name":"cap","tags":["a","b"],"n":2}\n';
  // field select
  const out1 = await runWasi(jq, [".name"], doc);
  assertEquals(out1.code, 0);
  assert(out1.stdout.includes('"cap"'), out1.stdout);
  // transform with pipe + join
  const out2 = await runWasi(jq, ['.name+"|"+(.tags|join(","))'], doc);
  assertEquals(out2.code, 0);
  assert(out2.stdout.includes('"cap|a,b"'), out2.stdout);
  // arithmetic
  const out3 = await runWasi(jq, [".n+1"], doc);
  assertEquals(out3.code, 0);
  assert(out3.stdout.includes("3"), out3.stdout);
  // hostile: malformed JSON stdin fails nonzero (jq parse error)
  const badJson = await runWasi(jq, [".a"], "not-json\n");
  assert(badJson.code !== 0, "malformed JSON must be rejected");
  assertEquals(badJson.stdout, "");
  assert(/parse error/.test(badJson.stderr), badJson.stderr);
  // hostile: compile error fails nonzero with bounded stderr
  const badProg = await runWasi(jq, ["{{bad"], doc);
  assert(badProg.code !== 0, "compile error must be rejected");
  assert(/compile error|syntax error/.test(badProg.stderr), badProg.stderr);
  // past-bound: an 8 KiB JSON document parses + extracts whole
  const big = JSON.stringify({ items: Array.from({ length: 400 }, (_, i) => ({ i, tag: `t${i}` })) }) + "\n";
  assert(big.length > 8 * 1024, "fixture exceeds 8 KiB");
  const past = await runWasi(jq, [".items|length"], big);
  assertEquals(past.code, 0, past.stderr);
  assert(past.stdout.includes("400"), past.stdout);
});

Deno.test("sed/jq route posture: the preview validator admits only the exact toolId + args/stdin shape", () => {
  // The spec map entry pins the ONLY executable + empty immutable workspace seed
  for (const toolId of ["sed_filter_bounded", "jq_filter_bounded"]) {
    const spec = previewSpecFor(toolId);
    assertEquals(JSON.stringify(spec.workspaceSeed), JSON.stringify({ files: [] }), `${toolId} empty immutable seed`);
    assertEquals("defaultArgs" in spec, false, `${toolId} no default-arg authority`);
    assertEquals(JSON.stringify(spec.acceptedExitCodes), JSON.stringify([0]), `${toolId} accepted exits exactly [0]`);
    assertEquals(spec.stdoutEncoding, "utf8", `${toolId} utf8 stdout`);
    assert(Object.isFrozen(spec), `${toolId} spec is frozen`);
  }
  // caps: sed = text.transform; jq = data read/write (JSON transform)
  assertEquals(JSON.stringify(previewSpecFor("sed_filter_bounded").caps), JSON.stringify(["compute", "text.transform"]));
  assertEquals(JSON.stringify(previewSpecFor("jq_filter_bounded").caps), JSON.stringify(["compute", "data.read", "data.write"]));
});
