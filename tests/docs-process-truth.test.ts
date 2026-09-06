// tests/docs-process-truth.test.ts — the docs tell the truth about process
// (chrome-agent-platform-6j8i; findings 1-11 and 23-25 of the 2026-09-05 docs audit).
//
// The 2026-09-02 owner directive retired the markdown trackers (TASKS.md,
// TASKS-DONE.md, KNOWN-ISSUES.md, docs/UI-FIXES-TRACKER.md) in favour of beads,
// the review fleet the README promised was retired on 2026-08-27 (reviews are
// LABELLED now — author or independent), and AGENTS.md carries a hard rule
// against naming the owner's other project. The entry docs kept sending a new
// reader to the frozen files as "the authority", promised the retired control,
// omitted the current review, and carried the banned name. These pins fail if
// any of that comes back.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { spawnSync } from "node:child_process";

const ROOT = new URL("../", import.meta.url).pathname;
const read = (rel: string) => Deno.readTextFileSync(ROOT + rel);

// Each retired tracker keeps a RETIRED banner at its top that points at beads,
// so a reader who opens one is redirected before reading a single entry.
const RETIRED_TRACKERS = ["TASKS.md", "TASKS-DONE.md", "KNOWN-ISSUES.md", "docs/UI-FIXES-TRACKER.md"];

// The docs the audit found presenting a retired tracker as the live authority.
// In these, a line that names a retired tracker says it is retired history ON
// THAT LINE — the reader is never left holding a live pointer.
const POINTER_DOCS = ["README.md", "PLAN.md", "docs/KNOWN-ISSUES.md", "docs/KNOWN-ISSUES-ARCHIVE.md", "docs/AGENT-MODEL.md", "docs/UI-FIXES-TRACKER.md"];
const TRACKER_NAME_RE = /\b(TASKS\.md|TASKS-DONE\.md|KNOWN-ISSUES\.md|KNOWN-ISSUES\b(?!-ARCHIVE)|UI-FIXES-TRACKER)/;
const RETIREMENT_MARKER_RE = /\b(retired|history|legacy)\b/i;

// The exact promises the audit named: an authority or a control that no longer exists.
const STALE_PHRASES: Array<[string, RegExp]> = [
  ["a tracker file called the authority", /TASKS\.md[^\n]{0,80}\bauthority\b|\bauthority\b[^\n]{0,80}TASKS\.md/i],
  ["live findings pointed at a retired file", /live findings live in `?TASKS\.md/i],
  ["a residual pointed at a retired file", /tracked in KNOWN-ISSUES\b/],
  ["a thin view over a retired file", /thin view over TASKS\.md/i],
  ["a redirect to a retired file", /canonical record moved to[^\n]*KNOWN-ISSUES\.md/i],
  ["the retired review fleet promised as a control", /sol \/ GLM \/ DeepSeek, independent sessions/],
];

// Files allowed to carry the banned name: the rule itself (and its symlink),
// verbatim owner quotes inside a retired history file, and the audit that
// recorded the finding. Everything else — including every doc under docs/ —
// is clean.
const BANNED_NAME_RE = /chaos/i;
const BANNED_NAME_ALLOWLIST = new Set(["AGENTS.md", "CLAUDE.md", "TASKS-DONE.md", "docs/DOCS-AUDIT-2026-09-05.md"]);

function readmeDocMap(): string {
  const readme = read("README.md");
  const start = readme.indexOf("## The plan, the history");
  const end = readme.indexOf("**Current gate status", start);
  assert(start >= 0 && end > start, "the README keeps its document-map section");
  return readme.slice(start, end);
}

Deno.test("6j8i: every retired tracker opens with a RETIRED banner that points at beads", () => {
  for (const rel of RETIRED_TRACKERS) {
    const head = read(rel).split("\n").slice(0, 12).join("\n");
    assert(/RETIRED/.test(head), `${rel}: the banner says RETIRED in its first 12 lines`);
    assert(/\bbd (ready|list)\b/.test(head), `${rel}: the banner points at bd ready / bd list`);
  }
});

Deno.test("6j8i: the entry docs never present a retired tracker as the live authority", () => {
  const offenders: string[] = [];
  for (const rel of POINTER_DOCS) {
    const text = read(rel);
    text.split("\n").forEach((line, i) => {
      if (TRACKER_NAME_RE.test(line) && !RETIREMENT_MARKER_RE.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
    for (const [what, re] of STALE_PHRASES) {
      const m = text.match(re);
      if (m) offenders.push(`${rel}: ${what}: ${m[0].slice(0, 100)}`);
    }
  }
  assertEquals(offenders, [], "a line naming a retired tracker says it is retired history, and no stale promise survives");
});

Deno.test("6j8i: the README document map leads with beads, lists the current review, and demotes the superseded one", () => {
  const map = readmeDocMap();
  const rows = map.split("\n").filter((l) => l.startsWith("|"));
  const rowIndex = (needle: string) => rows.findIndex((r) => r.includes(needle));
  assert(rowIndex("`bd ready`") >= 0, "a beads row names bd ready as the claimable frontier");
  assert(rowIndex("REVIEW-2026-08-30.md") >= 0, "the current review is in the map");
  assert(rowIndex("REVIEW-2026-08-21.md") >= 0, "the earlier review stays in the map…");
  assert(/\b(history|superseded)\b/i.test(rows[rowIndex("REVIEW-2026-08-21.md")]!), "…demoted to history");
  assert(rowIndex("`bd ready`") < rowIndex("REVIEW-2026-08-30.md"), "beads precede the reviews (precedence order)");
  assert(rowIndex("REVIEW-2026-08-30.md") < rowIndex("REVIEW-2026-08-21.md"), "the current review precedes the superseded one");
  for (const t of RETIRED_TRACKERS) assert(rowIndex(t) >= 0, `${t} is still findable from the map (as retired)`);
});

Deno.test("6j8i: the README promises the labelled review that exists, not the fleet that was retired", () => {
  const readme = read("README.md");
  assert(!/sol \/ GLM \/ DeepSeek, independent sessions/.test(readme), "the retired fleet is not promised as a control");
  assert(/\bauthor review\b/.test(readme) && /\bindependent review\b/.test(readme), "the two review labels are named");
  assert(/falsification/.test(readme), "an author review is tied to the falsification gates");
});

Deno.test("6j8i: no tracked markdown names the owner's other project (AGENTS.md hard rule), outside the allowlist", () => {
  const ls = spawnSync("git", ["ls-files", "-z", "--", "*.md"], { cwd: ROOT, encoding: "utf8" });
  assertEquals(ls.status, 0, ls.stderr);
  const files = ls.stdout.split("\0").filter(Boolean);
  assert(files.length > 50, `tracked markdown enumerated (${files.length})`);
  const offenders: string[] = [];
  for (const rel of files) {
    if (BANNED_NAME_ALLOWLIST.has(rel)) continue;
    if (Deno.lstatSync(ROOT + rel).isSymlink) continue;
    read(rel).split("\n").forEach((line, i) => {
      if (BANNED_NAME_RE.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 90)}`);
    });
  }
  assertEquals(offenders, [], "no chaos references (AGENTS.md hard rule)");
  // The allowlist is not a loophole: each entry is still tracked and still the
  // kind of file the exemption describes.
  for (const rel of BANNED_NAME_ALLOWLIST) assert(files.includes(rel), `${rel}: allowlisted file is tracked`);
  assert(/^# .*RETIRED/m.test(read("TASKS-DONE.md").split("\n").slice(0, 3).join("\n")), "TASKS-DONE.md is exempt only as retired history");
});
