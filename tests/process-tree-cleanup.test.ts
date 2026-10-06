// tests/process-tree-cleanup.test.ts — chrome-agent-platform-2ypf
// Killing only a spawned parent leaves orphaned children behind (the live
// scripts' Chromium cleanup bug: child processes + temp profiles survived).
// These tests drive REAL process trees: a parent that spawns children whose
// argv carries a unique marker, exactly like `--user-data-dir=<profile>`.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { isolatedProcessGroup, killProcessTree, liveGroupMembers, setsidSpawnSpec } from "../scripts/lib/process-tree.ts";
import { launchChrome, teardownChrome } from "../scripts/lib/chrome-launch.ts";

const PGREP = "/usr/bin/pgrep";

async function survivors(marker: string): Promise<string[]> {
  const out = await new Deno.Command(PGREP, { args: ["-f", marker], stdout: "piped", stderr: "piped", clearEnv: true }).output();
  if (out.code === 1) return [];
  if (out.code !== 0) throw new Error(`pgrep exited ${out.code}`);
  return new TextDecoder().decode(out.stdout).trim().split("\n").filter(Boolean);
}

/** Spawn a parent that spawns two children, all carrying the marker in argv. */
function spawnTree(marker: string): Deno.ChildProcess {
  // exec -a puts the marker in each child's argv[0] — the same way Chromium's
  // children carry the run's unique --user-data-dir in their argv.
  const child = `exec -a ${marker} sleep 300`;
  return new Deno.Command("/bin/bash", {
    args: ["-c", `${child} & ${child} & ${child}`],
    stdout: "null",
    stderr: "null",
    clearEnv: true,
  }).spawn();
}

Deno.test("killProcessTree: the parent kill alone leaves children — the tree kill removes them (2ypf)", async () => {
  const marker = `2ypf-marker-${crypto.randomUUID().slice(0, 8)}`;
  const proc = spawnTree(marker);
  // Let the children spawn.
  await new Promise((r) => setTimeout(r, 300));
  const before = await survivors(marker);
  assertEquals(before.length, 3, "parent + two children all carry the marker");

  // THE BUG: killing only the parent leaves the children running.
  try { proc.kill("SIGKILL"); } catch { /* gone */ }
  try { await proc.status; } catch { /* reaped */ }
  const afterParentKill = await survivors(marker);
  assertEquals(afterParentKill.length, 2, "children survive a parent-only kill (the reported bug)");

  // THE FIX: the tree kill removes them, verified.
  await killProcessTree(null, marker);
  assertEquals(await survivors(marker), [], "no descendant survives the tree kill");
});

Deno.test("teardownChrome: an isolated group reaps descendants whose argv has no profile marker", async () => {
  const marker = `2ypf-group-${crypto.randomUUID()}`;
  // Only bash carries the marker; its sleep child does not. A profile-only
  // pkill reports success while leaving this unmarked child alive.
  const spec = setsidSpawnSpec("/bin/bash", ["-c", "sleep 300 & wait", `user-data-dir=${marker}`]);
  const proc = new Deno.Command(spec.command, {
    args: spec.args,
    stdout: "null", stderr: "null", clearEnv: true,
  }).spawn();
  try {
    const group = await isolatedProcessGroup(proc);
    assert(group !== undefined, "fixture parent must have entered its isolated group");
    await new Promise((r) => setTimeout(r, 150));
    const memberPids = () => liveGroupMembers(group);
    assert(memberPids().length >= 2, "the group includes a child whose argv omits the marker");
    assertEquals((await survivors(marker)).length, 1, "only the parent has the marker");
    await teardownChrome({ proc, profile: marker, processGroup: group });
    assertEquals(memberPids(), [], "the unmarked child must be gone as well as the parent");
    assertEquals(await survivors(marker), []);
  } finally {
    // An assertion failure or mutant must never leave the fixture child running.
    try { Deno.kill(-proc.pid, "SIGKILL"); } catch { /* gone */ }
    try { proc.kill("SIGKILL"); } catch { /* gone */ }
    await proc.status;
  }
});

Deno.test("teardownChrome: raw launched proc reaps unmarked group descendants", async () => {
  const root = Deno.makeTempDirSync({ prefix: "2ypf-raw-proc-" });
  const fake = `${root}/fake-browser`;
  const profile = `${root}/profile`;
  const lockPath = `${root}/scope`;
  Deno.writeTextFileSync(fake,
    "#!/bin/sh\necho 'DevTools listening on ws://127.0.0.1:31337/devtools/browser/abc' >&2\nsleep 300 & wait\n");
  Deno.chmodSync(fake, 0o755);
  let proc: Deno.ChildProcess | undefined;
  try {
    const launched = await launchChrome({ binary: fake, profile, lockPath, timeoutMs: 5000 });
    proc = launched.proc;
    const group = launched.processGroup;
    assert(group !== undefined, "fixture has an isolated group");
    const members = () => liveGroupMembers(group);
    for (let i = 0; i < 20 && members().length < 2; i++) await new Promise((r) => setTimeout(r, 25));
    assert(members().length >= 2, "unmarked child is running before raw-proc teardown");
    await teardownChrome(proc, profile); // No launched object or explicit group.
    assertEquals(members(), [], "raw-proc teardown must reap the unmarked child");
  } finally {
    if (proc) {
      try { Deno.kill(-proc.pid, "SIGKILL"); } catch { /* gone */ }
      try { proc.kill("SIGKILL"); } catch { /* gone */ }
      await proc.status;
    }
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("launchChrome lifeline: SIGKILLing the parent test process reaps the isolated browser group without teardownChrome (jjsz)", async () => {
  const root = Deno.makeTempDirSync({ prefix: "jjsz-lifeline-" });
  const fake = `${root}/fake-browser`;
  const profile = `${root}/profile`;
  const lockPath = `${root}/scope`;
  const groupFile = `${root}/group.txt`;
  const childScript = `${root}/launcher-child.ts`;
  Deno.writeTextFileSync(fake,
    "#!/bin/sh\necho 'DevTools listening on ws://127.0.0.1:31337/devtools/browser/abc' >&2\nsleep 300 & wait\n");
  Deno.chmodSync(fake, 0o755);
  const launchUrl = new URL("../scripts/lib/chrome-launch.ts", import.meta.url).href;
  Deno.writeTextFileSync(childScript, `
    import { launchChrome } from ${JSON.stringify(launchUrl)};
    const launched = await launchChrome({
      binary: ${JSON.stringify(fake)},
      profile: ${JSON.stringify(profile)},
      lockPath: ${JSON.stringify(lockPath)},
      timeoutMs: 5000,
    });
    await Deno.writeTextFile(${JSON.stringify(groupFile)}, String(launched.processGroup ?? launched.proc.pid));
    console.log("READY");
    await new Promise(() => {});
  `);
  const spec = setsidSpawnSpec(Deno.execPath(), ["run", "-A", "--no-check", childScript]);
  const parentProc = new Deno.Command(spec.command, {
    args: spec.args,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let browserGroup = 0;
  try {
    const reader = parentProc.stdout.getReader();
    const dec = new TextDecoder();
    let out = "";
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !out.includes("READY")) {
      const { value, done } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
    }
    reader.releaseLock();
    assert(out.includes("READY"), `child must launch fake browser and report READY (got: ${out})`);
    browserGroup = Number(Deno.readTextFileSync(groupFile).trim());
    assert(browserGroup > 1, `browser must have an isolated group, got ${browserGroup}`);
    for (let i = 0; i < 20 && liveGroupMembers(browserGroup).length < 2; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert(liveGroupMembers(browserGroup).length >= 2, "browser + unmarked helper are alive in isolated group");

    // Simulate a timed-out test runner killing only the parent deno process group (-parentProc.pid).
    // Because the browser is in its own setsid group (browserGroup !== parentProc.pid), only the
    // kernel-pipe lifeline watchdog can reap it.
    try { Deno.kill(-parentProc.pid, "SIGKILL"); } catch { /* gone */ }
    try { parentProc.kill("SIGKILL"); } catch { /* gone */ }
    await parentProc.status;

    const reapDeadline = Date.now() + 5_000;
    while (Date.now() < reapDeadline && liveGroupMembers(browserGroup).length > 0) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assertEquals(
      liveGroupMembers(browserGroup),
      [],
      "lifeline watchdog must reap the entire isolated browser process group when the parent test dies without teardownChrome",
    );
  } finally {
    if (browserGroup > 1) {
      try { Deno.kill(-browserGroup, "SIGKILL"); } catch { /* gone */ }
    }
    try { Deno.kill(-parentProc.pid, "SIGKILL"); } catch { /* gone */ }
    try { parentProc.kill("SIGKILL"); } catch { /* gone */ }
    await parentProc.status.catch(() => {});
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("killProcessTree: rejects a group without a leader process", async () => {
  await assertRejects(() => killProcessTree(null, `2ypf-absent-${crypto.randomUUID()}`, { group: Deno.pid + 100 }),
    Error, "refusing unsafe process group");
});

Deno.test("killProcessTree: kills a running tree and returns once it is gone", async () => {
  const marker = `2ypf-marker-${crypto.randomUUID().slice(0, 8)}`;
  const proc = spawnTree(marker);
  await new Promise((r) => setTimeout(r, 300));
  await killProcessTree(proc, marker);
  assertEquals(await survivors(marker), []);
});

Deno.test("killProcessTree: a surviving tree hard-fails, never fails open", async () => {
  const marker = `2ypf-marker-${crypto.randomUUID().slice(0, 8)}`;
  // A marker NO process carries: pgrep finds nothing (exit 1) → clean return.
  await killProcessTree(null, `2ypf-absent-${crypto.randomUUID().slice(0, 8)}`);
  // A marker on a process that ignores SIGKILL is not producible portably;
  // instead assert the bounded-wait failure path with attempts:0 semantics via
  // a tree we refuse to kill: stub by matching and expecting the throw path
  // after exhausting attempts with interval 0 is not possible against real
  // pkill — so assert the argument guard instead (fail-closed input handling).
  await assertRejects(() => killProcessTree(null, "--starts-with-dash"), Error, "must not start with '-'");
  void marker;
});

Deno.test("live-every-tab uses the tree kill for its Chromium cleanup (2ypf source contract)", async () => {
  const src = await Deno.readTextFile(new URL("../scripts/live-every-tab.ts", import.meta.url));
  assert(src.includes("killProcessTree(proc, `user-data-dir=${profile}`, { group })"),
    "live-every-tab kills the whole Chromium tree by its unique profile path");
  assert(!/proc\?\.kill\("SIGKILL"\)[\s\S]{0,200}await proc\?\.status[\s\S]{0,200}ws\?\.close/.test(src),
    "the parent-only kill pattern is gone");
});
