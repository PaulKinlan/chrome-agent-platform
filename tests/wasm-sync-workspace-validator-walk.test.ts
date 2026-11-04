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

// ---------------------------------------------------------------------------
// j7k25: pins for the BOUNDED key-set proof that replaced the per-byte
// reflective walks (Reflect.ownKeys + getOwnPropertyDescriptor per index,
// ~13 s/MiB). Everything a bounded proof can still see must fail exactly as
// before, and the two documented residuals (enumerable index accessor with a
// valid-byte getter; extra nonenumerable string key) are pinned AS residuals:
// accepted, snapshotted once, and inert in the frozen output — so any future
// change to either behaviour is a deliberate, reviewed act.
// ---------------------------------------------------------------------------

Deno.test("j7k25: the byte validator's bounded proof — no full own-keys materialization, one dense result", async () => {
  const source = await Deno.readTextFile(new URL("../extension/lib/wasm-sync-workspace.js", import.meta.url));
  const blockStart = source.indexOf("function exactDenseByteArray");
  const blockEnd = source.indexOf("function classForPath", blockStart);
  assert(blockStart >= 0 && blockEnd > blockStart, "the byte validator exists");
  const block = source.slice(blockStart, blockEnd);
  assert(!block.includes("Reflect.ownKeys"), "j7k25: the ~6.5s-per-10.5M-keys materialization must not come back");
  assert(!block.includes("getOwnPropertyDescriptor(value, String"), "j7k25: no per-index String(index) descriptor walk");
  assert(block.includes("Object.keys(value)"), "the bounded key-set proof uses the own enumerable keys");
  assert(block.includes("Object.getOwnPropertySymbols(value)"), "the bounded symbol check is present");
});

Deno.test("j7k25: enumerable key-set hostility on a REAL array still fails — extra keys, noncanonical keys, out-of-range indices, setters, nonenumerable indices", () => {
  // extra enumerable string key
  const extra = [1, 2]; extra.evil = 1;
  expectSeedFail({ files: [row("scratch/a.bin", extra)] }, "extra enumerable string key");
  // noncanonical enumerable key ("01" sorts after the canonical indices)
  const noncanon = [1, 2];
  Object.defineProperty(noncanon, "01", { value: 9, enumerable: true, configurable: true });
  expectSeedFail({ files: [row("scratch/b.bin", noncanon)] }, "noncanonical index key");
  // enumerable index beyond length
  const beyond = [1, 2]; beyond[5] = 3;
  expectSeedFail({ files: [row("scratch/c.bin", beyond)] }, "enumerable index beyond length");
  // enumerable setter-only index: Get yields undefined -> byte check
  const setterOnly = [1, 2, 3];
  Object.defineProperty(setterOnly, 0, { set() {}, enumerable: true, configurable: true });
  expectSeedFail({ files: [row("scratch/d.bin", setterOnly)] }, "setter-only index");
  // nonenumerable index data: the enumerable count no longer matches length.
  // (Pre-j7k25 ownKeys ACCEPTED this shape; the bounded proof is stricter.)
  const nonEnumIndex = [1, 2, 3];
  Object.defineProperty(nonEnumIndex, 0, { value: 1, enumerable: false, configurable: true });
  expectSeedFail({ files: [row("scratch/e.bin", nonEnumIndex)] }, "nonenumerable index");
  // hole / sparse stay caught by BOTH the count and the byte check
  expectSeedFail({ files: [row("scratch/f.bin", [1, , 3])] }, "sparse");
  expectSeedFail({ files: [row("scratch/g.bin", Array(3))] }, "holes");
});

Deno.test("j7k25 residual 1: an enumerable index accessor with a valid-byte getter is snapshotted EXACTLY ONCE and the frozen output is inert to later answers", () => {
  let calls = 0;
  const arr = [1, 2, 3];
  Object.defineProperty(arr, 1, {
    get() { calls++; return calls === 1 ? 42 : 99; },
    enumerable: true,
    configurable: true,
  });
  const ok = validateWorkspaceSeed({ files: [{ path: "scratch/getter.bin", bytes: arr }] });
  assertEquals(calls, 1, "the single Get walk reads each index exactly once — no second observation exists");
  assertEquals([...ok.files[0].bytes], [1, 42, 3], "the snapshot is the first (and only) answer");
  assertEquals(calls, 1, "validation itself did not re-read");
  // the getter's later answers cannot reach the frozen canonical clone
  assertEquals(ok.files[0].bytes[1], 42);
  assert(Object.isFrozen(ok.files[0].bytes));
});

Deno.test("j7k25 residual 2: an extra NONENUMERABLE string key is invisible to the bounded proof and inert in the output", () => {
  const arr = [1, 2];
  Object.defineProperty(arr, "hidden", { value: "payload", enumerable: false, configurable: true });
  const ok = validateWorkspaceSeed({ files: [{ path: "scratch/hidden.bin", bytes: arr }] });
  assertEquals([...ok.files[0].bytes], [1, 2], "the dense output carries only the canonical indices");
  assertEquals(ok.files[0].bytes.length, 2);
  assertEquals((ok.files[0].bytes as any).hidden, undefined, "the hidden key cannot ride into the clone");
});

Deno.test("j7k25: a getter that MUTATES the input mid-walk is caught by the bounded post-walk re-check", () => {
  // (a) truncating the length mid-walk: the walk hits the missing tail as
  // undefined (byte check) AND the post-walk length descriptor re-check fails.
  const trunc = [1, 2, 3];
  Object.defineProperty(trunc, 1, {
    get() { trunc.length = 1; return 7; },
    enumerable: true,
    configurable: true,
  });
  expectSeedFail({ files: [row("scratch/trunc.bin", trunc)] }, "mid-walk length truncation");
  // (b) swapping the prototype mid-walk: every byte still validates, so ONLY
  // the post-walk prototype re-check can see it.
  const proto = [1, 2, 3];
  Object.defineProperty(proto, 1, {
    get() { Object.setPrototypeOf(proto, Object.prototype); return 7; },
    enumerable: true,
    configurable: true,
  });
  expectSeedFail({ files: [row("scratch/proto.bin", proto)] }, "mid-walk prototype swap");
});
