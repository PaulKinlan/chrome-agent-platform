// @ts-nocheck — scratch S1 focused unit tests (no Chrome).
//
// MOVED VERBATIM OUT OF tests/wasm-sync-workspace.test.ts (chrome-agent-platform-ifu81), the fifth and
// last of that file's 10 MiB cases: it measured 2m8s (128s) there, essentially all of it the single
// indexed walk over a 10 MiB byte array. One worker held for two minutes starves the browser and
// process-supervision suites sharing the pool — see the sibling files for the full measurement.
//
// The case text is unchanged: it still asserts that exactDenseByteArray() makes ONE indexed walk and
// never routes the values through the helper, which is exactly the property whose COST (two reflective
// passes per byte — Object.getOwnPropertyDescriptor per index plus Reflect.ownKeys) is filed separately
// as a product finding.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { SCRATCH_FILE_LIMITS, createSyncWorkspace, validateWorkspaceSeed } from "../extension/lib/wasm-sync-workspace.js";

function expectSeedFail(seed, label) {
  try {
    validateWorkspaceSeed(seed);
    throw new Error(`MISMATCH ${label}: seed accepted`);
  } catch (error) {
    if (error?.code !== "job-seed" && !String(error?.message ?? "").includes("job-seed")) {
      throw new Error(`MISMATCH ${label}: wrong failure ${error?.message}`);
    }
  }
}

const row = (path, bytes) => ({ path, bytes });
const dense = (length, value = 1) => new Array(length).fill(value);

Deno.test("S1 validator: exactDenseByteArray is a SINGLE indexed walk — one fresh dense result, never routed through the values helper", async () => {
  // Structural proof (the reviewer's blocker): the byte validator's own block
  // must NOT call the values helper (no intermediate full values array at the
  // 10 MiB boundary) and must build exactly one dense result.
  const source = await Deno.readTextFile(new URL("../extension/lib/wasm-sync-workspace.js", import.meta.url));
  const blockStart = source.indexOf("function exactDenseByteArray");
  const blockEnd = source.indexOf("function classForPath", blockStart);
  assert(blockStart >= 0 && blockEnd > blockStart, "the byte validator exists");
  const block = source.slice(blockStart, blockEnd);
  assert(!block.includes("exactDenseArrayValues"), "the byte validator is its own single walk, not values+dense");
  assert(block.includes("dense.push"), "the byte validator builds its ONE fresh dense result");
  assert((block.match(/dense\.push\(/g) ?? []).length === 1, "exactly one dense result construction");
  // Non-vacuity: the single-walk validator preserves the exact semantics —
  // valid dense byte arrays validate + every hostile value fails job-seed.
  const ok = validateWorkspaceSeed({ files: [{ path: "scratch/b.bin", bytes: [1, 2, 255] }] });
  assertEquals([...ok.files[0].bytes], [1, 2, 255]);
  const big = validateWorkspaceSeed({ files: [{ path: "scratch/big.bin", bytes: dense(10 * 1024 * 1024) }] });
  assertEquals(big.files[0].bytes.length, 10 * 1024 * 1024);
  for (const bad of [[256], [-1], [1.5], [NaN], [Infinity], [1, , 3]]) {
    expectSeedFail({ files: [{ path: "scratch/b.bin", bytes: bad }] }, "byte-range " + JSON.stringify(bad));
  }
  // a getter/setter or a symbol key on the byte array still fails
  expectSeedFail({ files: [{ path: "scratch/g.bin", bytes: [1], [Symbol("x")]: 2 }] }, "bytes symbol key");
  expectSeedFail({ files: [{ path: "scratch/s.bin", get bytes() { return [1]; } }] }, "bytes getter");
});
