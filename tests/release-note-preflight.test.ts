// tests/release-note-preflight.test.ts — the lane-side release-note pre-flight
// (chrome-agent-platform-2h4j7). Five branches in one queue round were refused
// at the merge for trailer wording the lane never saw; this gate runs in the
// implementer's own fast gate so the refusal is learned before hand-off.
//
// The acceptance drills (coord's binding rulings):
//   1. an internal-only delta (scripts/tests/docs) with NO trailer is GREEN —
//      never fail on a missing trailer there, or every internal merge reds;
//   2. a product delta whose trailer the REAL filter rejects is RED, naming
//      the offending words;
//   3. a product delta with a passing trailer is GREEN;
//   4. mutating the filter flips the verdict — proving the check follows the
//      real predicate (extension/options/changelog-filter.js, bump-version's
//      own import) rather than a second copy that would drift.
//
// Falsification: a mutant that classifies every commit green reds cases 2 and
// the no-trailer product case; a mutant carrying its own vocabulary copy reds
// case 4 (the mutated real filter must change the outcome); a mutant that
// fails on any missing trailer reds case 1.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  classifyCommit,
  commitsInRange,
} from "../scripts/check-release-note-preflight.mjs";
import { explainUserFacingEntry, isInternalEntry } from "../extension/options/changelog-filter.js";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(new URL(import.meta.url))), "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "check-release-note-preflight.mjs");

const SCRIPTS_ONLY = ["scripts/update-test-weights.mjs", "tests/update-test-weights.test.ts"];
const PRODUCT = ["extension/lib/acp-runner.js", "tests/skill-import.test.ts"];
const USER_WORDS = "imported skill titles and descriptions can no longer pose as instructions to the agent";

Deno.test("2h4j7 acceptance 1: an internal-only delta with no trailer is GREEN", () => {
  const verdict = classifyCommit({ files: SCRIPTS_ONLY, body: "fix(abc12): repair the weights tool\n\nBead: chrome-agent-platform-abc12\n" });
  assertEquals(verdict, { ok: true });
});

Deno.test("2h4j7 acceptance 2: a product delta whose trailer the real filter rejects is RED, naming the offending word", () => {
  const body = `fix(nkf75): fence imported metadata\n\nRelease-note: Imported skills now reach the harness strictly as fenced untrusted data.\n`;
  const verdict = classifyCommit({ files: PRODUCT, body });
  assertEquals(verdict.ok, false);
  if (!verdict.ok) {
    assertStringIncludes(verdict.reason, "harness", "names the offending word");
    assertStringIncludes(verdict.reason, "jargon", "names the rule's why");
    assertStringIncludes(verdict.reason, "not user-facing", "prints the refusal bump-version would print");
  }
});

Deno.test("2h4j7 acceptance 3: a product delta with a passing trailer is GREEN", () => {
  const body = `fix(nkf75): fence imported metadata\n\nRelease-note: ${USER_WORDS}.\n`;
  assertEquals(classifyCommit({ files: PRODUCT, body }), { ok: true });
  // and an internal-only delta with a passing trailer stays green too
  assertEquals(classifyCommit({ files: SCRIPTS_ONLY, body }), { ok: true });
});

Deno.test("2h4j7: a product commit with NO trailer is RED (the z7i3m mode) — internal-only never is", () => {
  const verdict = classifyCommit({ files: PRODUCT, body: "fix(z7i3m): ship script-host change\n" });
  assertEquals(verdict.ok, false);
  if (!verdict.ok) {
    assertStringIncludes(verdict.reason, "no Release-note trailer");
    assertStringIncludes(verdict.reason, "extension/lib/acp-runner.js", "names the product path");
  }
});

Deno.test("2h4j7: a 'none: internal' trailer is RED with bump-version's exact refusal, on any delta", () => {
  for (const files of [SCRIPTS_ONLY, PRODUCT]) {
    const verdict = classifyCommit({ files, body: "fix(rs78b): tooling honesty\n\nRelease-note: none: internal (test-weights tooling honesty).\n" });
    assertEquals(verdict.ok, false);
    if (!verdict.ok) {
      assertStringIncludes(verdict.reason, "none: internal cannot mint a release; omit that trailer");
    }
  }
});

Deno.test("2h4j7: an 'internal:'-marked trailer is RED (the marker is for changelog bullets, not trailers), and an empty-after-sanitise trailer is RED", () => {
  const marked = classifyCommit({ files: SCRIPTS_ONLY, body: "x\n\nRelease-note: internal: the gate now allows stated-internal notes\n" });
  assertEquals(marked.ok, false);
  if (!marked.ok) assertStringIncludes(marked.reason, "internal");
  const empty = classifyCommit({ files: PRODUCT, body: "chrome-agent-platform-a1 + chrome-agent-platform-b2:\n\nRelease-note: chrome-agent-platform-a1 + chrome-agent-platform-b2:\n" });
  assertEquals(empty.ok, false);
  if (!empty.ok) assertStringIncludes(empty.reason, "EMPTY");
});

Deno.test("2h4j7 acceptance 4: the verdict follows the REAL predicate — mutating the filter flips the outcome", () => {
  const body = `fix(x9): faster widget\n\nRelease-note: the banana widget now loads faster.\n`;
  // The real filter has no opinion on fruit: green.
  assertEquals(classifyCommit({ files: PRODUCT, body }), { ok: true });
  // Ban a word the real filter does not ban; if the check consulted a COPY of
  // the vocabulary rule this mutation could not change the outcome.
  const mutated = {
    isInternalEntry,
    explainUserFacingEntry: (text: unknown) => {
      if (/\bbanana\b/i.test(String(text))) {
        return { ok: false as const, rule: "MUTATED_RE", why: "the test banned this word", token: "banana" };
      }
      return explainUserFacingEntry(text);
    },
  };
  const verdict = classifyCommit({ files: PRODUCT, body }, mutated);
  assertEquals(verdict.ok, false, "the injected predicate drives the verdict");
  if (!verdict.ok) assertStringIncludes(verdict.reason, "banana");
});

Deno.test("2h4j7: production wiring is pinned to the project's own predicates — no second copy of the vocabulary rule", async () => {
  const src = await readFile(SCRIPT, "utf8");
  // The filter, sanitiser and product-path ruling are IMPORTED from the modules
  // bump-version and the owed ledger already use.
  assertStringIncludes(src, `from "../extension/options/changelog-filter.js"`);
  assertStringIncludes(src, `from "./lib/release-note.mjs"`);
  assertStringIncludes(src, `from "./check-owed-changelog.mjs"`);
  // And the script carries no vocabulary copy of its own: the jargon
  // alternation exists exactly once in this repo, in changelog-filter.js.
  assert(!/journey\|KAT/.test(src), "a local jargon regex would be a second copy");
  // bump-version.mjs imports the shared sanitiser rather than defining its own.
  const bump = await readFile(path.join(REPO_ROOT, "scripts", "bump-version.mjs"), "utf8");
  assertStringIncludes(bump, `from "./lib/release-note.mjs"`);
  assert(!/const sanitizeEntry =/.test(bump), "sanitizeEntry must live in the shared module, not inline");
});

// --- CLI drill: a temp git repo driven through the real script ---

async function gitRepo() {
  const dir = await mkdtemp(path.join(tmpdir(), "cap-2h4j7-"));
  const git = (...args: string[]) => {
    const r = spawnSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" });
    assertEquals(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return String(r.stdout).trim();
  };
  git("init", "-q", "-b", "main");
  await mkdir(path.join(dir, "scripts"), { recursive: true });
  await writeFile(path.join(dir, "scripts", "tool.mjs"), "// base\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  const base = git("rev-parse", "HEAD");
  const run = () => spawnSync("node", [SCRIPT, "--repo", dir, "--base", base], { encoding: "utf8" });
  const commit = async (file: string, content: string, message: string) => {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), content);
    git("add", ".");
    git("commit", "-q", "-m", message);
  };
  return { dir, git, run, commit };
}

Deno.test("2h4j7 CLI: internal-only commit with no trailer exits 0", async () => {
  const { dir, run, commit } = await gitRepo();
  try {
    await commit("scripts/tool.mjs", "// v2\n", "fix: repair the tool");
    const r = run();
    assertEquals(r.status, 0, String(r.stderr));
    assertStringIncludes(String(r.stdout), "internal-only without trailers");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

Deno.test("2h4j7 CLI: product commit with a rejected trailer exits 1 naming the word; with a passing trailer exits 0", async () => {
  const { dir, run, commit } = await gitRepo();
  try {
    await commit(
      "extension/lib/widget.js",
      "export const x = 1;\n",
      "fix: widget\n\nRelease-note: the widget harness is now fenced.\n",
    );
    const bad = run();
    assertEquals(bad.status, 1, "the merge's refusal is learned locally");
    const err = String(bad.stderr);
    assertStringIncludes(err, "RELEASE-NOTE PRE-FLIGHT FAIL");
    assertStringIncludes(err, "harness");
    assertStringIncludes(err, "how this project talks to its users", "the message teaches, not lints");
    await commit(
      "extension/lib/widget.js",
      "export const x = 2;\n",
      `fix: widget v2\n\nRelease-note: ${USER_WORDS}.\n`,
    );
    const good = run();
    assertEquals(good.status, 1, "the FIRST bad commit still reds the range");
    // Drop the bad commit from the range by re-pointing the base: with only
    // the good commit in range the pre-flight is green.
    const head = spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" });
    const only = spawnSync("node", [SCRIPT, "--repo", dir, "--base", `${String(head.stdout).trim()}~1`], { encoding: "utf8" });
    assertEquals(only.status, 0, String(only.stderr));
    assertStringIncludes(String(only.stdout), "1 with user-facing notes");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

Deno.test("2h4j7 CLI: commitsInRange skips merge commits and reads files per commit", async () => {
  const { dir, commit, git } = await gitRepo();
  try {
    await commit("extension/lib/widget.js", "export const y = 1;\n", "fix: widget");
    const base = git("rev-parse", "HEAD~1");
    const commits = commitsInRange(dir, base);
    assertEquals(commits.length, 1);
    assertEquals(commits[0].files, ["extension/lib/widget.js"]);
    assertStringIncludes(commits[0].body, "fix: widget");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// chrome-agent-platform-g0bfz: ONE note, TWO readers. The stamp greps the body;
// git reads a trailer block at the END of it. A note in the SUBJECT (gzkmx) or in
// the MIDDLE of a body (0740d9df0, grep line 44) satisfied the stamp and was
// invisible to `git log --format=%(trailers)` — "a note exists and does not
// exist". Coord's ruling: reject the shape at AUTHORING time, naming the shape,
// because a note written as the subject is the natural mistake (both sightings
// did exactly that).
Deno.test("g0bfz: a note in the SUBJECT is RED at authoring time, naming the accepted shape", () => {
  const verdict = classifyCommit({
    files: PRODUCT,
    body: "Release-note: Extension modules were reorganized so shared helpers live in one place\n\nSome body text after the note.\n",
  });
  assertEquals(verdict.ok, false);
  if (!verdict.ok) {
    assertStringIncludes(verdict.reason, "shape is not one both readers accept");
    assertStringIncludes(verdict.reason, "TRAILER BLOCK at the END");
    assertStringIncludes(verdict.reason, "SUBJECT");
    assertStringIncludes(verdict.reason, "%(trailers)");
  }
});

Deno.test("g0bfz: a note in the MIDDLE of the body, and a WRAPPED note, are RED for the same reason", () => {
  for (const body of [
    `fix(x): thing\n\nRelease-note: ${USER_WORDS}.\nand then more prose after it\n`,
    `fix(x): thing\n\nRelease-note: ${USER_WORDS}\nand the sentence wraps onto a second line\n`,
  ]) {
    const verdict = classifyCommit({ files: PRODUCT, body });
    assertEquals(verdict.ok, false, body);
    if (!verdict.ok) assertStringIncludes(verdict.reason, "shape is not one both readers accept");
  }
});

Deno.test("g0bfz: a note in the trailing trailer block is still GREEN — the rule is the shape, not a ban", () => {
  const verdict = classifyCommit({ files: PRODUCT, body: `fix(x): thing\n\nbody prose\n\nRelease-note: ${USER_WORDS}.\n` });
  assertEquals(verdict, { ok: true });
});
