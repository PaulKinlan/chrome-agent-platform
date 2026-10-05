// tests/tool-platform-foundation.test.ts — verifies vendored sources, build recipes, licenses and descriptors.
// @ts-nocheck
import { assert, assertEquals } from "jsr:@std/assert@1";

const EXPECTED_ARCHIVES = [
  { file: "sh-8202166b.tar.gz", sha256: "d258a65d99ac3aa5aa592052dbc7ad0fb25e9727a5769415da5067b2e120e888" },
  { file: "fzf-416aff86.tar.gz", sha256: "05c242945135575242bdf3dc93b2924540b7d2266f3b33169e6468b8df3d2c0d" },
  { file: "minify-8985643f.tar.gz", sha256: "c87abdfb25801164b9c126129de30ac9e70bf125faa6a926a4140850e35aff63" },
  { file: "sed-4.9.tar.xz", sha256: "6e226b732e1cd739464ad6862bd1a1aba42d7982922da7a53519631d24975181" },
  { file: "gawk-5.3.2.tar.xz", sha256: "f8c3486509de705192138b00ef2c00bbbdd0e84c30d5c07d23fc73a9dc4cc9cc" },
];

const EXPECTED_RECIPES = [
  "build-shfmt.sh",
  "build-fzf.sh",
  "build-minify.sh",
  "build-yq.sh",
  "build-sed.sh",
  "build-gawk.sh",
  "build-libmagic.sh",
  "build-xmllint.sh",
  "build-ffmpeg.sh",
];

Deno.test("foundation: exact vendored source archives are present and hash-verified", async () => {
  for (const { file, sha256 } of EXPECTED_ARCHIVES) {
    const filePath = `wasm-tools/sources/archives/${file}`;
    const bytes = await Deno.readFile(filePath);
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    assertEquals(hash, sha256, `${file} hash must match exact verified pin`);
  }
});

Deno.test("foundation: hermetic build recipes exist and are non-empty", async () => {
  for (const recipe of EXPECTED_RECIPES) {
    const text = await Deno.readTextFile(`wasm-tools/recipes/${recipe}`);
    assert(text.length > 50, `${recipe} must contain non-trivial build script`);
    assert(text.includes("#!/usr/bin/env bash"), `${recipe} must be a bash script`);
  }
});

Deno.test("foundation: tool descriptors declare disabled availability, none dispatcher, and admitted false", async () => {
  const text = await Deno.readTextFile("wasm-tools/descriptors/foundation-descriptors.json");
  const data = JSON.parse(text);
  assertEquals(data.schemaVersion, 2);
  assert(Array.isArray(data.tools));
  assertEquals(data.tools.length, 11);

  for (const tool of data.tools) {
    assertEquals(tool.availability, "disabled", `${tool.toolId} must be disabled`);
    assertEquals(tool.availabilityReason, "package-execution-unwired");
    assertEquals(tool.dispatcherKind, "none", `${tool.toolId} must declare none dispatcher`);
    assertEquals(tool.admitted, false, `${tool.toolId} must not be admitted`);
    assertEquals(tool.canonicalNameClaim, false, `${tool.toolId} must not claim canonical naming`);
  }
});

// chrome-agent-platform-ae5v: the two SQL modules are DECLARED and
// NON-EXECUTABLE. Both are Emscripten builds — sqlite3.wasm imports env (27) +
// wasi_snapshot_preview1 (9), wa-sqlite imports its bundled module a (73) — and
// `auditWasmBinary` REFUSES them (import_not_allowed), so the honest posture is a
// descriptor row that promises nothing runnable: no manifest, no CAS blob, no
// dispatcher. These pins fail if a row is deleted, if a measured value drifts,
// or if someone ships a manifest for them without wiring the Lane C host (ltkj)
// and deliberately moving the row.
const AE5V_EXPECTED = [
  {
    toolId: "sqlite_wasm_official",
    version: "3.53.0-build1",
    artifacts: [
      { bytes: 864752, sha256: "02d7e48164395fa68f81c6ec33e9da5461be397dc57602ac0cd89b4bbba1d312", imports: { env: 27, wasi_snapshot_preview1: 9 } },
    ],
  },
  {
    toolId: "wa_sqlite",
    version: "1.0.0",
    artifacts: [
      { bytes: 558343, sha256: "5384bc7d80d7981c2516f3ad6b02d886629985d178e5037e765d655f440bbf9f", imports: { a: 73 } },
      { bytes: 1139398, sha256: "91376096fe56ddd9594db83074704f08fc2566edea2cb121aa624f72a67a86b5", imports: { a: 73 } },
    ],
  },
];

Deno.test("ae5v: sqlite-wasm + wa-sqlite are declared, disabled, and carry their measured pins", async () => {
  const data = JSON.parse(await Deno.readTextFile("wasm-tools/descriptors/foundation-descriptors.json"));
  for (const expected of AE5V_EXPECTED) {
    const row = data.tools.find((t) => t.toolId === expected.toolId);
    assert(row, `${expected.toolId} must be declared as a descriptor row`);
    assertEquals(row.version, expected.version, `${expected.toolId} version pin`);
    assertEquals(row.availability, "disabled", `${expected.toolId} must stay disabled`);
    assertEquals(row.admitted, false, `${expected.toolId} must stay unadmitted`);
    assertEquals(row.dispatcherKind, "none", `${expected.toolId} must declare no dispatcher`);
    assertEquals(row.measuredArtifacts.length, expected.artifacts.length, `${expected.toolId} artifact count`);
    expected.artifacts.forEach((artifact, i) => {
      assertEquals(row.measuredArtifacts[i].bytes, artifact.bytes, `${expected.toolId} artifact ${i} size pin`);
      assertEquals(row.measuredArtifacts[i].sha256, artifact.sha256, `${expected.toolId} artifact ${i} sha256 pin`);
      assertEquals(row.measuredArtifacts[i].imports, artifact.imports, `${expected.toolId} artifact ${i} import census pin`);
    });
    assert(
      typeof row.measurement?.authorityVerdict === "string" && row.measurement.authorityVerdict.includes("refused"),
      `${expected.toolId} must record the bundled authority's refusal`,
    );
  }
});

Deno.test("ae5v: neither SQL module is executable — no shipped manifest declares it", async () => {
  const dir = "extension/wasm/manifests";
  const names = [];
  for await (const entry of Deno.readDir(dir)) if (entry.isFile) names.push(entry.name);
  for (const { toolId } of AE5V_EXPECTED) {
    assert(!names.some((n) => n.includes(toolId)), `${toolId} must ship no bundled manifest`);
  }
  for (const name of names) {
    const body = await Deno.readTextFile(`${dir}/${name}`);
    for (const { toolId } of AE5V_EXPECTED) {
      assert(!body.includes(`"${toolId}"`), `no shipped manifest may declare ${toolId} (${name})`);
    }
  }
});
