// tests/serial-phase-resilience.test.ts — chrome-agent-platform-6yrq
//
// Proves the serial gate phase is resilient against indefinite wedges:
//   1. runSerialFile (scripts/lib/serial-phase.mjs) executes serial hazard files
//      with process isolation and per-file timeouts (CAP_SERIAL_TEST_TIMEOUT_MS);
//      a hung child is terminated with SIGKILL and returns exit 124 rather than
//      hanging the runner for hours (xn2q item 3 / 6yrq).
//   2. Behavioural /tmp cleanliness: running the lock tests cleans all temporary
//      lock files and directories, leaving zero leaked locks in /tmp.
//   3. source pin: chrome-launch cancels stderr reader on proc exit, releasing
//      the stream and preventing do_epoll_wait hangs on orphaned grandchild fds.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { runSerialFile } from "../scripts/lib/serial-phase.mjs";
import { durableDir } from "../scripts/lib/durable-root.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

Deno.test("6yrq: runSerialFile times out a hanging test boundedly and returns exit 124", async () => {
  // Spawn a real test script that hangs indefinitely via an unresolving promise.
  // runSerialFile must enforce timeoutMs, kill the child with SIGKILL, and return code 124.
  const tempDir = await Deno.makeTempDir({ dir: durableDir("scratch"), prefix: "cap-hang-probe-" });
  const tempTest = `${tempDir}/hang.test.ts`;
  await Deno.writeTextFile(
    tempTest,
    `// Hanging probe for 6yrq
Deno.test("hangs indefinitely", async () => {
  await new Promise((r) => setTimeout(r, 60000));
});
`,
  );

  try {
    const res = runSerialFile(tempTest, {
      timeoutMs: 1500,
      stdio: "pipe",
      cwd: ROOT,
    });
    assertEquals(res.code, 124, `hanging child must be terminated with exit 124; got ${res.code}`);
    assertEquals(res.timedOut, true, "runner must report timedOut: true");
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("6yrq: lock tests clean up temporary lock files and leave /tmp clean", async () => {
  // Count pre-existing lock files in /tmp
  const scanLocks = () => {
    const list = [];
    try {
      for (const entry of Deno.readDirSync("/tmp")) {
        if (
          entry.name.startsWith("cap-chrome-lock-test-") ||
          entry.name.startsWith("cap-lock-scope-") ||
          entry.name.startsWith("cap-slot-dir-")
        ) {
          list.push(entry.name);
        }
      }
    } catch { /* ignore */ }
    return new Set(list);
  };

  const before = scanLocks();

  // Run the lock tests through the real runner
  const res = runSerialFile("tests/chrome-launch-lock.test.ts", {
    stdio: "pipe",
    cwd: ROOT,
  });
  assertEquals(res.code, 0, "chrome-launch-lock must pass cleanly");

  const after = scanLocks();
  const leaked = [...after].filter((name) => !before.has(name));
  assertEquals(leaked, [], `lock tests must not leak temporary lock files in /tmp: ${leaked.join(", ")}`);
});

Deno.test("source pin: chrome-launch cancels stderr reader on proc exit", async () => {
  const src = await Deno.readTextFile(`${ROOT}scripts/lib/chrome-launch.ts`);
  assert(
    src.includes("reader.cancel()"),
    "scripts/lib/chrome-launch.ts must cancel the stderr reader when proc exits",
  );
});
