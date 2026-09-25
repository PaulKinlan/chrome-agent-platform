// tests/dist-note-contract.test.ts — pins the note:dist contract
// (chrome-agent-platform-xru1).
//
// scripts/dist-staleness-note.mjs is A NOTE, never a gate: the post-commit
// hook runs it (scripts/git-hooks/post-commit) and it must NEVER fail a
// commit, so it exits 0 whatever it finds. A past independent review read the
// old npm name (`check:dist`) and its stale-build message as a gate that
// cannot fail and filed it as a defect; both misreadings are the trap this
// bead closed by renaming the command to `note:dist` and opening the message
// with "NOTE (not a gate)". This file pins the contract so a later lane
// cannot "fix" the note into a gate by accident:
//   1. exit code 0 with no marker, with an unreadable marker, and with a
//      marker that names a missing build;
//   2. when it prints, the output is unambiguously a note ("not a gate") and
//      names where the real enforcement lives (the serial phase of npm test).

import { assert, assertEquals } from "jsr:@std/assert@1";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { durableDir } from "../scripts/lib/durable-root.mjs";

const SCRIPT = new URL("../scripts/dist-staleness-note.mjs", import.meta.url)
  .pathname;

// A fresh durable scratch per case: the script runs with cwd = scratch, so
// the extension/dist path it inspects is BUILT INSIDE THE SCRATCH — the repo
// tree is never read or written (partition EXEMPTIONS entry states this).
function freshScratch(name: string): string {
  const dir = durableDir(name);
  const extension = join(dir, "extension");
  if (existsSync(extension)) Deno.removeSync(extension, { recursive: true });
  return dir;
}

function runNote(cwd: string) {
  const cmd = new Deno.Command("node", {
    args: [SCRIPT],
    cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const res = cmd.outputSync();
  return {
    code: res.code,
    stdout: new TextDecoder().decode(res.stdout),
    stderr: new TextDecoder().decode(res.stderr),
  };
}

Deno.test("note:dist exits 0 and stays silent when no dist marker exists", () => {
  const scratch = freshScratch("dist-note-contract-absent");
  try {
    const res = runNote(scratch);
    assertEquals(res.code, 0, "a note must never set a failing exit code");
    assertEquals(res.stdout, "", "silent when the build is absent");
    assertEquals(res.stderr, "", "silent when the build is absent");
  } finally {
    Deno.removeSync(scratch, { recursive: true });
  }
});

Deno.test("note:dist exits 0 on an unreadable marker and says NOTE (not a gate)", () => {
  const scratch = freshScratch("dist-note-contract-unreadable");
  try {
    Deno.mkdirSync(`${scratch}/extension/dist`, { recursive: true });
    Deno.writeTextFileSync(`${scratch}/extension/dist/dist.complete`, "{not json");
    const res = runNote(scratch);
    assertEquals(res.code, 0, "a note must never set a failing exit code");
    assert(
      res.stderr.includes("NOTE (not a gate)"),
      "output must be unambiguously a note, not a verdict",
    );
    assert(
      res.stderr.includes("npm test"),
      "the note must name where the real enforcement lives",
    );
  } finally {
    Deno.removeSync(scratch, { recursive: true });
  }
});

Deno.test("note:dist exits 0 when the marker names a build that is not there", () => {
  const scratch = freshScratch("dist-note-contract-stale");
  try {
    Deno.mkdirSync(`${scratch}/extension/dist`, { recursive: true });
    Deno.writeTextFileSync(
      `${scratch}/extension/dist/dist.complete`,
      JSON.stringify({ target: "store" }),
    );
    const res = runNote(scratch);
    assertEquals(res.code, 0, "a note must never set a failing exit code");
    assert(
      res.stderr.includes("NOTE (not a gate)"),
      "stale findings still print as a note, not a failing verdict",
    );
    assert(
      res.stderr.includes("build:production"),
      "the note names the remedy",
    );
  } finally {
    Deno.removeSync(scratch, { recursive: true });
  }
});
