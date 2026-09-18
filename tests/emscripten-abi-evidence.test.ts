// chrome-agent-platform-ltkj.1 — compiler/source evidence only; no Chrome.
// @ts-nocheck
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";

const root = "packages/bundled/evidence/emscripten-abi";
const artifactReport = JSON.parse(
  await Deno.readTextFile(`${root}/artifact-report.json`),
);
const provenance = JSON.parse(
  await Deno.readTextFile(`${root}/provenance.json`),
);
const runtimeReport = JSON.parse(
  await Deno.readTextFile(`${root}/runtime-report.json`),
);
const encoder = new TextEncoder();

async function sha256(bytes: Uint8Array | string) {
  const value = typeof bytes === "string" ? encoder.encode(bytes) : bytes;
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", value))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function artifact(build: string, file: string) {
  return artifactReport.builds[build].find((entry) => entry.file === file);
}

Deno.test("emscripten ABI evidence: pins source and every byte-identical emitted asset", async () => {
  assertEquals(provenance.toolchain.emsdk.version, "6.0.0");
  assertEquals(
    provenance.toolchain.emsdk.managerCommit,
    "d223ae73c6998296e3ab27cf81dc2c2c9fd383de",
  );
  assertEquals(
    provenance.toolchain.emsdk.sdkReleaseCommit,
    "772bb4648be4a897ca062d6adc65bc70223d2703",
  );
  assertEquals(
    provenance.toolchain.emsdk.emscriptenCommit,
    "afa15e0c56d1292e073c2c91bafc1d5e0cdf0dd3",
  );
  assertEquals(provenance.patches, []);
  assertEquals(
    provenance.dependencies[0].commit,
    "2c980bb59875b0d32144a71867fbdebb2f77cd20",
  );

  for (
    const source of [
      ...provenance.sources,
      provenance.dependencies[0].source,
      provenance.dependencies[0].license,
    ]
  ) {
    const bytes = await Deno.readFile(`${root}/${source.path}`);
    assertEquals(await sha256(bytes), source.sha256, source.path);
    if (source.bytes) assertEquals(bytes.byteLength, source.bytes, source.path);
  }

  assertEquals(artifactReport.reproducibility, {
    compared: ["build-a", "build-b"],
    byteIdentical: true,
    mismatches: [],
  });
  const expectedFiles = artifactReport.builds["build-a"].map((entry) =>
    entry.file
  );
  assertEquals(expectedFiles.length, 15);
  assertEquals(
    artifactReport.builds["build-b"].map((entry) => entry.file),
    expectedFiles,
  );
  for (const file of expectedFiles) {
    const a = await Deno.readFile(`${root}/build-a/${file}`);
    const b = await Deno.readFile(`${root}/build-b/${file}`);
    assertEquals(await sha256(a), artifact("build-a", file).sha256, file);
    assertEquals(await sha256(b), artifact("build-b", file).sha256, file);
    assertEquals(a, b, file);
  }
});

Deno.test("emscripten ABI evidence: positive native profile is worker-only, evaluator-free, and has no ambient native bridge", async () => {
  const glueFiles = artifactReport.builds["build-a"].filter((entry) =>
    entry.kind === "javascript"
  );
  for (const glue of glueFiles) {
    assertEquals(glue.javascript.evalCalls, 0, glue.file);
    assertEquals(glue.javascript.functionConstructors, 0, glue.file);
    const source = await Deno.readTextFile(`${root}/build-a/${glue.file}`);
    assertMatch(
      source,
      /ENVIRONMENT_IS_WEB=false;var ENVIRONMENT_IS_WORKER=true/,
    );
    assertEquals(source.includes("ENVIRONMENT_IS_NODE"), false, glue.file);
    assertEquals(/\beval\s*\(/.test(source), false, glue.file);
    assertEquals(/\bnew\s+Function\s*\(/.test(source), false, glue.file);
  }

  const exactImports = {
    "numeric.wasm": [],
    "image-resize.wasm": [
      "env.__assert_fail:function:i32,i32,i32,i32->",
      "env.emscripten_resize_heap:function:i32->i32",
    ],
    "link-main.wasm": [
      "env.side_increment:function:i32->i32",
      "env.emscripten_resize_heap:function:i32->i32",
    ],
    "link-side.wasm": [],
  };
  for (const [file, expected] of Object.entries(exactImports)) {
    const record = artifact("build-a", file);
    const actual = record.wasm.imports.map((entry) =>
      `${entry.module}.${entry.symbol}:${entry.kind}:${
        entry.type.params?.join(",") ?? ""
      }->${entry.type.results?.join(",") ?? ""}`
    );
    assertEquals(actual, expected, file);
    assertEquals(record.wasm.features.tags, [], file);
    assert(Array.isArray(record.wasm.features.memories), file);
    assert(Array.isArray(record.wasm.features.tables), file);
  }

  assertEquals(
    artifact("build-a", "numeric.wasm").wasm.exports.some((entry) =>
      entry.name === "cap_weighted_sum"
    ),
    true,
  );
  assertEquals(
    artifact("build-a", "image-resize.wasm").wasm.exports.some((entry) =>
      entry.name === "cap_resize_rgba"
    ),
    true,
  );
  assertEquals(
    artifact("build-a", "link-main.wasm").wasm.exports.some((entry) =>
      entry.name === "cap_linked_compute"
    ),
    true,
  );
  const dylink = artifact("build-a", "link-main.wasm").wasm.customSections.find(
    (entry) => entry.name === "dylink.0",
  );
  assertEquals(dylink.subsections.find((entry) => entry.type === 2).needed, [
    "link-side.wasm",
  ]);
});

Deno.test("emscripten ABI evidence: real negative imports and executions falsify no-eval as confinement", async () => {
  const negativeGlobal = artifact("build-a", "negative-global.wasm");
  assertEquals(negativeGlobal.wasm.imports, [{
    module: "env",
    symbol: "cap_ambient_global_probe",
    kind: "function",
    type: { typeIndex: 0, params: [], results: ["i32"] },
  }]);
  assertEquals(
    artifact("build-a", "negative-side-em-asm.wasm").wasm.imports.some((
      entry,
    ) => entry.symbol === "emscripten_asm_const_int"),
    true,
  );
  assertEquals(
    artifact("build-a", "negative-side-em-js.wasm").wasm.imports.some((entry) =>
      entry.symbol === "side_js_increment"
    ),
    true,
  );
  assertEquals(
    runtimeReport.results.nativeAmbientGlobalAdversary.verdict,
    "unsafe-demonstrated",
  );
  assertEquals(
    runtimeReport.results.nativeAmbientGlobalAdversary.outputHex,
    "0x434150",
  );
  assertEquals(runtimeReport.results.sideWithEmAsm.verdict, "unsupported");
  assertEquals(runtimeReport.results.sideWithEmJs.verdict, "unsupported");

  const run = await new Deno.Command("node", {
    args: [`${root}/run-fixtures.mjs`, "--check"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const output = new TextDecoder().decode(run.stdout) +
    new TextDecoder().decode(run.stderr);
  assertEquals(run.success, true, output);
  assertMatch(output, /numeric=42\.5 image=128,128,128,255 linked=42/);
  assertMatch(
    output,
    /EM_ASM=unsupported EM_JS=unsupported ambient-global=unsafe-demonstrated network=not-measured/,
  );
  assertEquals(runtimeReport.networkObservation.verdict, "not-measured");
  assertEquals("actualNetworkRequests" in runtimeReport, false);
});
