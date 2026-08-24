// @ts-nocheck — source-contract numeric pins index the frozen rights table by name.
// tests/wasm-host-types.test.ts — R10c (CAP-FB-20260823-R10C-RIGHTS-CONSTANTS):
// the WASI_RIGHTS 30-bit canonical table + the mask decompositions + the
// mutants, all additive. No Chrome; source-contract numeric pins.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PATH_CLASS_RIGHTS, WASI_RIGHTS } from "../extension/lib/wasm-host-types.js";

// The exact bit 0..29 → name mapping. Bits 0..23 are unchanged from the parent
// (the neutrality proof); bits 24..29 are the five added + the one moved.
const BITS = [
  "FD_DATASYNC", // 0
  "FD_READ", // 1
  "FD_SEEK", // 2
  "FD_FDSTAT_SET_FLAGS", // 3
  "FD_SYNC", // 4
  "FD_TELL", // 5
  "FD_WRITE", // 6
  "FD_ADVISE", // 7
  "FD_ALLOCATE", // 8
  "PATH_CREATE_DIRECTORY", // 9
  "PATH_CREATE_FILE", // 10
  "PATH_LINK_SOURCE", // 11
  "PATH_LINK_TARGET", // 12
  "PATH_OPEN", // 13
  "FD_READDIR", // 14
  "PATH_READLINK", // 15
  "PATH_RENAME_SOURCE", // 16
  "PATH_RENAME_TARGET", // 17
  "PATH_FILESTAT_GET", // 18
  "PATH_FILESTAT_SET_SIZE", // 19
  "PATH_FILESTAT_SET_TIMES", // 20
  "FD_FILESTAT_GET", // 21
  "FD_FILESTAT_SET_SIZE", // 22
  "FD_FILESTAT_SET_TIMES", // 23
  "PATH_SYMLINK", // 24 (added)
  "PATH_REMOVE_DIRECTORY", // 25 (added)
  "PATH_UNLINK_FILE", // 26 (added)
  "POLL_FD_READWRITE", // 27 (moved from 26)
  "SOCK_SHUTDOWN", // 28 (added)
  "SOCK_ACCEPT", // 29 (added)
];

Deno.test("R10c: the 30-bit rights table maps every bit 0..29 to its exact name", () => {
  assertEquals(BITS.length, 30, "exactly 30 bits");
  assertEquals(Object.keys(WASI_RIGHTS).length, 30, "the exact key count (no extras)");
  assert(Object.isFrozen(WASI_RIGHTS), "the table is frozen");
  for (let bit = 0; bit < 30; bit++) {
    assertEquals(WASI_RIGHTS[BITS[bit]], 1n << BigInt(bit), `bit ${bit} = ${BITS[bit]}`);
  }
});

Deno.test("R10c: the mask decompositions are byte-identical to the immediate parent", () => {
  // rootRights = PATH_OPEN | PATH_CREATE_FILE | PATH_FILESTAT_GET | FD_READDIR.
  const rootRights = WASI_RIGHTS.PATH_OPEN | WASI_RIGHTS.PATH_CREATE_FILE |
    WASI_RIGHTS.PATH_FILESTAT_GET | WASI_RIGHTS.FD_READDIR;
  assertEquals(rootRights, 0x46400n, "rootRights");
  assertEquals(PATH_CLASS_RIGHTS.inputs.rights, 0x200026n, "inputs class rights");
  assertEquals(PATH_CLASS_RIGHTS.scratch.rights, 0x600066n, "scratch class rights");
  assertEquals(PATH_CLASS_RIGHTS.output.rights, 0x600064n, "output class rights");
  assertEquals(
    PATH_CLASS_RIGHTS.inputs.rights | PATH_CLASS_RIGHTS.scratch.rights |
      PATH_CLASS_RIGHTS.output.rights,
    0x600066n,
    "the inherited rights union",
  );
  assertEquals(WASI_RIGHTS.FD_READ, 0x2n, "stdio read");
  assertEquals(WASI_RIGHTS.FD_WRITE, 0x40n, "stdio write");

  // The sqlite guest-tuple named decomposition (the R10 profile literals).
  const all30 = (1n << 30n) - 1n;
  const readBase = 0xffffffbffeben;
  assertEquals(
    all30 & ~readBase,
    WASI_RIGHTS.FD_DATASYNC | WASI_RIGHTS.FD_WRITE |
      WASI_RIGHTS.FD_ALLOCATE | WASI_RIGHTS.FD_FILESTAT_SET_SIZE,
    "the read request excludes exactly {FD_DATASYNC, FD_WRITE, FD_ALLOCATE, FD_FILESTAT_SET_SIZE}",
  );
  const writeBase = 0xffffffffffffn;
  assertEquals(writeBase & all30, all30, "the write request has all 30 bits");
});

Deno.test("R10c mutants: a wrong table breaks the KAT (non-vacuous)", () => {
  // The exact bit→name mapping already catches a 26↔27 swap, a collision, a
  // renumber ≤23, or a deleted PATH_UNLINK_FILE. These pin the specific
  // positions the mutants target so the assertion is non-vacuous.
  assertEquals(WASI_RIGHTS.PATH_UNLINK_FILE, 1n << 26n, "PATH_UNLINK_FILE at 26");
  assertEquals(WASI_RIGHTS.POLL_FD_READWRITE, 1n << 27n, "POLL_FD_READWRITE moved to 27");
  assert(WASI_RIGHTS.PATH_UNLINK_FILE !== WASI_RIGHTS.POLL_FD_READWRITE, "no 26/26 collision");
  const added = WASI_RIGHTS.PATH_SYMLINK | WASI_RIGHTS.PATH_REMOVE_DIRECTORY |
    WASI_RIGHTS.PATH_UNLINK_FILE | WASI_RIGHTS.SOCK_SHUTDOWN | WASI_RIGHTS.SOCK_ACCEPT;
  assertEquals(added, (1n << 24n) | (1n << 25n) | (1n << 26n) | (1n << 28n) | (1n << 29n), "the five added bits");
  // No class/preopen mask gains any bit ≥24 (the no-mask invariant).
  const bitsGe24 = ((1n << 30n) - 1n) & ~((1n << 24n) - 1n);
  for (const [cls, row] of Object.entries(PATH_CLASS_RIGHTS)) {
    assertEquals(row.rights & bitsGe24, 0n, `${cls} mask has no bit ≥24`);
  }
});
