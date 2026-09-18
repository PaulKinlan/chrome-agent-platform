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

import { fileURLToPath } from "node:url";
import { assert, assertEquals } from "jsr:@std/assert@1";
import { runSerialFile } from "../scripts/lib/serial-phase.mjs";
import { durableDir } from "../scripts/lib/durable-root.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

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
  // Attribution, not a shared-prefix scan (chrome-agent-platform-p15i): with
  // ~8 lanes sharing /tmp, a scan for `cap-chrome-lock-test-*` also matches a
  // CONCURRENT lane's fixtures, and a foreign file was flagged as our leak — a
  // false red that tempts retry-until-green. The child reports its own fixture
  // path(s) as CAP_LOCK_FIXTURE:<path> lines; we assert exactly those are gone.
  // A killed child still attributes correctly: the marker is printed at start,
  // and the residue is then genuinely ours.
  const res = runSerialFile("tests/chrome-launch-lock.test.ts", {
    stdio: "pipe",
    cwd: ROOT,
  });
  assertEquals(res.code, 0, "chrome-launch-lock must pass cleanly");

  const out = new TextDecoder().decode(res.stdout ?? new Uint8Array());
  const fixtures = [...out.matchAll(/^CAP_LOCK_FIXTURE:(\S+)$/gm)].map((m) => m[1]);
  assert(fixtures.length > 0, "the child must report its fixture paths (marker protocol broken — never pass vacuously)");
  const leaked = [];
  for (const fixture of fixtures) {
    try {
      await Deno.lstat(fixture);
      leaked.push(fixture);
    } catch { /* gone, as required */ }
  }
  assertEquals(leaked, [], `lock tests must not leak their own temporary lock files: ${leaked.join(", ")}`);
});

Deno.test("pozs: timed-out serial file leaves no descendant processes behind (process group kill)", async () => {
  // Spawn a real test script that launches a long-lived background grandchild process
  // and then hangs. runSerialFile must enforce timeoutMs, kill the entire process group
  // (PGID = r.pid), and ensure the grandchild does not survive as an orphan holding fds/locks.
  const tempDir = await Deno.makeTempDir({ dir: durableDir("scratch"), prefix: "cap-grandchild-probe-" });
  const pidFile = `${tempDir}/grandchild.pid`;
  const tempTest = `${tempDir}/grandchild-hang.test.ts`;
  await Deno.writeTextFile(
    tempTest,
    `import { assert } from "jsr:@std/assert@1";
Deno.test("spawns grandchild and hangs", async () => {
  const p = new Deno.Command("sleep", { args: ["300"], stdout: "null", stderr: "null" }).spawn();
  await Deno.writeTextFile("${pidFile}", String(p.pid));
  await new Promise(() => {});
});
`,
  );

  let grandchildPid = 0;
  try {
    const res = runSerialFile(tempTest, {
      timeoutMs: 1500,
      stdio: "pipe",
      cwd: ROOT,
    });
    assertEquals(res.code, 124, `timed out child must return exit 124; got ${res.code}`);
    assertEquals(res.timedOut, true, "runner must report timedOut: true");

    const pidText = await Deno.readTextFile(pidFile).catch(() => "");
    grandchildPid = Number(pidText.trim());
    assert(grandchildPid > 0, "grandchild pid must have been recorded");

    // Wait briefly and assert the grandchild was reaped with the process group
    let alive = true;
    try {
      Deno.kill(grandchildPid, "SIGCONT");
    } catch {
      alive = false;
    }
    assertEquals(alive, false, `grandchild PID ${grandchildPid} must not survive runner timeout`);
  } finally {
    if (grandchildPid > 0) {
      try { Deno.kill(grandchildPid, "SIGKILL"); } catch { /* gone */ }
    }
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("source pin: serial-phase spawns detached and kills process group on timeout", async () => {
  const src = await Deno.readTextFile(`${ROOT}scripts/lib/serial-phase.mjs`);
  assert(
    src.includes("detached: true"),
    "scripts/lib/serial-phase.mjs must spawn tests detached to establish a process group",
  );
  assert(
    src.includes("process.kill(-r.pid, \"SIGKILL\")"),
    "scripts/lib/serial-phase.mjs must kill the process group (-r.pid) on timeout",
  );
});

Deno.test("source pin: chrome-launch cancels stderr reader on proc exit", async () => {
  const src = await Deno.readTextFile(`${ROOT}scripts/lib/chrome-launch.ts`);
  assert(
    src.includes("reader.cancel()"),
    "scripts/lib/chrome-launch.ts must cancel the stderr reader when proc exits",
  );
});
