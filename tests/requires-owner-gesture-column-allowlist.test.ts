// tests/requires-owner-gesture-column-allowlist.test.ts — chrome-agent-platform-yx2h (successor to 4h47)
//
// THE COLUMN. `requiresOwnerGesture` was a dead authority column in
// extension/lib/chrome-tool-capabilities.js that was passed `false` by every catalogue
// row, and NO shipped code decided anything from its value. In chrome-agent-platform-yx2h,
// the column was completely retired and deleted across all 191 catalogue row definitions,
// record() parameters, validateRow, and capability summaries.
//
// TWO GUARANTEES ENFORCED AFTER REMOVAL:
//
//   1. "the column is completely gone from the capability table" — pinned in
//      tests/chrome-tool-capabilities.test.ts (all 191 rows and summaries verified).
//   2. "the column cannot be re-introduced or read as an authority" — THIS file.
//      The set of files that may mention the name at all is an EXPLICIT ALLOWLIST
//      (strictly limited to tests/scripts documentation of its retirement).
//      Any code in extension/ or un-allowlisted files FAILS here BY NAME.
//
// WHY AN ALLOWLIST AND NOT A CENSUS. A census records what is there; an allowlist
// decides what may be. The allowlist shape (and its "an entry that stops matching
// is stale and also fails" rule) is copied from the guards this repo already runs
// this way — `SCANNER_EXCLUSIONS` in scripts/select-tests.mjs and the allowlist in
// tests/machine-path-honesty.test.ts — because a quiet hole is what both exist to
// prevent.
//
// THIS GUARD IS CROSS-CUTTING, so it is registered in SOURCE_INSPECTING_GUARDS
// (scripts/select-tests.mjs) and therefore runs in ALWAYS_ON: it inspects the whole
// tracked tree at runtime and imports none of the files it inspects, so no
// reverse-import selection would ever pick it up for a change to the reader it is
// supposed to catch (AGENTS.md coupling rule 4, dqc1).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const COLUMN_NAME = "requiresOwnerGesture";

/** Every file allowed to MENTION `requiresOwnerGesture`, keyed repo-relative (so a
 *  line move cannot break an entry) with the reason it may. A file that mentions
 *  the column and is not listed here fails the guard below; a listed file that
 *  stops mentioning it also fails, because a stale exception hides a fix. */
const MENTION_ALLOWLIST: Readonly<Record<string, string>> = {
  "tests/chrome-tool-capabilities.test.ts":
    "The ENFORCING pin proving requiresOwnerGesture is completely removed from all 191 catalogue rows, " +
    "and that record() parameter list and calls line up with the 9-parameter signature (chrome-agent-platform-yx2h).",
  "tests/requires-owner-gesture-column-allowlist.test.ts":
    "THIS guard. It names the column because the column is what it searches for — its own mentions are the " +
    "search key, not a read of the value.",
  "scripts/select-tests.mjs":
    "The SOURCE_INSPECTING_GUARDS adjudication that promotes THIS guard into ALWAYS_ON. Its mention is prose " +
    "in that entry's justification (why a cross-cutting guard has no import edge), not a read of the value.",
};

/** The tracked (and not-yet-committed, non-ignored) files that mention the column.
 *  `git grep` is the repo's tracked-tree idiom (see tests/docs-process-truth.test.ts);
 *  `--untracked` keeps this guard honest for the file that is adding it, which is
 *  not tracked until it lands. */
function filesMentioningColumn(): string[] {
  const result = spawnSync("git", ["grep", "-l", "-I", "--untracked", "-e", COLUMN_NAME], { cwd: ROOT, encoding: "utf8" });
  // 1 is "no match" — an empty tree is a legitimate (and loud, via the stale check) state.
  assert(
    result.status === 0 || result.status === 1,
    `the tracked-tree search for ${COLUMN_NAME} must run (git exited ${result.status}): ${result.stderr ?? ""}`,
  );
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean).sort();
}

Deno.test("requiresOwnerGesture: only the allowlisted files may mention the dead column (a new reader fails by name)", () => {
  const mentioned = filesMentioningColumn();

  // The guard cannot silently degrade into a no-op: if the search stopped finding
  // ANYTHING the allowlist itself would be stale, and the assertions below would
  // pass over an empty result.
  assert(mentioned.length > 0, `the search must find at least this guard's own mention of ${COLUMN_NAME}`);

  const unexpected = mentioned.filter((file) => !Object.hasOwn(MENTION_ALLOWLIST, file));
  assertEquals(
    unexpected,
    [],
    `file(s) mention ${COLUMN_NAME} without being allowlisted: ${unexpected.join(", ")}. This column is ` +
      "DEPRECATED and gates nothing (chrome-agent-platform-4h47) — if you are READING it to decide " +
      "something, stop: wire the gate in browser-tools.js/owner-approval.js and make a real authority the " +
      "single source (chrome-agent-platform-yx2h owns deleting the column). Otherwise add the file here " +
      "with the reason it may mention the name.",
  );

  const stale = Object.keys(MENTION_ALLOWLIST).filter((file) => !mentioned.includes(file));
  assertEquals(
    stale,
    [],
    `allowlist entr(ies) no longer mention ${COLUMN_NAME}: ${stale.join(", ")} — a stale exception hides a ` +
      "fix, so it is removed in the same change that removes the mention.",
  );
});

Deno.test("requiresOwnerGesture: every allowlist entry carries a real reason", () => {
  const entries = Object.entries(MENTION_ALLOWLIST);
  assertEquals(entries.length, 3, "the allowlist is exactly the three known mention sites (all test/script documentation; zero in extension/lib/)");
  for (const [file, reason] of entries) {
    assert(reason.trim().length > 80, `allowlist entry ${file} must carry a real reason, not a placeholder`);
  }
});

Deno.test("requiresOwnerGesture: zero occurrences in extension/ (the column is deleted and unreadable)", () => {
  const result = spawnSync("git", ["grep", "-n", "-e", COLUMN_NAME, "--", "extension/"], { cwd: ROOT, encoding: "utf8" });
  assertEquals(result.status, 1, `extension/ must have zero mentions of ${COLUMN_NAME} (got stdout: ${result.stdout})`);
});

Deno.test("requiresOwnerGesture: falsification — an un-allowlisted file mentioning the column is caught end-to-end", () => {
  const probePath = `${ROOT}extension/lib/__probe_stray_gesture_reader.js`;
  try {
    Deno.writeTextFileSync(probePath, `// Probe testing falsification\nconst x = "${COLUMN_NAME}";\n`);
    const mentioned = filesMentioningColumn();
    assert(mentioned.includes("extension/lib/__probe_stray_gesture_reader.js"), "git grep --untracked must discover the probe file");
    const unexpected = mentioned.filter((file) => !Object.hasOwn(MENTION_ALLOWLIST, file));
    assertEquals(unexpected, ["extension/lib/__probe_stray_gesture_reader.js"], "the un-allowlisted probe must be flagged as unexpected");
  } finally {
    try { Deno.removeSync(probePath); } catch { /* ignore */ }
  }
});
