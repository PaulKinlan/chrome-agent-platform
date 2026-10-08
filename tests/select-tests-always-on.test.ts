// tests/select-tests-always-on.test.ts — chrome-agent-platform-kz27.
//
// THE DEFECT: a subset gate cannot see a guard that reads tracked source as data (no static import
// edges), so BOTH failure modes hide them — a FAIL-CLOSED selector (which was the whole of jfbn's
// gate) and a serial failure that skips the parallel phase. Two guard violations reached main from one
// landing while every gate reported green, because the guards never ran.
//
// This test pins the two guarantees the bead's acceptance asks for:
//   1. A FAIL-CLOSED selection SURFACES the always-on guard set, so a lane knows exactly what a subset
//      gate just failed to cover (a bare "FULL_SUITE" tells it nothing).
//   2. The set is runnable on its own, by name, without the selector choosing it.
// It also pins the LIST ADDITION that made the gap visible: four tree-walking guards, including
// tests/durable-root.test.ts, were missing from ALWAYS_ON.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { alwaysOnGuards, failClosedPlan, SCANNER_EXCLUSIONS, SOURCE_INSPECTING_GUARDS } from "../scripts/select-tests.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

Deno.test("kz27: the tree-walking guards are IN the always-on list, and every entry exists", () => {
  for (
    const guard of [
      "tests/durable-root.test.ts",
      "tests/dialog-confirm-modernization.test.ts",
      "tests/single-source-helpers.test.ts",
      "tests/security-doc-drift.test.ts", // o75bp: SW-only changes must recheck cited symbols
    ]
  ) {
    assert(
      SOURCE_INSPECTING_GUARDS.includes(guard),
      `${guard} reads the repo tree as data and must be always-on (kz27)`,
    );
  }
  // A list is only a list if its members are real: an entry naming a file that does not exist would
  // "cover" nothing while looking reassuring.
  for (const file of SOURCE_INSPECTING_GUARDS) {
    assert(existsSync(join(ROOT, file)), `always-on guard ${file} must exist on disk`);
  }
});

Deno.test("kz27: the split put the browser-free SCAN in the set and left the live race out", () => {
  // F1 (delta review): the static half is always-on; the live-browser half is not, because
  // docs/CHROME-TEST-CONTRACT.md §2.3 promises a subset gate launches a browser only when that file or
  // its dependencies changed. Both halves must stay on their own side of that line.
  assert(
    SOURCE_INSPECTING_GUARDS.includes("tests/chrome-profile-static.test.ts"),
    "the browser-free static scan must be always-on",
  );
  assert(
    !SOURCE_INSPECTING_GUARDS.includes("tests/chrome-profile-location.test.ts"),
    "the live-browser file must NOT be always-on — that would break the §2.3 promise fleet-wide",
  );
  const staticCode = Deno.readTextFileSync(join(ROOT, "tests/chrome-profile-static.test.ts"));
  // fgik F2: the reviewer showed the literal-string form was evadable — a top-level STATIC import, a
  // single-quoted import, or a non-awaited dynamic import all slipped past it. Match the IDENTIFIER
  // instead, so every way of pulling the launcher in fails this; the variant test below proves the old
  // form missed one of them.
  assert(
    !/chrome-launch/i.test(staticCode),
    "the always-on half must not reference the launcher at all, in any import form",
  );
  assert(
    staticCode.includes("--user-data-dir="),
    "sanity: the always-on half is the one that SCANS for --user-data-dir sites",
  );
});

Deno.test("fgik F2: the launcher assertion catches a STATIC-import variant the old form missed", () => {
  // Acceptance from the review: the assertion must fail against a static-import variant rather than only
  // against the one spelling it used to look for.
  const staticCode = Deno.readTextFileSync(join(ROOT, "tests/chrome-profile-static.test.ts"));
  const withStaticImport =
    `import { launchChrome } from "../scripts/lib/chrome-launch.ts";\n` + staticCode;
  assert(
    /chrome-launch/i.test(withStaticImport),
    "the identifier-based assertion must catch a top-level static import",
  );
  assert(
    !withStaticImport.includes('await import("../scripts/lib/chrome-launch.ts")'),
    "the OLD literal form passes this variant — that is the F2 defect, kept as the reason the assertion changed",
  );
  const singleQuoted = `await import('../scripts/lib/chrome-launch.ts');\n` + staticCode;
  assert(/chrome-launch/i.test(singleQuoted), "and a single-quoted import");
});

Deno.test("fgik F1: the always-on quiet-window half is the SOURCE READER, not the burner", () => {
  // The split's whole point: the tracked-source assertions stay always-on and the esbuild burners do NOT
  // come with them. A file that spawns a compiler must never be in a set that runs on every gate.
  const staticCode = Deno.readTextFileSync(join(ROOT, "tests/quiet-window-static.test.ts"));
  assert(
    !/Deno\.Command|spawn\(/.test(staticCode),
    "the always-on quiet-window half must spawn nothing",
  );
  assert(
    staticCode.includes("scripts/"),
    "the always-on half must be the one that READS tracked source",
  );
  assert(
    !SOURCE_INSPECTING_GUARDS.includes("tests/quiet-window.test.ts"),
    "the burner file must NOT be always-on (fgik F1)",
  );
  assert(
    SOURCE_INSPECTING_GUARDS.includes("tests/quiet-window-static.test.ts"),
    "its tracked-source half must be",
  );
});

Deno.test("kz27: the browser-dependent scanner is held out BY DECLARATION, with a reason and a bead", () => {
  // It also matches the repo-walk shape, so it cannot simply be left off the list: the widened
  // detector would fail the audit closed. The exclusion has to be written down instead — and it must
  // not be in the list at the same time, because that contradiction would hide the decision.
  const reason = SCANNER_EXCLUSIONS["tests/chrome-profile-location.test.ts"];
  assert(reason, "the browser-dependent guard must appear in SCANNER_EXCLUSIONS");
  assert(
    !SOURCE_INSPECTING_GUARDS.includes("tests/chrome-profile-location.test.ts"),
    "it must not be in both sets",
  );
  assert(reason.includes("chrome-agent-platform-hlgr"), "the exclusion must name its follow-up bead");
  assert(
    reason.includes("CHROME-TEST-CONTRACT") && /browser/i.test(reason) && reason.length > 80,
    "the exclusion must say WHY (it holds the live race test and §2.3 promises the trigger condition)",
  );
});

Deno.test("kz27: a FAIL-CLOSED selection NAMES the always-on guard set it could not cover", () => {
  const plan = failClosedPlan({ uncovered: ["scripts/merge-closing-block.sh"], list: true });
  assertEquals(plan.action, "list", "with --list the caller prints FULL_SUITE and runs nothing");
  const text = plan.output.join("\n");
  assertStringIncludes(text, "FAIL CLOSED");
  assertStringIncludes(text, "scripts/merge-closing-block.sh");
  assertStringIncludes(text, "FULL_SUITE".replace("FULL_SUITE", "FULL suite")); // the message, not the token
  // THE REGRESSION: every always-on guard is named, so a lane can run them explicitly. Before kz27
  // the fail-closed path printed a file list and "FULL_SUITE" and nothing about the guards.
  for (const guard of alwaysOnGuards()) {
    assert(text.includes(guard), `the fail-closed report must name the guard ${guard}`);
  }
  assert(
    text.includes("tests/durable-root.test.ts"),
    "durable-root must be named: it is the guard whose absence from ALWAYS_ON hid a real violation",
  );
  // F2 (delta review, c1a77598): the report must SAY that running the guards is not a full
  // verification, so nobody reads "the guards were green" as "my change is verified".
  assert(
    text.includes("DOES NOT VALIDATE YOUR CHANGES"),
    `the fail-closed report must state that the always-on set is not a full verification: ${text}`,
  );
});

Deno.test("kz27: the always-on set is runnable by name (--always-on) without the selector choosing it", async () => {
  // node, not process.execPath: under deno that is the DENO binary, which then refuses the script's
  // env access (measured: NotCapable on CAP_PARALLEL_TEST_TIMEOUT_MS). This mirrors production, where
  // npm runs the selector with node.
  const { code, stdout, stderr } = await new Deno.Command("node", {
    args: ["scripts/select-tests.mjs", "--list", "--always-on"],
    cwd: ROOT,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const out = new TextDecoder().decode(stdout);
  const err = new TextDecoder().decode(stderr);
  assertEquals(code, 0, `--always-on --list must succeed: ${err}`);
  // F2: the warning must reach stderr in this mode too, and stdout must stay parseable for callers.
  assert(
    err.includes("DOES NOT VALIDATE YOUR CHANGES"),
    `--always-on must warn that it does not validate changes: ${err}`,
  );
  assert(err.includes("WARNING"), err);
  const listed = out.split("\n").map((l) => l.trim()).filter(Boolean);
  assertEquals(listed, alwaysOnGuards(), "--always-on --list must print exactly the always-on set");
  assert(
    listed.includes("tests/durable-root.test.ts"),
    "durable-root must be in the set, so a lane can run it explicitly (kz27)",
  );
});
