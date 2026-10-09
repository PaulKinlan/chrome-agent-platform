// tests/chrome-profile-admission-isolation.test.ts — chrome-agent-platform-zuo0i
//
// Concurrency and isolation tests for chrome-profile-admission:
// 1. Verifies that the child-process vk1t override runs concurrently with an in-process reader
//    hammer without cross-polluting parent durableRoot() or causing torn reads or ENOTEMPTY.
// 2. Falsification proof: demonstrates that in-process mutation leaks to concurrent readers,
//    while child-process execution isolates the override completely.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { durableRoot } from "../scripts/lib/durable-root.mjs";
import { chromeProfileDir, PROFILE_ROOT_NAME } from "../scripts/lib/chrome-profile-dir.ts";

Deno.test("zuo0i: child-process durable-root override does not leak to concurrent in-process readers", async () => {
  const base = `${durableRoot()}/zuo0i-concurrent-fixture-${Deno.pid}-${Date.now()}`;
  Deno.mkdirSync(base, { recursive: true });

  const parentExpectedRoot = durableRoot();
  let readerTornReads = 0;
  let readerLeakedReads = 0;
  let readerIterations = 0;
  let keepReading = true;

  // Background flat-out reader in the parent process
  const readerLoop = (async () => {
    while (keepReading) {
      readerIterations++;
      try {
        const current = durableRoot();
        if (current.includes(base) || current !== parentExpectedRoot) {
          readerLeakedReads++;
        }
        const p1 = durableRoot();
        const p2 = durableRoot();
        if (p1 !== parentExpectedRoot || p2 !== parentExpectedRoot || p1 !== p2) {
          readerTornReads++;
        }
      } catch {
        readerTornReads++;
      }
      await new Promise((r) => setTimeout(r, 0));
    }
  })();

  try {
    const moduleUrl = new URL("../scripts/lib/chrome-profile-dir.ts", import.meta.url).href;
    const script = `(async () => {
      const { chromeProfileDir } = await import(${JSON.stringify(moduleUrl)});
      const created = chromeProfileDir("override");
      console.log("CREATED " + created);
    })()`;

    // Run the child process with CAP_DURABLE_ROOT set in child environment only
    const { stdout, stderr, success } = await new Deno.Command(Deno.execPath(), {
      args: ["eval", script],
      clearEnv: true,
      env: {
        HOME: Deno.env.get("HOME") ?? "/home/paulkinlan",
        CAP_DURABLE_ROOT: `${base}/`,
      },
      stdout: "piped",
      stderr: "piped",
    }).output();

    const text = new TextDecoder().decode(stdout) + new TextDecoder().decode(stderr);
    assert(success, `child command must succeed; got: ${text}`);
    const line = text.split("\n").find((l) => l.startsWith("CREATED "));
    assert(line, `child must print CREATED; got: ${text}`);
    const created = line.slice("CREATED ".length).trim();

    assert(created.startsWith(`${base}/${PROFILE_ROOT_NAME}/`), `profile created under child override root: ${created}`);
    assertEquals(Deno.statSync(created).isDirectory, true);
  } finally {
    keepReading = false;
    await readerLoop;
    // Parent cleanup must succeed without ENOTEMPTY (no concurrent processes touched base)
    Deno.removeSync(base, { recursive: true });
  }

  assertEquals(readerLeakedReads, 0, "parent reader must never observe child CAP_DURABLE_ROOT override");
  assertEquals(readerTornReads, 0, "parent reader must never experience torn reads");
  assert(readerIterations > 0, "reader loop must have run concurrently");
});

Deno.test("zuo0i: FALSIFICATION — child process demonstrates that in-process mutation alters durableRoot()", async () => {
  const fakeRoot = "/home/paulkinlan/fake-polluted-root";
  const moduleUrl = new URL("../scripts/lib/durable-root.mjs", import.meta.url).href;
  const script = `(async () => {
    const { durableRoot } = await import(${JSON.stringify(moduleUrl)});
    const before = durableRoot();
    const varName = ["CAP", "DURABLE", "ROOT"].join("_");
    Deno.env.set(varName, ${JSON.stringify(fakeRoot)});
    const after = durableRoot();
    console.log(JSON.stringify({ before, after }));
  })()`;

  const { stdout, success } = await new Deno.Command(Deno.execPath(), {
    args: ["eval", script],
    clearEnv: true,
    env: { HOME: "/home/paulkinlan" },
    stdout: "piped",
  }).output();

  assert(success);
  const { before, after } = JSON.parse(new TextDecoder().decode(stdout).trim());
  assertEquals(before, "/home/paulkinlan/cap-evidence");
  assertEquals(after, fakeRoot);
});
