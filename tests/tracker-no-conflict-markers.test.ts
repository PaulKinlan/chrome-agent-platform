// Top-level docs are merged by many agents a day. A conflict marker that slips
// through a hand merge sat in the public record on 2026-08-30 for several
// hours. This fails the unit gate on any marker in the public docs (TASKS.md,
// TASKS-DONE.md, and KNOWN-ISSUES.md were deleted under chrome-agent-platform-yz4e).
import { assertEquals } from "jsr:@std/assert@1";

const FILES = ["PLAN.md", "CHANGELOG.md", "README.md", "AGENTS.md"];
const MARKER = /^(<{7}|={7}|>{7})( |$)/m;

Deno.test("trackers: no git conflict markers survive in the public record", async () => {
  const offenders: string[] = [];
  for (const f of FILES) {
    let text = "";
    try { text = await Deno.readTextFile(new URL(`../${f}`, import.meta.url)); } catch { continue; }
    const lines = text.split("\n");
    lines.forEach((line, i) => { if (MARKER.test(line)) offenders.push(`${f}:${i + 1}: ${line.slice(0, 40)}`); });
  }
  assertEquals(offenders, [], "conflict markers in tracked docs");
});
