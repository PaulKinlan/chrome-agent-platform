// chrome-agent-platform-fnwt: a missing or hollowed-out Impeccable launcher must
// ANNOUNCE itself instead of degrading quietly.
//
// The 2026-10-07 report (j5yz, during z4gg) was a lane that took ENOENT from the
// documented path and silently dropped to hand-read context, so nothing in the
// run said the context load had failed. The launcher now exists at its
// documented path, and this file pins the two halves of the visibility that
// keeps it from going missing again unnoticed:
//
//   1. the documented command must LOAD CONTEXT — a zero exit on its own is not
//      success. An exit-code-only acceptance check is passed by a stub that
//      exits 0 without printing anything, which is the same shape as this
//      repo's false-green assertions (chrome-agent-platform-pfyiy);
//   2. when the launcher cannot run, the failure must be loud and must name the
//      path, and SKILL.md must require the lane to report it (the
//      IMPECCABLE_CONTEXT_LAUNCHER_UNAVAILABLE marker) rather than fall back to
//      hand-read context.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { fromFileUrl, join } from "jsr:@std/path@1";
import { durableDir } from "../scripts/lib/durable-root.mjs";

const root = fromFileUrl(new URL("../", import.meta.url));
const skill = join(root, ".agents/skills/impeccable/SKILL.md");
const launcher = ".agents/skills/impeccable/scripts/context.mjs";
const target = "extension/options/options.html";

// Scratch is durable-routed (tests/durable-root.test.ts is an always-on guard:
// a new test file has no /tmp allowance) and every directory is removed in the
// same test's finally.
const scratchDir = (prefix: string) => durableDir("scratch", `${prefix}-${crypto.randomUUID()}`);

// The marker SKILL.md must tell a lane to report when the launcher cannot run.
const UNAVAILABLE = "IMPECCABLE_CONTEXT_LAUNCHER_UNAVAILABLE";

/** Success is CONTEXT LOADED, never merely a zero exit: a stub that exits 0
 *  while printing nothing is exactly the quiet degradation this bead is about,
 *  so the predicate every check below shares refuses it. */
const contextLoaded = (stdout: string) => stdout.includes("# PRODUCT.md");

const runLauncher = (cwd: string) =>
  new Deno.Command("node", {
    cwd,
    args: [launcher, "--target", target],
    env: { IMPECCABLE_NO_UPDATE_CHECK: "1" },
  }).output();

Deno.test("fnwt: the documented launcher loads real context, not just a zero exit", async () => {
  const { code, stdout, stderr } = await runLauncher(root);
  const out = new TextDecoder().decode(stdout);
  assertEquals(code, 0, `documented launcher must run:\n${new TextDecoder().decode(stderr)}`);
  assert(contextLoaded(out), "the documented launcher must load context; exit 0 with no context is the silent-degradation shape");
});

Deno.test("fnwt: a missing launcher announces itself instead of degrading quietly", async () => {
  const instructions = await Deno.readTextFile(skill);
  assertStringIncludes(instructions, launcher, "SKILL.md must keep naming the checked-in launcher path");
  assertStringIncludes(instructions, UNAVAILABLE, "SKILL.md must tell a lane to report an unavailable launcher instead of falling back to hand-read context");

  // Drive the DOCUMENTED command where it cannot resolve: the failure must be
  // loud, must name the path, and must not look like a context load.
  const scratch = scratchDir("impeccable-missing");
  await Deno.mkdir(scratch, { recursive: true });
  try {
    const { code, stdout, stderr } = await runLauncher(scratch);
    const err = new TextDecoder().decode(stderr);
    assert(code !== 0, "a launcher that cannot be found must not exit 0 (that is the quiet degradation)");
    assertStringIncludes(err, launcher, "the failure must name the path it could not run");
    assert(!contextLoaded(new TextDecoder().decode(stdout)), "a missing launcher must not be reported as having loaded context");
  } finally {
    await Deno.remove(scratch, { recursive: true });
  }
});

Deno.test("fnwt: a hollow launcher that exits 0 without output is not accepted as loaded", async () => {
  // Non-vacuity of contextLoaded(), and the falsification for a future "silence
  // the ENOENT and carry on" shim: the same predicate the success check uses
  // must reject a zero exit that loaded nothing.
  const scratch = scratchDir("impeccable-hollow");
  try {
    const dir = join(scratch, ".agents/skills/impeccable/scripts");
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(join(dir, "context.mjs"), "process.exit(0);\n");
    const { code, stdout } = await runLauncher(scratch);
    const out = new TextDecoder().decode(stdout);
    assertEquals(code, 0, "the stub exits 0 on purpose: the point is that a zero exit is not evidence of a loaded context");
    assert(!contextLoaded(out), "contextLoaded() must refuse a zero exit that loaded nothing");
  } finally {
    await Deno.remove(scratch, { recursive: true });
  }
});
