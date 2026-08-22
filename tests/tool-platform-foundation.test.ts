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
  assertEquals(data.tools.length, 9);

  for (const tool of data.tools) {
    assertEquals(tool.availability, "disabled", `${tool.toolId} must be disabled`);
    assertEquals(tool.availabilityReason, "package-execution-unwired");
    assertEquals(tool.dispatcherKind, "none", `${tool.toolId} must declare none dispatcher`);
    assertEquals(tool.admitted, false, `${tool.toolId} must not be admitted`);
    assertEquals(tool.canonicalNameClaim, false, `${tool.toolId} must not claim canonical naming`);
  }
});
