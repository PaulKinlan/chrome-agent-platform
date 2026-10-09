// tests/dist-chunk-authority.test.ts — chrome-agent-platform-20e2u
// Authority, exact bijection, bounds, and security gates for shared UI chunks in dist/.

import { fileURLToPath } from "node:url";
import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import {
  createDistCompleteMarker,
  validateDistCompleteMarker,
  writeDistCompleteMarker,
  DIST_COMPLETE_OUTPUTS,
} from "../scripts/dist-complete.mjs";
import {
  assertStoreTargetBoundary,
  STORE_TARGET,
  STORE_EXTENSION_CSP,
  STORE_SANDBOX_CSP,
} from "../scripts/store-target-policy.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

async function createMockDist(distRoot: string, chunks: Array<{ name: string; content: string }> = []) {
  // Populate minimal dummy files for all standard outputs
  for (const out of DIST_COMPLETE_OUTPUTS) {
    const filePath = `${distRoot}/${out}`;
    await Deno.mkdir(filePath.slice(0, filePath.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(filePath, `// dummy content for ${out}\n`);
  }
  for (const chunk of chunks) {
    const chunkPath = `${distRoot}/chunks/${chunk.name}`;
    await Deno.mkdir(chunkPath.slice(0, chunkPath.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(chunkPath, chunk.content);
  }
}

Deno.test("20e2u condition (a): createDistCompleteMarker discovers and records valid chunks in dist/chunks/", async () => {
  const tmp = await Deno.makeTempDir({ dir: durableDir("scratch"), prefix: "cap-chunk-test-" });
  const dist = `${tmp}/dist`;
  try {
    await createMockDist(dist, [
      { name: "chunk-conversation-a1b2c3d4.js", content: "export const conv = 1;\n" },
    ]);

    const marker = await createDistCompleteMarker({
      root: ROOT,
      distRoot: dist,
      target: "store",
    });

    const recordedChunk = marker.outputs.find((o) => o.path === "chunks/chunk-conversation-a1b2c3d4.js");
    assert(recordedChunk !== undefined, "chunks/chunk-conversation-a1b2c3d4.js must be recorded in marker.outputs");
    assertEquals(recordedChunk.size, 23);
    assert(/^[0-9a-f]{64}$/.test(recordedChunk.sha256), "sha256 must be valid hash");
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
});

Deno.test("20e2u condition (a): validateDistCompleteMarker fails closed on unmanifested file in dist/", async () => {
  const tmp = await Deno.makeTempDir({ dir: durableDir("scratch"), prefix: "cap-chunk-test-" });
  const dist = `${tmp}/dist`;
  try {
    await createMockDist(dist, []);
    await writeDistCompleteMarker({
      root: ROOT,
      distRoot: dist,
      target: "store",
    });

    // Plant an unmanifested chunk into dist/chunks after marker creation
    const planted = `${dist}/chunks/chunk-unmanifested.js`;
    await Deno.mkdir(`${dist}/chunks`, { recursive: true });
    await Deno.writeTextFile(planted, "export const secret = true;\n");

    // Exact bijection requirement: any unmanifested file in dist/ fails closed
    await assertRejects(
      async () => {
        await validateDistCompleteMarker({
          root: ROOT,
          distRoot: dist,
          expectedTarget: "store",
        });
      },
      Error,
      "dist.complete validation failed",
    );

    // Also test planting a non-chunk stray file to assert the exact "unmanifested file in dist/" error
    await Deno.remove(planted).catch(() => {});
    const stray = `${dist}/stray.js`;
    await Deno.writeTextFile(stray, "export const stray = 1;\n");

    await assertRejects(
      async () => {
        await validateDistCompleteMarker({
          root: ROOT,
          distRoot: dist,
          expectedTarget: "store",
        });
      },
      Error,
      "unmanifested file in dist/: stray.js",
    );
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
});

Deno.test("20e2u condition (a): validateDistCompleteMarker fails closed on tampered chunk bytes", async () => {
  const tmp = await Deno.makeTempDir({ dir: durableDir("scratch"), prefix: "cap-chunk-test-" });
  const dist = `${tmp}/dist`;
  try {
    await createMockDist(dist, [
      { name: "chunk-core-11223344.js", content: "export const core = 'v1';\n" },
    ]);
    await writeDistCompleteMarker({
      root: ROOT,
      distRoot: dist,
      target: "store",
    });

    // Tamper with the chunk byte on disk
    await Deno.writeTextFile(`${dist}/chunks/chunk-core-11223344.js`, "export const core = 'tampered';\n");

    await assertRejects(
      async () => {
        await validateDistCompleteMarker({
          root: ROOT,
          distRoot: dist,
          expectedTarget: "store",
        });
      },
      Error,
      "marker output is stale: chunks/chunk-core-11223344.js",
    );
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
});

Deno.test("20e2u condition (a): chunk bounds enforced (count <= 10, size <= 500KB)", async () => {
  const tmp = await Deno.makeTempDir({ dir: durableDir("scratch"), prefix: "cap-chunk-test-" });
  const dist = `${tmp}/dist`;
  try {
    // 1. More than 10 chunks fails closed
    const overflowChunks = Array.from({ length: 11 }, (_, i) => ({
      name: `chunk-overflow-${i}.js`,
      content: `export const x = ${i};\n`,
    }));
    await createMockDist(dist, overflowChunks);

    await assertRejects(
      async () => {
        await createDistCompleteMarker({
          root: ROOT,
          distRoot: dist,
          target: "store",
        });
      },
      Error,
      "chunk count exceeds bound: 11 > 10",
    );

    // 2. Oversized chunk (> 500 KB) fails closed
    await Deno.remove(`${dist}/chunks`, { recursive: true }).catch(() => {});
    const hugeChunk = [{
      name: "chunk-huge.js",
      content: "x".repeat(500 * 1024 + 1),
    }];
    await createMockDist(dist, hugeChunk);

    await assertRejects(
      async () => {
        await createDistCompleteMarker({
          root: ROOT,
          distRoot: dist,
          target: "store",
        });
      },
      Error,
      "chunk size",
    );
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
});

Deno.test("20e2u condition (b): assertStoreTargetBoundary REDs on forbidden token in an emitted chunk", async () => {
  const root = await Deno.makeTempDir({ dir: durableDir("scratch"), prefix: "cap-store-chunk-falsifier-" });
  try {
    const manifest = {
      manifest_version: 3,
      name: "fixture",
      version: "1.0.0",
      content_security_policy: {
        extension_pages: STORE_EXTENSION_CSP,
        sandbox: STORE_SANDBOX_CSP,
      },
    };

    const manifestFile = `${root}/manifest.json`;
    await Deno.writeTextFile(manifestFile, `${JSON.stringify(manifest)}\n`);

    const chunkFile = `${root}/dist/chunks/chunk-bad.js`;
    await Deno.mkdir(`${root}/dist/chunks`, { recursive: true });
    // Injected forbidden evaluator: new Function
    await Deno.writeTextFile(chunkFile, "const evil = new Function('return 42');\n");

    const inventory = [
      { archivePath: "manifest.json", sourcePath: manifestFile },
      { archivePath: "dist/chunks/chunk-bad.js", sourcePath: chunkFile },
    ];

    await assertRejects(
      async () => {
        await assertStoreTargetBoundary({
          target: STORE_TARGET,
          inventory,
        });
      },
      Error,
      "static boundary violations",
    );
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("20e2u condition (a): dist.complete rejects sourcemap files in store dist (exact bijection)", async () => {
  const tmp = await Deno.makeTempDir({ dir: durableDir("scratch"), prefix: "cap-sourcemap-test-" });
  const dist = `${tmp}/dist`;
  try {
    await createMockDist(dist);
    // Plant a sourcemap in dist/
    await Deno.writeTextFile(`${dist}/options.bundle.js.map`, '{"version":3}\n');

    await assertRejects(
      async () => {
        await createDistCompleteMarker({
          root: ROOT,
          distRoot: dist,
          target: "store",
        });
      },
      Error,
      "unmanifested sourcemap file in store dist: options.bundle.js.map",
    );

    // Also plant a sourcemap inside wasm-tools/python/ to verify exemption does not bypass .map rejection
    await Deno.mkdir(`${dist}/wasm-tools/python`, { recursive: true });
    await Deno.writeTextFile(`${dist}/wasm-tools/python/stray.js.map`, '{"version":3}\n');
    await Deno.remove(`${dist}/options.bundle.js.map`).catch(() => {});

    // Regression case 1: uppercase .MAP inside wasm-tools/python/
    await Deno.remove(`${dist}/wasm-tools/python/stray.js.map`).catch(() => {});
    await Deno.writeTextFile(`${dist}/wasm-tools/python/stray.MAP`, '{"version":3}\n');
    await assertRejects(
      async () => {
        await createDistCompleteMarker({
          root: ROOT,
          distRoot: dist,
          target: "store",
        });
      },
      Error,
      "unmanifested sourcemap file in store dist: wasm-tools/python/stray.MAP",
    );

    // Regression case 2: crafted .map.gz compound extension
    await Deno.remove(`${dist}/wasm-tools/python/stray.MAP`).catch(() => {});
    await Deno.writeTextFile(`${dist}/wasm-tools/python/x.js.map.gz`, "compressed\n");
    await assertRejects(
      async () => {
        await createDistCompleteMarker({
          root: ROOT,
          distRoot: dist,
          target: "store",
        });
      },
      Error,
      "unmanifested sourcemap file in store dist: wasm-tools/python/x.js.map.gz",
    );

    // Regression case 3: unexpected member inside wasm-tools/python/ (not in pinned manifest)
    await Deno.remove(`${dist}/wasm-tools/python/x.js.map.gz`).catch(() => {});
    await Deno.writeTextFile(`${dist}/wasm-tools/python/unexpected-member.bin`, "binary\n");
    await assertRejects(
      async () => {
        await createDistCompleteMarker({
          root: ROOT,
          distRoot: dist,
          target: "store",
        });
      },
      Error,
      "unexpected member in python runtime dist: wasm-tools/python/unexpected-member.bin",
    );
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
});
