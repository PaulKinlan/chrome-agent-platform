// @ts-nocheck — scratch S1 focused unit tests (no Chrome).
//
// SPLIT OUT OF tests/wasm-sync-workspace.test.ts (chrome-agent-platform-ifu81). That file's
// "S1 seed: count and total boundary pins" case measured 378s as ONE case, 21% of the flat 1800s
// parallel-phase bound, and while it held a worker the browser and process-supervision suites sharing
// the pool were starved — the mechanism behind the gate-only reds on that bead (openCdp deadline,
// launchChrome retry, kat starvation, acp-bridge logging, lost SIGTERM) that were green when run alone.
//
// THE COST IS THE 10 MiB VALIDATION, not the arithmetic around it. Measured per statement with the same
// helpers (imp-rec, 2026-10-24): the exact-10-MiB scratch total validates in 133.5s, the per-file 10 MiB
// in 133.5s, and EVERY OTHER boundary assertion in that case is 0.0-1.6s. So the fix is to give the two
// maximum-size validations their own files, where they run in their OWN workers — 2 x ~135s in parallel
// instead of 378s of one worker, with the cheap boundary assertions finishing in seconds instead of
// queueing behind 6 minutes of byte-walking.
//
// WHAT IS ASSERTED HERE IS EXACTLY WHAT THE ORIGINAL CASE ASSERTED: the 10 MiB scratch total is accepted
// AT the limit. Nothing is weakened, and nothing moves to a "no assertion" fast path — a split that
// turned one slow assertion into two vacuous ones would be worse than the slow case.
//
// (The 133s itself is a PRODUCT finding, not a test-shape one: exactDenseByteArray() in
// extension/lib/wasm-sync-workspace.js calls Object.getOwnPropertyDescriptor(value, String(index)) once
// per byte plus Reflect.ownKeys(value) over the whole array, i.e. ~21M reflective calls for 10 MiB. It is
// filed separately; fixing the validator would make this file fast and is not this bead's scope.)
import { assertEquals } from "jsr:@std/assert@1";
import { SCRATCH_FILE_LIMITS, validateWorkspaceSeed } from "../extension/lib/wasm-sync-workspace.js";

const row = (path, bytes) => ({ path, bytes });
const dense = (length, value = 1) => new Array(length).fill(value);

Deno.test("ifu81: the scratch class TOTAL is accepted exactly at its limit (10 MiB, nothing less)", () => {
  const limit = SCRATCH_FILE_LIMITS.maxTotalBytes;
  const accepted = validateWorkspaceSeed({ files: [row("scratch/big.bin", dense(limit))] });
  // ACCEPTED, and the bytes survive the freeze with their length intact — the assertion is about the
  // seeded content, not merely about "no throw".
  assertEquals(accepted.files.length, 1);
  assertEquals(accepted.files[0].path, "scratch/big.bin");
  assertEquals(accepted.files[0].bytes.length, limit);
  assertEquals(Object.isFrozen(accepted.files[0].bytes), true);
});
