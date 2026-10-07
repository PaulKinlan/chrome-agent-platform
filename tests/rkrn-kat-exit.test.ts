// rkrn: importing the KAT as a unit test must not launch Chrome. Only the
// standalone scripts/ run drives the extension; here we pin its exit seam.
import { assertEquals } from "jsr:@std/assert@1";
import { runForVerdict } from "../scripts/kat-sidebar-hydration-race.ts";

Deno.test("rkrn KAT: a fulfilled journey exits 0 and an assertion/teardown failure exits 1", async () => {
  const reported: unknown[] = [];
  let ran = 0;
  const green = await runForVerdict(async () => { ran++; }, (error) => reported.push(error));
  assertEquals(green, 0);
  assertEquals(ran, 1);
  assertEquals(reported, []);

  const red = await runForVerdict(async () => { throw new Error("injected KAT failure"); },
    (error) => reported.push(error));
  assertEquals(red, 1, "a journey rejection must propagate as a nonzero process exit");
  assertEquals(reported.map(String), ["Error: injected KAT failure"]);
});
