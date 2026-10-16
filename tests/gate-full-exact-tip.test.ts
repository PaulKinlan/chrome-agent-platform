// Full gate may reuse ONLY an exact-tip marker that ensureStoreBuild has verified.
// It must still run both existing tiers, and must never run either against an
// uncertified dist or turn a failing tier into a green gate.
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { runFullGate } from "../scripts/gate-full.mjs";

Deno.test("sgzyg: valid exact-tip build is reused before both full gate tiers", async () => {
  const calls: string[] = [];
  const result = await runFullGate({
    root: "/isolated-test-root",
    ensure: async (options: Record<string, unknown>) => {
      assertEquals(options.required, true);
      assertEquals(options.root, "/isolated-test-root");
      calls.push("verified");
      return { disposition: "reused", reason: "exact commit/source/output hashes verified", secs: 0.73, markerCommit: "abc" };
    },
    run: (command: string, args: string[], env: Record<string, string>) => {
      assertEquals(command, "npm");
      assertEquals(JSON.parse(env.CAP_GATE_BUILD_JSON).disposition, "reused");
      calls.push(args.join(" "));
      return 0;
    },
  });
  assertEquals(result, 0);
  assertEquals(calls, ["verified", "test", "run test:build"]);
});

Deno.test("sgzyg: invalid build stops before both tiers and names the failure", async () => {
  const calls: string[] = [];
  const logs: string[] = [];
  const result = await runFullGate({
    ensure: async () => ({ disposition: "failed", reason: "output hash mismatch after rebuilding", secs: 0, markerCommit: null }),
    run: () => { calls.push("ran"); return 0; },
    log: (line: string) => logs.push(line),
  });
  assertEquals(result, 1);
  assertEquals(calls, []);
  assertStringIncludes(logs.join("\n"), "output hash mismatch");
});

Deno.test("sgzyg: failed npm test stops before build-behaviour tier; failed build tier stays red", async () => {
  for (const [first, second, expected, calls] of [
    [23, 0, 23, ["test"]],
    [0, 17, 17, ["test", "run test:build"]],
  ] as const) {
    const seen: string[] = [];
    const result = await runFullGate({
      ensure: async () => ({ disposition: "ran", reason: "new certified build", secs: 17, markerCommit: "abc" }),
      run: (_command: string, args: string[]) => {
        seen.push(args.join(" "));
        return seen.length === 1 ? first : second;
      },
    });
    assertEquals(result, expected);
    assertEquals(seen, [...calls]);
  }
});
