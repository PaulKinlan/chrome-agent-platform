// The trackers are merged by many agents a day. A conflict marker that slips
// through a hand merge is invisible to check-tasks (it only counts fields), and
// on 2026-08-30 six marker lines sat in the claims table on main for several
// hours. This fails the unit gate on any marker in the public trackers.
import { assertEquals } from "jsr:@std/assert@1";

const FILES = ["TASKS.md", "TASKS-DONE.md", "KNOWN-ISSUES.md", "PLAN.md", "CHANGELOG.md", "README.md", "AGENTS.md"];
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
