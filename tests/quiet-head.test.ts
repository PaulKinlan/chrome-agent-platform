// tests/quiet-head.test.ts — gate-speed (2026-10-09): the phase that runs a load-sensitive MEASUREMENT
// file first, in a waited-for quiet window (scripts/lib/quiet-head.ts).
//
// The property under test is not "the spinner spins": it is that the phase (a) never measures a
// saturated box — it waits, and refuses with exit 75 if it cannot get one; (b) runs every file it owns
// exactly once, through the same runner as every other phase; and (c) is a no-op when the caller has
// already run it (npm run gate does, before its overlapped sibling build starts).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { ENVIRONMENTAL_REFUSAL_MARKER } from "../scripts/lib/quiet-window.ts";
import { headSpec, main, QUIET_HEAD_DONE_ENV } from "../scripts/lib/quiet-head.ts";
import { QUIET_HEAD } from "../scripts/test-partition.mjs";

Deno.test("gate-speed: the quiet-head wait spec is bounded, and its bound is overridable", () => {
  assertEquals(headSpec({}), { maxWaitMs: 300_000, maxLoadPerCore: 0.5 });
  assertEquals(headSpec({ CAP_QUIET_HEAD_MAX_WAIT_MS: "1000" }).maxWaitMs, 1000);
  assertEquals(headSpec({ CAP_QUIET_HEAD_MAX_WAIT_MS: "0" }).maxWaitMs, 0, "0 means 'do not wait'");
  assertEquals(headSpec({ CAP_QUIET_HEAD_MAX_WAIT_MS: "-5" }).maxWaitMs, 300_000, "a negative bound is refused, not obeyed");
  assertEquals(headSpec({ CAP_QUIET_HEAD_MAX_WAIT_MS: "nonsense" }).maxWaitMs, 300_000);
});

Deno.test("gate-speed: an empty file list is a no-op (no wait, no browser)", async () => {
  assertEquals(await main([], {}), 0);
});

Deno.test("gate-speed: when the caller already ran the phase, it does not run again", async () => {
  assertEquals(await main(["tests/ntp-boot-staging.test.ts"], { [QUIET_HEAD_DONE_ENV]: "1" }), 0);
});

Deno.test("gate-speed: a box that never quiets REFUSES with exit 75 and the environmental marker (never a pass)", async () => {
  // Bound 0 with the box never quiet: the real sampler sees SOME load; a 0 ms bound means the first
  // sample decides. Force the unquiet reading with a sustained sample (the module's own injected
  // sampler seam is not exposed here, so this drives the real one with a zero bound — the assertion is
  // about the VERDICT wire, not the sampler, which tests/quiet-window.test.ts owns).
  const dir = await Deno.makeTempDir({ dir: (await import("../scripts/lib/durable-root.mjs")).durableDir("scratch"), prefix: "quiet-head-" });
  const probe = `${dir}/zz-quiet-head-probe.test.ts`;
  await Deno.writeTextFile(probe, `Deno.test("probe", () => {});\n`);
  try {
    const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "scripts/lib/quiet-head.ts", probe],
      cwd: new URL("..", import.meta.url).pathname,
      env: {
        ...Deno.env.toObject(),
        CAP_QUIET_HEAD_MAX_WAIT_MS: "0",
        CAP_QUIET_MAX_LOAD_PER_CORE: "0", // an unbeatable bar: load/core can never be <= 0
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const out = new TextDecoder().decode(stdout) + new TextDecoder().decode(stderr);
    assertEquals(code, 75, `expected the environmental refusal:\\n${out}`);
    assert(out.includes(ENVIRONMENTAL_REFUSAL_MARKER), `the refusal must carry the marker:\\n${out}`);
    assert(out.includes("ENVIRONMENT:"), `the refusal must carry the ENVIRONMENT line:\\n${out}`);
    assert(out.includes("quiet-head"), out);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("gate-speed: the phase's real file list is the partition's QUIET_HEAD set", () => {
  assert(QUIET_HEAD.size > 0);
  assert(QUIET_HEAD.has("tests/ntp-boot-staging.test.ts"));
});
