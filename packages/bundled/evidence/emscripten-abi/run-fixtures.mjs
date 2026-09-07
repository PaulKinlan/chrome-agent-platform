// Harmless local execution of compiler evidence. No Chrome or extension runtime.
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

const root = new URL("./build-a/", import.meta.url);
globalThis.self = globalThis;

async function instantiate(name, sideFile = null) {
  const wasmBinary = await readFile(new URL(`${name}.wasm`, root));
  const expectedAsset = sideFile ? new URL(sideFile, root).href : null;
  const sideBytes = sideFile ? await readFile(new URL(sideFile, root)) : null;
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    const request = String(url);
    requests.push(request);
    if (request !== expectedAsset) {
      throw new Error(`unexpected fixture request: ${request}`);
    }
    return new Response(sideBytes, {
      headers: { "content-type": "application/wasm" },
    });
  };
  try {
    const { default: createModule } = await import(
      new URL(`${name}.mjs`, root)
    );
    return { module: await createModule({ wasmBinary }), requests };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function runNegativeSide(name, sideFile) {
  const { module } = await instantiate(name, sideFile);
  // Reaching this call means the embedded-JS side module was incorrectly linked.
  console.log(module._cap_linked_compute(35));
}

const mode = process.argv[2] ?? "--all";
if (mode === "--negative-side-em-asm") {
  await runNegativeSide("negative-main-em-asm", "negative-side-em-asm.wasm");
} else if (mode === "--negative-side-em-js") {
  await runNegativeSide("negative-main-em-js", "negative-side-em-js.wasm");
} else if (mode === "--all" || mode === "--check") {
  const numeric = await instantiate("numeric");
  const numericOutput = numeric.module._cap_weighted_sum(6, 7, 0.5);
  if (numericOutput !== 42.5) {
    throw new Error(`numeric output mismatch: ${numericOutput}`);
  }

  const image = await instantiate("image-resize");
  const source = Uint8Array.from([
    255,
    0,
    0,
    255,
    0,
    255,
    0,
    255,
    0,
    0,
    255,
    255,
    255,
    255,
    255,
    255,
  ]);
  const input = image.module._malloc(source.length);
  const output = image.module._malloc(4);
  image.module.HEAPU8.set(source, input);
  const resizeStatus = image.module._cap_resize_rgba(input, 2, 2, output, 1, 1);
  const resizeOutput = [...image.module.HEAPU8.slice(output, output + 4)];
  image.module._free(input);
  image.module._free(output);
  if (resizeStatus !== 1 || resizeOutput.join(",") !== "128,128,128,255") {
    throw new Error(
      `image resize mismatch: status=${resizeStatus} output=${resizeOutput}`,
    );
  }

  const linked = await instantiate("link-main", "link-side.wasm");
  const linkedOutput = linked.module._cap_linked_compute(35);
  if (linkedOutput !== 42) {
    throw new Error(`linked output mismatch: ${linkedOutput}`);
  }

  const globalProbe = await instantiate("negative-global");
  const globalProbeOutput = globalProbe.module._cap_probe_ambient_global();
  if (globalProbeOutput !== 0x434150) {
    throw new Error(
      `ambient-global adversary did not reach worker globals: ${globalProbeOutput}`,
    );
  }

  const embeddedJs = {};
  for (const fixture of ["em-asm", "em-js"]) {
    const child = spawnSync(process.execPath, [
      new URL(import.meta.url).pathname,
      `--negative-side-${fixture}`,
    ], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    const diagnostic = `${child.stdout}\n${child.stderr}`;
    const rejected = child.status !== 0 &&
      diagnostic.includes("DYNAMIC_EXECUTION=0 was set, cannot eval");
    if (!rejected) {
      throw new Error(
        `${fixture} side unexpectedly linked: status=${child.status}`,
      );
    }
    embeddedJs[fixture] = {
      verdict: "unsupported",
      reason: "DYNAMIC_EXECUTION=0 was set, cannot eval",
    };
  }

  const report = {
    format: "cap-emscripten-abi-runtime-evidence-v1",
    environment:
      `${process.release.name} ${process.version}; worker global shim only; no browser or extension runtime`,
    results: {
      numeric: { verdict: "pass", output: numericOutput },
      imageResize: {
        verdict: "pass",
        operation:
          "stb linear-colorspace RGBA 2x2 to 1x1 using default Mitchell downsampling",
        output: resizeOutput,
      },
      mainSideWithoutEmbeddedJs: {
        verdict: "pass",
        output: linkedOutput,
        packagedAssetReads: linked.requests.map((request) =>
          new URL(request).pathname.split("/").at(-1)
        ),
      },
      sideWithEmAsm: embeddedJs["em-asm"],
      sideWithEmJs: embeddedJs["em-js"],
      nativeAmbientGlobalAdversary: {
        verdict: "unsafe-demonstrated",
        outputHex: `0x${globalProbeOutput.toString(16)}`,
        meaning:
          "DYNAMIC_EXECUTION=0 alone did not stop native EM_JS from observing globalThis.fetch and globalThis.WebAssembly",
      },
    },
    networkObservation: {
      verdict: "not-measured",
      reason:
        "The local runner substitutes fixture fetch only during factory initialization and has no full-lifecycle network instrumentation.",
    },
  };
  if (mode === "--all") {
    await writeFile(
      new URL("./runtime-report.json", import.meta.url),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }
  console.log(
    "numeric=42.5 image=128,128,128,255 linked=42 EM_ASM=unsupported EM_JS=unsupported ambient-global=unsafe-demonstrated network=not-measured",
  );
} else {
  throw new Error(`unknown mode: ${mode}`);
}
