// @ts-nocheck — scratch S1 focused unit tests (no Chrome).
//
// The per-FILE half of the ifu81 split; see wasm-sync-workspace-seed-total-limit.test.ts for the full
// reasoning. Two 10 MiB validations were inside one 378s case; each now has its own file, so each gets
// its own worker and neither can hold the pool for six minutes while the browser suites run.
//
// This is the per-file limit (maxFileBytes) rather than the class total (maxTotalBytes). They happen to
// be the same number today — which is exactly why they were worth separating: if one of them moves, the
// other must still be proven independently, and in the original case a single dense(10 MiB) call was
// doing double duty for both.
import { assertEquals } from "jsr:@std/assert@1";
import { SCRATCH_FILE_LIMITS, validateWorkspaceSeed } from "../extension/lib/wasm-sync-workspace.js";

const row = (path, bytes) => ({ path, bytes });
const dense = (length, value = 1) => new Array(length).fill(value);

Deno.test("ifu81: a scratch FILE is accepted exactly at its per-file limit, and the bytes are preserved", () => {
  const limit = SCRATCH_FILE_LIMITS.maxFileBytes;
  const accepted = validateWorkspaceSeed({ files: [row("scratch/f.bin", dense(limit, 7))] });
  assertEquals(accepted.files.length, 1);
  assertEquals(accepted.files[0].bytes.length, limit);
  // The VALUE matters: a validator that accepted the length and dropped the content would pass a
  // length-only assertion. Both ends and the middle are checked.
  assertEquals([accepted.files[0].bytes[0], accepted.files[0].bytes[limit >> 1], accepted.files[0].bytes[limit - 1]], [7, 7, 7]);
  assertEquals(Object.isFrozen(accepted.files[0].bytes), true);
});
