// @ts-nocheck — scratch S1 focused unit tests (no Chrome).
//
// MOVED VERBATIM OUT OF tests/wasm-sync-workspace.test.ts (chrome-agent-platform-ifu81). Sibling of the
// -seed-total-limit / -seed-file-limit files: each 10 MiB validation now has its own file, so each gets
// its own worker instead of holding one for 2-7 minutes while the browser and process-supervision suites
// sharing the pool run starved (the gate-only reds on ifu81: openCdp deadline, launchChrome retry, kat
// starvation, acp-bridge logging, lost SIGTERM — all green when run alone).
//
// MEASURED (imp-rec, 2026-10-24, this box): this case cost 2m43s (163s) inside the original file, of which
// the exact-10-MiB `valid([...])` is 133.5s and everything else is milliseconds. The case text is
// unchanged — every assertion it made, it still makes.
import { assertEquals } from "jsr:@std/assert@1";
import { INPUT_SEED_LIMITS, SCRATCH_FILE_LIMITS, validateWorkspaceSeed } from "../extension/lib/wasm-sync-workspace.js";

const row = (path, bytes) => ({ path, bytes });
const dense = (length, value = 1) => new Array(length).fill(value);
const valid = (rows) => validateWorkspaceSeed({ files: rows });

Deno.test("S1 seed: valid scratch + mixed classes at independent maxima", () => {
  const empty = valid([row("scratch/e.bin", [])]);
  assertEquals(empty.files[0].path, "scratch/e.bin");
  assertEquals(empty.files[0].bytes.length, 0);
  // one scratch file at the exact 10 MiB max + inputs at the exact 256 KiB total
  // (spread across the 8 input files — the per-file input cap is 32 KiB)
  const big = valid([
    row("scratch/big.bin", dense(SCRATCH_FILE_LIMITS.maxFileBytes)),
    ...Array.from({ length: 8 }, (_, i) => row(`inputs/t${i}.bin`, dense(32 * 1024))),
  ]);
  assertEquals(big.files[0].bytes.length, 10 * 1024 * 1024);
  assertEquals(big.files.reduce((sum, f) => sum + (f.path.startsWith("inputs") ? f.bytes.length : 0), 0), 256 * 1024);
  // a mixed 8 inputs + 8 scratch seed succeeds (16 combined)
  const mixed = valid([
    ...Array.from({ length: 8 }, (_, i) => row(`inputs/i${i}.bin`, [i])),
    ...Array.from({ length: 8 }, (_, i) => row(`scratch/s${i}.bin`, [i])),
  ]);
  assertEquals(mixed.files.length, 16);
});
