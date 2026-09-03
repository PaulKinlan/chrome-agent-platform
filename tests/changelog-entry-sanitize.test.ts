// tests/changelog-entry-sanitize.test.ts — pins the bump hook's changelog
// sanitizer: a tracker/branch id is never a user-facing bullet. When a commit
// subject carries ONLY machinery (bead ids, branch names, merge heads), the
// sanitizer must return "" so the bump falls back to the generic note — a
// bare id like "cap-beads-9ve7" must never reach CHANGELOG.md as its own
// description (the 0.3.28–0.3.35 regression this pins: merge subjects that
// were branch names became bare-id bullets).

import { assertEquals } from "jsr:@std/assert@1";
import { sanitizeChangelogEntry } from "../scripts/bump-version.mjs";

Deno.test("sanitize: bare bead/branch ids and merge machinery strip to empty (generic fallback)", () => {
  const machinery = [
    "chrome-agent-platform-jb0a",
    "cap-beads-9ve7",
    "cap-beads-dptw-tr",
    "work-p45y-r5",
    "merge: cap-beads-znx9",
    "merge: work-p45y-r5",
    "Merge branch 'cap-beads-afiu'",
    "Merge remote-tracking branch 'origin/cap-beads-yop8'",
    "Merge pull request #123 from PaulKinlan/cap-beads-60be",
  ];
  for (const s of machinery) {
    assertEquals(sanitizeChangelogEntry(s), "", `should strip to empty: ${s}`);
  }
});

Deno.test("sanitize: real descriptions survive; prefixes, SHAs and ids inside them are stripped", () => {
  assertEquals(
    sanitizeChangelogEntry("read_file delivers every requested byte"),
    "read_file delivers every requested byte",
  );
  assertEquals(
    sanitizeChangelogEntry("fix(build): version bumps now keep inventory in lockstep"),
    "version bumps now keep inventory in lockstep",
  );
  assertEquals(
    sanitizeChangelogEntry("merge: WebMCP acceptance green lane (0c9783c8)"),
    "WebMCP acceptance work",
  );
  // A description that MENTIONS the merged branch keeps the description.
  assertEquals(
    sanitizeChangelogEntry("merge: artifact quick fixes (fca54411) — the New-tab guard test is added"),
    "artifact quick fixes — the New-tab guard test is added",
  );
});

Deno.test("sanitize: output is what isUserFacingEntry accepts (no tracker tokens leak through)", () => {
  // The shared filter is the user-facing contract (extension/options/changelog-filter.js).
  const samples = [
    "agents can create, save, recall, and run reusable workflows",
    "the composer can steer and queue a running agent",
  ];
  return import("../extension/options/changelog-filter.js").then(({ isUserFacingEntry }) => {
    for (const s of samples) {
      const out = sanitizeChangelogEntry(s);
      assertEquals(isUserFacingEntry(out), true, `must stay user-facing: ${out}`);
    }
  });
});
