import { assert, assertEquals, assertStrictEquals } from "jsr:@std/assert@1";
import { withCleanup } from "../scripts/lib/test-cleanup.js";

Deno.test("mkhzf: a failing teardown reddens a passing body only after all later steps run", async () => {
  const ran: string[] = [];
  const reports: string[] = [];
  const first = new Error("injected cleanup leak");
  const second = new Error("later cleanup failure");
  let caught = false;
  try {
    await withCleanup(() => "body passed", [
      () => { ran.push("first"); throw first; },
      async () => { ran.push("second"); await Promise.resolve(); throw second; },
      () => { ran.push("third"); },
    ], (line) => reports.push(line));
  } catch (error) {
    caught = true;
    assertStrictEquals(error, first, "the first cleanup failure is the verdict on a passing body");
  }
  assert(caught, "a passing test must turn RED when cleanup fails");
  assertEquals(ran, ["first", "second", "third"], "later cleanup still runs in order");
  assertEquals(reports.length, 2, "every failed step is reported");
});

Deno.test("mkhzf: an assertion failure wins over cleanup failure and later teardown still runs", async () => {
  const original = new Error("original assertion");
  const ran: string[] = [];
  let caught = false;
  try {
    await withCleanup(() => { throw original; }, [
      () => { ran.push("failed cleanup"); throw new Error("teardown leak"); },
      () => { ran.push("later cleanup"); },
    ], () => { throw new Error("reporter also failed"); });
  } catch (error) {
    caught = true;
    assertStrictEquals(error, original);
  }
  assert(caught);
  assertEquals(ran, ["failed cleanup", "later cleanup"]);
});

Deno.test("mkhzf: a false watcher wait fails a passing test but later teardown still runs", async () => {
  const ran: string[] = [];
  const reports: string[] = [];
  let caught = false;
  try {
    await withCleanup(() => "body passed", [
      () => { ran.push("watcher timed out"); return false; },
      () => { ran.push("profile teardown"); },
      () => { ran.push("remove fixture"); },
    ], (line) => reports.push(line));
  } catch (error) {
    caught = true;
    assertEquals((error as Error).message, "cleanup step returned false");
  }
  assert(caught, "false from a bounded watcher wait must turn an otherwise passing test RED");
  assertEquals(ran, ["watcher timed out", "profile teardown", "remove fixture"]);
  assertEquals(reports.length, 1);
});

Deno.test("mkhzf: a failing body wins even when the watcher returns false", async () => {
  const original = new Error("assertion already failed");
  const ran: string[] = [];
  let caught = false;
  try {
    await withCleanup(() => { throw original; }, [
      () => { ran.push("watcher timed out"); return false; },
      () => { ran.push("profile teardown"); },
    ], () => {});
  } catch (error) {
    caught = true;
    assertStrictEquals(error, original);
  }
  assert(caught);
  assertEquals(ran, ["watcher timed out", "profile teardown"]);
});

Deno.test("mkhzf: allowFalse is an explicit best-effort opt-out, never a rejected-step opt-out", async () => {
  assertEquals(await withCleanup(() => "body passed", [
    { run: () => false, allowFalse: true },
  ], () => {}), "body passed");
  const error = new Error("still a real cleanup error");
  let caught = false;
  try {
    await withCleanup(() => "body passed", [
      { run: () => { throw error; }, allowFalse: true },
    ], () => {});
  } catch (reason) {
    caught = true;
    assertStrictEquals(reason, error);
  }
  assert(caught);
});

Deno.test("mkhzf mutation: removing the false-step guard hides a timed-out watcher", async () => {
  const source = await Deno.readTextFile(new URL("../scripts/lib/test-cleanup.js", import.meta.url));
  const anchor = "if (result === false && (typeof step === \"function\" || step.allowFalse !== true)) {";
  assertEquals(source.split(anchor).length - 1, 1, "the false-result guard is unique and executable");
  const mutant = source.replace(anchor, "if (false) {");
  const { withCleanup: withoutFalseGuard } = await import(`data:text/javascript,${encodeURIComponent(mutant)}`);
  assertEquals(await withoutFalseGuard(() => "body passed", [() => false], () => {}), "body passed",
    "the mutant improperly accepts a timed-out watcher");
  let caught = false;
  try {
    await withCleanup(() => "body passed", [() => false], () => {});
  } catch { caught = true; }
  assert(caught, "without the guard this assertion becomes RED");
});

Deno.test("mkhzf: undefined rejections count as failures, not an empty sentinel", async () => {
  let caught = false;
  try {
    await withCleanup(() => 1, [() => { throw undefined; }], () => {});
  } catch (error) {
    caught = true;
    assertStrictEquals(error, undefined);
  }
  assert(caught);
});

Deno.test("mkhzf mutation: deleting the cleanup rethrow turns the same failing teardown GREEN", async () => {
  const source = await Deno.readTextFile(new URL("../scripts/lib/test-cleanup.js", import.meta.url));
  const anchor = "if (cleanupFailed) throw firstCleanupError;";
  assertEquals(source.split(anchor).length - 1, 1, "mutation must target the live verdict gate exactly once");
  const mutant = source.replace(anchor, "if (false) throw firstCleanupError;");
  const { withCleanup: withoutVerdict } = await import(`data:text/javascript,${encodeURIComponent(mutant)}`);
  const injected = new Error("teardown leak");
  const ran: string[] = [];
  const green = await withoutVerdict(() => "body passed", [
    () => { ran.push("failed"); throw injected; },
    () => { ran.push("later"); },
  ], () => {});
  assertEquals(green, "body passed", "mutant wrongly masks the cleanup failure");
  assertEquals(ran, ["failed", "later"]);
  let caught = false;
  try {
    await withCleanup(() => "body passed", [() => { throw injected; }], () => {});
  } catch (error) {
    caught = true;
    assertStrictEquals(error, injected);
  }
  assert(caught, "deleting the rethrow must make this assertion RED");
});
