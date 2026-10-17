// toyoj: exports larger than the old 16 MiB child-output cap must still be
// checked for missing IDs, never mistaken for an empty or successful export.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { durableDir } from "../scripts/lib/durable-root.mjs";

const CHECKER = new URL("../scripts/check-beads-export-divergence.mjs", import.meta.url).pathname;

Deno.test("toyoj: >16 MiB committed and canonical exports remain checked for missing IDs", () => {
  const root = mkdtempSync(join(durableDir("beads-export-size"), "export-"));
  try {
    const repo = join(root, "repo");
    const bin = join(root, "bin");
    mkdirSync(join(repo, ".beads"), { recursive: true });
    mkdirSync(bin);
    const exportPath = join(root, "canonical.jsonl");
    const rows = Array.from({ length: 1024 }, (_, i) =>
      JSON.stringify({ _type: "issue", id: `oversize-${i}`, padding: "x".repeat(17_000) }) + "\n");
    const committed = rows.join("");
    assert(committed.length > 16 * 1024 * 1024, "fixture must cross the former spawnSync cap");
    writeFileSync(join(repo, ".beads", "issues.jsonl"), committed);
    writeFileSync(exportPath, committed);
    const fakeBd = join(bin, "bd");
    writeFileSync(fakeBd, '#!/bin/sh\n[ "$1" = export ] && [ "$2" = --all ] || exit 2\nexec cat "$FAKE_EXPORT_FILE"\n');
    chmodSync(fakeBd, 0o755);
    const env = { ...process.env, HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
      PATH: `${bin}:${process.env.PATH ?? ""}`, FAKE_EXPORT_FILE: exportPath };
    const run = (command: string, args: string[]) => spawnSync(command, args,
      { cwd: repo, env, encoding: "utf8", timeout: 30_000 });
    assertEquals(run("git", ["init", "-q", "-b", "main"]).status, 0);
    assertEquals(run("git", ["add", ".beads/issues.jsonl"]).status, 0);
    const committedResult = run("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.test",
      "commit", "-q", "-m", "large fixture"]);
    assertEquals(committedResult.status, 0, committedResult.stderr);

    const good = run("node", [CHECKER]);
    assertEquals(good.status, 0, `oversize export must be checked, not refused as ENOBUFS: ${good.stderr}`);
    assert(good.stdout.includes("1024 committed/on-disk issue IDs"), good.stdout);

    writeFileSync(exportPath, committed.replace('"id":"oversize-0"', '"id":"replacement-0"'));
    const missing = run("node", [CHECKER]);
    assert(missing.status !== 0, "dropping an ID after the old cap must still fail closed");
    assert(missing.stderr.includes("oversize-0"), `missing ID must be named, not ENOBUFS: ${missing.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
