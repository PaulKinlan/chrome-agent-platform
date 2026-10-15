import { assertEquals, assertStrictEquals } from "jsr:@std/assert@1";
import { isMissingMasterJournalHandle } from "../extension/lib/master-journal-opfs-errors.js";
import { readMasterJournalHead } from "../extension/lib/master-journal-wal.js";

Deno.test("cducc: only typed OPFS NotFoundError with the matching code signals optional absence", async () => {
  const missing = new DOMException("journal-wal absent", "NotFoundError");
  assertEquals(missing.code, DOMException.NOT_FOUND_ERR);
  assertEquals(isMissingMasterJournalHandle(missing), true);
  const impostors = [
    new Error("not found: journal-wal"),
    Object.assign(new Error("journal-wal absent"), { name: "NotFoundError", code: 8 }),
    { name: "NotFoundError", code: 8 },
    new DOMException("permission denied", "NotAllowedError"),
  ];
  const wrongCode = new DOMException("journal-wal absent", "NotFoundError");
  Object.defineProperty(wrongCode, "code", { value: 4 });
  impostors.push(wrongCode);
  for (const error of impostors) assertEquals(isMissingMasterJournalHandle(error), false);
  assertEquals(await readMasterJournalHead({ async getDirectoryHandle() { throw missing; } }), null,
    "a genuinely absent pre-cutover WAL may leave legacy authority intact");
  for (const error of impostors) {
    let caught = false;
    try { await readMasterJournalHead({ async getDirectoryHandle() { throw error; } }); }
    catch (actual) { caught = true; assertStrictEquals(actual, error); }
    assertEquals(caught, true, "a non-absence directory error must propagate unchanged");
  }
});

Deno.test("cducc: a present WAL refuses untyped missing heads and pre-head residue", async () => {
  const generic = Object.assign(new Error("missing head-a.json"), { name: "NotFoundError", code: 8 });
  const directory = { async getFileHandle() { throw generic; }, async *entries() {} };
  let caught = false;
  try { await readMasterJournalHead({ async getDirectoryHandle() { return directory; } }); }
  catch (actual) { caught = true; assertStrictEquals(actual, generic); }
  assertEquals(caught, true, "a fake error cannot erase a present WAL's authority");

  const emptyDirectory = {
    async getFileHandle(name: string) { throw new DOMException(`${name} absent`, "NotFoundError"); },
    async *entries() {},
  };
  assertEquals(await readMasterJournalHead({ async getDirectoryHandle() { return emptyDirectory; } }), null);
  const withResidue = { ...emptyDirectory, async *entries() { yield ["checkpoint-1-0.json", {}]; } };
  let refused = false;
  try { await readMasterJournalHead({ async getDirectoryHandle() { return withResidue; } }); }
  catch (error) {
    refused = true;
    assertEquals((error as Error).message, "master journal pre-head residue requires explicit owner repair");
  }
  assertEquals(refused, true, "present unpublished WAL evidence still requires owner repair");
});
