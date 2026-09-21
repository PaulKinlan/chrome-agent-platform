// tests/evidence-instruments.test.ts — executable regression coverage for
// cap-evidence/ instruments (chrome-agent-platform-1smd).
//
// Invariant: changes touching these executable instruments dispatch this
// test in test:changed rather than failing closed to the full suite.
// No path exemptions or weakened fallbacks: this test actually executes the
// instruments under Deno and asserts their exit codes and success markers.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// Static references so buildReverseGraph links the instruments to this test
const _FINALIZER_MATRIX = new URL("../cap-evidence/3yfs-finalizer-matrix.ts", import.meta.url);
const _RESUME_PROBE = new URL("../cap-evidence/acp-resume-failure-probe.ts", import.meta.url);

Deno.test("1smd: 3yfs-finalizer-matrix executes and proves every case matched expectations", () => {
  const p = new Deno.Command("deno", {
    args: ["run", "-A", fileURLToPath(_FINALIZER_MATRIX)],
    cwd: ROOT,
    stdout: "piped",
    stderr: "piped",
  }).outputSync();
  const out = new TextDecoder().decode(p.stdout);
  assertEquals(p.code, 0, `3yfs-finalizer-matrix must exit 0: ${new TextDecoder().decode(p.stderr)}`);
  const match = out.match(/PROBE PASSED: every case matched expectations \((\d+) cases\)\./);
  assert(match, `3yfs-finalizer-matrix must report matched expectations: ${out}`);
  assert(Number(match[1]) >= 14, `must execute at least 14 matrix cases (got ${match[1]})`);
});

Deno.test("1smd: acp-resume-failure-probe executes and proves fallback on stale session", () => {
  const p = new Deno.Command("deno", {
    args: ["run", "-A", fileURLToPath(_RESUME_PROBE)],
    cwd: ROOT,
    stdout: "piped",
    stderr: "piped",
  }).outputSync();
  const out = new TextDecoder().decode(p.stdout);
  assertEquals(p.code, 0, `acp-resume-failure-probe must exit 0: ${new TextDecoder().decode(p.stderr)}`);
  assert(out.includes("6/6 checks PASS"));
});
