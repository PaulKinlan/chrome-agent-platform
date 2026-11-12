// tests/build-gate-static.test.ts — static structural tests for scripts/build-gate.ts (chrome-agent-platform-h65e).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { main } from "../scripts/build-gate.ts";
import { BUILD_GATE_FILES } from "../scripts/test-partition.mjs";

Deno.test("build-gate static: exports main function and matches BUILD_GATE_FILES", () => {
  assertEquals(typeof main, "function");
  assert(BUILD_GATE_FILES.length >= 3);
  assert(BUILD_GATE_FILES.includes("tests/build-bootstrap.test.ts"));
  assert(BUILD_GATE_FILES.includes("tests/build-debug-mode.test.ts"));
  assert(BUILD_GATE_FILES.includes("tests/build-tool-bundling.test.ts"));
});

// ── y4lbe: an environmental refusal is narrated as a REFUSAL, never "FAILED with exit code 75" ──
// The tier a lane reads FIRST must not call a refusal a failure (the combined
// top-level code already re-combines correctly; this pins the lane-facing line).

import { durableDir } from "../scripts/lib/durable-root.mjs";
import { join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";

async function runBuildGateWithFixture(fixtureSource: string): Promise<{ code: number; out: string }> {
  const dir = durableDir(`y4lbe-${Deno.pid}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    const fixture = joinPath(dir, "zz-y4lbe-fixture.test.ts");
    await Deno.writeTextFile(fixture, fixtureSource);
    const scriptPath = fileURLToPath(new URL("../scripts/build-gate.ts", import.meta.url));
    const cmd = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", scriptPath, fixture],
      stdout: "piped",
      stderr: "piped",
    });
    const out = await cmd.output();
    return { code: out.code, out: new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr) };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const Y4LBE_REFUSAL_FIXTURE = `Deno.test("fixture: environmental refusal", () => {
  throw new Error('CAP_ENVIRONMENTAL_REFUSAL {"reason":"host-loaded"}');
});
`;

const Y4LBE_PRODUCT_FIXTURE = `Deno.test("fixture: product failure", () => {
  throw new Error("AssertionError: a genuine product red");
});
`;

Deno.test("y4lbe: a build-gate run whose serial tier refuses (75) prints REFUSED — never 'FAILED with exit code 75'", async () => {
  const { code, out } = await runBuildGateWithFixture(Y4LBE_REFUSAL_FIXTURE);
  assertEquals(code, 75, `the refusal exit code is preserved upward (run-tests.mjs re-combines it):\n${out}`);
  assert(out.includes("REFUSED"), `the lane-facing line names a refusal:\n${out}`);
  assert(!out.includes("FAILED with exit code 75"), `a refusal must never read as FAILED:\n${out}`);
  // d83la (review round 2): the refusal run must emit NO pass-record line at
  // all — this catches a stray/fake "PASS record" print, the mutant the
  // call-site-count pin could not see.
  assert(!out.includes("PASS record"), `a refusal emits no PASS record of any kind:\n${out}`);
});

Deno.test("y4lbe: a genuine product failure in build-gate still prints FAILED with the raw code (falsification side)", async () => {
  const { code, out } = await runBuildGateWithFixture(Y4LBE_PRODUCT_FIXTURE);
  assertEquals(code, 1, `a product red keeps its raw code:\n${out}`);
  assert(out.includes("FAILED with exit code 1"), `a product red is narrated as FAILED:\n${out}`);
});

Deno.test("d83la: buildGateVerdict is the only PASS-record authority — refusal/failure never record, pass records", async () => {
  const { buildGateVerdict } = await import("../scripts/build-gate.ts");
  assertEquals(buildGateVerdict(75).record, false, "a refusal never licenses a skip");
  assert(buildGateVerdict(75).line.includes("REFUSED"), buildGateVerdict(75).line);
  assertEquals(buildGateVerdict(1).record, false, "a product red never records");
  assert(buildGateVerdict(1).line.includes("FAILED with exit code 1"));
  assertEquals(buildGateVerdict(0).record, true, "a green run may record");
  assertEquals(buildGateVerdict(124).record, false, "a bound kill never records");
});

Deno.test("d83la: exactly one record call site, behind the verdict guard, and exactly one PASS-record line", async () => {
  const src = await Deno.readTextFile(new URL("../scripts/build-gate.ts", import.meta.url));
  // The call goes through the `record` seam; the property is exactly one call,
  // behind the verdict guard.
  assertEquals(src.split("await record(").length - 1, 1, "exactly one PASS-record call site");
  assert(src.includes("if (verdict.record && decision?.key)"), "the call is guarded by the verdict, not by rc text");
  assertEquals(src.split("build-gate: PASS record").length - 1, 1, "exactly one PASS-record line, the guarded one");
});


// ── d83la (round 3): count the RECORDS EMITTED, not the lines printed ──────
// Review round 2 FAIL: 'no pass record on refusal' alone leaves a moved call
// alive — a tree that records in the wrong place (or not at all) still
// satisfies a pure negative. These drive main() with the tier seams injected
// and count real record FILES written by the real recordBuildTierPass.

async function emittedRecordsFor(rc: number): Promise<unknown[]> {
  const dir = durableDir(`d83la-records-${Deno.pid}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    const { main } = await import("../scripts/build-gate.ts");
    const { recordBuildTierPass } = await import("../scripts/lib/build-tier-inputs.mjs");
    const key = "a".repeat(64);
    const code = await main([], {
      resolveTier: async () => ({ run: true, key, inputs: 1, reason: "test-forced", record: null }),
      runSerial: () => rc,
      record: (args) => recordBuildTierPass({ ...args, dir }),
    });
    assertEquals(code, rc, "main returns the tier's code unchanged");
    let names: string[] = [];
    try {
      for await (const e of Deno.readDir(dir)) names.push(e.name);
    } catch { /* no dir => no records */ }
    const records = [];
    for (const name of names) {
      records.push(JSON.parse(await Deno.readTextFile(joinPath(dir, name))));
    }
    return records;
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("d83la: a genuine pass emits EXACTLY ONE pass record (a count of records, not printed text)", async () => {
  const records = await emittedRecordsFor(0);
  assertEquals(records.length, 1, "a pass emits exactly one record");
  assertEquals((records[0] as { key: string }).key, "a".repeat(64), "the record is for the tier's key");
});

Deno.test("d83la: a refusal (75) emits ZERO pass records even with a live decision key", async () => {
  assertEquals((await emittedRecordsFor(75)).length, 0, "a refusal emits no record at all");
});

Deno.test("d83la: a product failure (1) emits ZERO pass records", async () => {
  assertEquals((await emittedRecordsFor(1)).length, 0, "a failure emits no record at all");
});
