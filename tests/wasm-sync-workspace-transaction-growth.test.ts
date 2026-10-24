// @ts-nocheck — scratch S1 focused unit tests (no Chrome).
//
// MOVED VERBATIM OUT OF tests/wasm-sync-workspace.test.ts (chrome-agent-platform-ifu81), same reason as
// its three siblings: the expensive part is a 9 MiB + 1 MiB seed validation (10 MiB total, ~133s of the
// 1m58s this case measured), and one worker held for two minutes starves the browser suites that share
// the pool. The case text is unchanged — every assertion it made, it still makes.
import { assertEquals } from "jsr:@std/assert@1";
import { SCRATCH_FILE_LIMITS, createSyncWorkspace, validateWorkspaceSeed } from "../extension/lib/wasm-sync-workspace.js";

const row = (path, bytes) => ({ path, bytes });
const dense = (length, value = 1) => new Array(length).fill(value);
const valid = (rows) => validateWorkspaceSeed({ files: rows });

Deno.test("S1 transaction: malformed now() fails before mutation; aggregate write-growth invariant", () => {
  const ws = createSyncWorkspace({ root: "tool-jobs/t/c/", now: () => "bad" });
  let code = null;
  try { ws.createScratchFile("scratch/x.bin"); } catch (e) { code = e?.code ?? e?.message; }
  assertEquals(code, "EINVAL");
  assertEquals(ws._inspect().files.includes("scratch/x.bin"), false, "no mutation on malformed now");
  // aggregate growth: A at 9 MiB + B at 1 MiB - 1; a write that grows B past
  // the remaining budget hits the AGGREGATE ENOSPC before mutation (B stays
  // within its per-file bound).
  const big = createSyncWorkspace({ root: "tool-jobs/t/c/", seed: { files: [
    row("scratch/a.bin", dense(9 * 1024 * 1024)),
    row("scratch/b.bin", dense(1024 * 1024 - 1)),
  ] } });
  const h = big.open("scratch/b.bin", { write: true });
  code = null;
  try { h.write(1024 * 1024 - 1, new Uint8Array(2)); } catch (e) { code = e?.code ?? e?.message; }
  assertEquals(code, "ENOSPC", "aggregate growth past 10 MiB -> ENOSPC before mutation");
  assertEquals(big.stat("scratch/b.bin").size, 1024 * 1024 - 1, "no mutation on the denied growth");
  // shrink/equal writes remain allowed
  assertEquals(h.write(0, new Uint8Array(1)), 1);
  // per-file EFBIG on a single write that would exceed the per-file bound
  const per = createSyncWorkspace({ root: "tool-jobs/t/c/", seed: { files: [row("scratch/p.bin", [1])] } });
  const hp = per.open("scratch/p.bin", { write: true });
  code = null;
  try { hp.write(10 * 1024 * 1024 - 1, new Uint8Array(2)); } catch (e) { code = e?.code ?? e?.message; }
  assertEquals(code, "EFBIG");
});
