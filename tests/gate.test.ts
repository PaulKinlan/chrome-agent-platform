// tests/gate.test.ts — gate-speed: `npm run gate` (scripts/gate.mjs) must run EXACTLY the sequential full
// gate's commands (same files, same assertions), fall back to the sequential chain rather than skip
// test:build, and never leak a sibling worktree.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { gateSteps, sequentialReason, siblingOwnerPid, sweepStaleSiblings } from "../scripts/gate.mjs";
import { durableDir } from "../scripts/lib/durable-root.mjs";

const pkg = JSON.parse(await Deno.readTextFile(new URL("../package.json", import.meta.url)));

Deno.test("gate: its three steps ARE the package scripts of the sequential gate, verbatim", () => {
  const steps = gateSteps();
  assertEquals(steps.map((s) => s.name), ["build:production", "npm test", "test:build"]);
  assertEquals(`${steps[0].cmd} ${steps[0].args.join(" ")}`, pkg.scripts["build:production"]);
  assertEquals(`${steps[1].cmd} ${steps[1].args.join(" ")}`, pkg.scripts.test);
  assertEquals(`${steps[2].cmd} ${steps[2].args.join(" ")}`, pkg.scripts["test:build"]);
  assertEquals(pkg.scripts.gate, "node scripts/gate.mjs");
});

Deno.test("gate: sequential fallback for a dirty tree or on request; overlapped only for a clean tree", () => {
  assertEquals(sequentialReason({ dirty: "", env: {} }), null);
  assert(sequentialReason({ dirty: " M scripts/x.mjs", env: {} }));
  assert(sequentialReason({ dirty: "", env: { CAP_GATE_SEQUENTIAL: "1" } }));
});

Deno.test("gate: the stale-sibling sweep removes ONLY siblings (and logs) whose owning gate is gone", async () => {
  const parent = await Deno.makeTempDir({ dir: durableDir("scratch"), prefix: "gate-sweep-" });
  try {
    const dead = "0123456789ab-111111", live = "0123456789ab-222222", mine = `0123456789ab-${Deno.pid}`;
    for (const d of [dead, live, mine, "not-a-gate-dir"]) await Deno.mkdir(`${parent}/${d}`);
    await Deno.writeTextFile(`${parent}/${dead}.log`, "x");
    await Deno.writeTextFile(`${parent}/${live}.log`, "x");
    const removed: string[] = [];
    const swept = sweepStaleSiblings(parent, {
      isLive: (pid: number) => pid === 222222,
      remove: (path: string) => { removed.push(path); Deno.removeSync(path, { recursive: true }); },
    });
    assertEquals(swept.sort(), [dead, `${dead}.log`].sort());
    assertEquals(removed, [`${parent}/${dead}`]);
    const left = [...Deno.readDirSync(parent)].map((e) => e.name).sort();
    assertEquals(left, ["0123456789ab-222222", "0123456789ab-222222.log", mine, "not-a-gate-dir"].sort());
  } finally {
    await Deno.remove(parent, { recursive: true });
  }
});

Deno.test("gate: sibling names are parsed strictly", () => {
  assertEquals(siblingOwnerPid("0123456789ab-42"), 42);
  assertEquals(siblingOwnerPid("0123456789ab-42x"), null);
  assertEquals(siblingOwnerPid("../0123456789ab-42"), null);
  assertEquals(siblingOwnerPid("scratch"), null);
});
