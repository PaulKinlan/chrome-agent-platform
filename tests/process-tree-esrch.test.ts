// tests/process-tree-esrch.test.ts — gate-speed (2026-10-08): processGroup() treats a /proc stat read that
// fails ESRCH (the task died between the open and the read) as "absent", exactly like a missing /proc
// entry, instead of throwing out of liveGroupMembers(). The REAL error is produced here, not a string.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { isEsrch, processGroup } from "../scripts/lib/process-tree.ts";

Deno.test("gate-speed: a REAL read of a dead task's open /proc stat file is recognised as ESRCH", async () => {
  if (Deno.build.os !== "linux") return; // /proc semantics are Linux-only; macOS uses the ps path
  const child = new Deno.Command("/bin/true").spawn();
  const file = Deno.openSync(`/proc/${child.pid}/stat`);
  try {
    await child.status; // reaped: the open handle now points at a dead task
    let caught: unknown = null;
    try {
      file.readSync(new Uint8Array(4096));
    } catch (e) {
      caught = e;
    }
    assert(caught !== null, "reading a reaped task's stat must fail");
    assertEquals(isEsrch(caught), true, `expected ESRCH, got ${String(caught)}`);
  } finally {
    file.close();
  }
});

Deno.test("gate-speed: isEsrch is narrow — ENOENT, EACCES-shaped and non-Error values are not ESRCH", () => {
  let enoent: unknown = null;
  try {
    Deno.readTextFileSync("/proc/0/definitely-not-here");
  } catch (e) {
    enoent = e;
  }
  assertEquals(isEsrch(enoent), false);
  assertEquals(isEsrch(new Error("Permission denied (os error 13)")), false);
  assertEquals(isEsrch("No such process (os error 3)"), false);
  assertEquals(isEsrch(new Error("No such process (os error 3)")), true);
});

Deno.test("gate-speed: processGroup of an exited, reaped pid is null (absent), never a throw", async () => {
  if (Deno.build.os !== "linux") return;
  const child = new Deno.Command("/bin/true").spawn();
  await child.status;
  assertEquals(processGroup(child.pid), null);
});
