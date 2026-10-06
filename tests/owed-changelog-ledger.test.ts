// tests/owed-changelog-ledger.test.ts — the owed-changelog ledger
// (chrome-agent-platform-xe11), in the shape of web-uplift's ledger (its kdk
// bead): committed product changes after the newest CHANGELOG entry's
// introducing commit are OWED a release entry; the check fails naming them.
//
// The fixture cases are the falsification drills: each OWED expectation fails
// if the ledger regresses into silence (a mutant that classifies everything
// not-owed reds the "owed" cases; a mutant that skips the version-agreement
// leg reds the mismatch case).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { fileURLToPath } from "node:url";
import {
  commitOwesProductChange,
  deriveLedger,
  isProductPath,
  parseNewestEntry,
} from "../scripts/check-owed-changelog.mjs";

const script = fileURLToPath(new URL("../scripts/check-owed-changelog.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

Deno.test("ledger: newest-heading parser and product-path classifier", () => {
  const md = "# Changelog\n\n## [1.2.3] — 2026-10-06\n- one\n\n## [1.2.2] — 2026-10-05\n- two\n";
  assertEquals(parseNewestEntry(md)?.version, "1.2.3");
  assertEquals(parseNewestEntry("# Changelog\n\nprose only"), null);

  // Product surface: the shipped extension, minus docs, generated data, build output.
  assert(isProductPath("extension/lib/browser-tools.js"));
  assert(isProductPath("extension/options/options.html"));
  assert(!isProductPath("extension/background/routes/ROUTE_MAP.md"), "in-tree docs are not owed");
  assert(!isProductPath("extension/lib/bundled-inventory-data.js"), "generated data is not owed");
  assert(!isProductPath("extension/dist/background/service-worker.js"), "build output is not owed");
  assert(!isProductPath("tests/x.test.ts"));
  assert(!isProductPath("scripts/check-owed-changelog.mjs"));
  assert(!isProductPath("docs/MERGER-PLAYBOOK.md"));
  assert(!isProductPath(".beads/issues.jsonl"));
  assert(!isProductPath(""));

  assert(commitOwesProductChange({ files: ["tests/a.test.ts", "extension/lib/x.js"] }));
  assert(!commitOwesProductChange({ files: ["tests/a.test.ts", "CHANGELOG.md"] }));
  assert(!commitOwesProductChange({ files: [] }));
});

// --- fixture repos: real git, temp dirs, removed afterwards (worktree-audit pattern) ---

const fixtures: string[] = [];
async function cleanupFixtures() {
  for (const dir of fixtures.splice(0)) {
    try { await Deno.remove(dir, { recursive: true }); } catch { /* already gone */ }
  }
}

async function mkLedgerRepo(name: string) {
  const dir = await Deno.makeTempDir({ prefix: `ledger-${name}-` });
  fixtures.push(dir);
  const git = (args: string[], opts: { allowConflict?: boolean } = {}) => {
    const p = new Deno.Command("git", { args, cwd: dir, stdout: "piped" as const, stderr: "piped" as const }).outputSync();
    // A conflicted --no-commit merge exits 1 with the preimage recorded — the
    // resolution step follows, so that exit is expected, not fatal.
    if (p.code !== 0 && !(opts.allowConflict && p.code === 1)) {
      throw new Error(`fixture git ${args.join(" ")} failed: ${new TextDecoder().decode(p.stderr).trim()}`);
    }
    return new TextDecoder().decode(p.stdout);
  };
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "CAP Test"]);
  git(["config", "user.email", "cap-test@example.com"]);
  // The release baseline: a CHANGELOG entry and the matching version, in the
  // commit that introduces the heading (the ledger's anchor).
  Deno.writeTextFileSync(`${dir}/CHANGELOG.md`, "# Changelog\n\n## [1.0.0] — 2026-10-05\n- first\n");
  Deno.writeTextFileSync(`${dir}/package.json`, JSON.stringify({ name: "fixture", version: "1.0.0" }, null, 2));
  Deno.mkdirSync(`${dir}/tests`, { recursive: true });
  Deno.writeTextFileSync(`${dir}/tests/seed.test.ts`, "seed\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "release 1.0.0"]);
  const commit = (message: string) => {
    git(["add", "."]);
    git(["commit", "-q", "-m", message]);
  };
  const runCli = () => {
    const p = new Deno.Command("node", {
      args: [script, "--repo", dir],
      stdout: "piped" as const,
      stderr: "piped" as const,
    }).outputSync();
    return { code: p.code, err: new TextDecoder().decode(p.stderr) };
  };
  return { dir, git, commit, runCli };
}

Deno.test("ledger: clean while only bookkeeping lands after the release", async () => {
  const repo = await mkLedgerRepo("clean");
  Deno.writeTextFileSync(`${repo.dir}/tests/only.test.ts`, "not owed\n");
  repo.commit("tests: not owed");
  Deno.mkdirSync(`${repo.dir}/.beads`, { recursive: true });
  Deno.writeTextFileSync(`${repo.dir}/.beads/issues.jsonl`, "{}\n");
  repo.commit("re-export beads");

  const ledger = deriveLedger({ repo: repo.dir });
  assertEquals(ledger.owed, []);
  assertEquals(ledger.notOwed, 2);
  assertEquals(ledger.pkgVersion, "1.0.0");
  const cli = repo.runCli();
  assertEquals(cli.code, 0, `clean ledger must exit 0 (stderr: ${cli.err})`);
  await cleanupFixtures();
});

Deno.test("ledger: a committed product change without a release entry is OWED and fails the gate", async () => {
  const repo = await mkLedgerRepo("owed");
  Deno.mkdirSync(`${repo.dir}/extension/lib`, { recursive: true });
  Deno.writeTextFileSync(`${repo.dir}/extension/lib/tool.js`, "export const x = 1;\n");
  repo.commit("feat: the product changes");

  const ledger = deriveLedger({ repo: repo.dir });
  assertEquals(ledger.owed.length, 1, "the product commit is owed a changelog entry");
  const owedEntry = ledger.owed[0] as { sha: string; subject: string; files: string[] };
  assert(owedEntry.subject.includes("the product changes"), "the owed entry names the commit");
  assertEquals(owedEntry.files, ["extension/lib/tool.js"]);

  const cli = repo.runCli();
  assertEquals(cli.code, 1, "an owed ledger must exit 1");
  assert(cli.err.includes("OWED-CHANGELOG FAIL"), "the failure names the ledger");
  assert(cli.err.includes("feat: the product changes"), "the failure names the owed commit");
  assert(cli.err.includes("1.0.0"), "the failure names the release it falls behind");
  await cleanupFixtures();
});

Deno.test("ledger: a version bumped without its changelog entry fails (both versions named)", async () => {
  const repo = await mkLedgerRepo("mismatch");
  Deno.writeTextFileSync(`${repo.dir}/package.json`, JSON.stringify({ name: "fixture", version: "1.0.1" }, null, 2));
  repo.commit("chore: release 1.0.1 (no entry)");

  const ledger = deriveLedger({ repo: repo.dir });
  assertEquals(ledger.pkgVersion, "1.0.1");
  assertEquals(ledger.newest.version, "1.0.0");
  const cli = repo.runCli();
  assertEquals(cli.code, 1, "a bumped version with no entry must exit 1");
  assert(cli.err.includes("1.0.1") && cli.err.includes("1.0.0"), "the message names both versions");
  await cleanupFixtures();
});

Deno.test("ledger: the release commit that introduces the new heading is its own anchor — clean after a release", async () => {
  const repo = await mkLedgerRepo("release");
  // A product change + the new entry + the version bump in ONE release commit:
  // the commit that introduces `## [1.1.0]` is excluded from its own ledger.
  Deno.mkdirSync(`${repo.dir}/extension/lib`, { recursive: true });
  Deno.writeTextFileSync(`${repo.dir}/extension/lib/tool.js`, "export const x = 2;\n");
  Deno.writeTextFileSync(
    `${repo.dir}/CHANGELOG.md`,
    "# Changelog\n\n## [1.1.0] — 2026-10-06\n- what the user gets\n\n## [1.0.0] — 2026-10-05\n- first\n",
  );
  Deno.writeTextFileSync(`${repo.dir}/package.json`, JSON.stringify({ name: "fixture", version: "1.1.0" }, null, 2));
  repo.commit("release 1.1.0");

  const ledger = deriveLedger({ repo: repo.dir });
  assertEquals(ledger.owed, [], "the release commit is its own anchor, not owed to itself");
  assertEquals(ledger.newest.version, "1.1.0");
  const cli = repo.runCli();
  assertEquals(cli.code, 0, `the release tree must pass (stderr: ${cli.err})`);
  await cleanupFixtures();
});

Deno.test("ledger: merge commits are out of the ledger by construction (--no-merges walk)", async () => {
  const repo = await mkLedgerRepo("merge");
  // A merge whose RESOLUTION touches product code but whose own subject is
  // bookkeeping: the merge itself must not be counted; only non-merge commits owe.
  Deno.writeTextFileSync(`${repo.dir}/notes.txt`, "base\n");
  repo.commit("base note");
  repo.git(["checkout", "-q", "-b", "side"]);
  Deno.writeTextFileSync(`${repo.dir}/notes.txt`, "side\n");
  repo.commit("side note");
  repo.git(["checkout", "-q", "main"]);
  Deno.writeTextFileSync(`${repo.dir}/notes.txt`, "main\n");
  repo.commit("main note");
  repo.git(["merge", "-q", "--no-ff", "--no-commit", "side"], { allowConflict: true });
  // The resolution: notes conflict resolved + a product file appears only in
  // the MERGE commit — neither parent carries extension/lib/tool.js.
  Deno.writeTextFileSync(`${repo.dir}/notes.txt`, "resolved\n");
  Deno.mkdirSync(`${repo.dir}/extension/lib`, { recursive: true });
  Deno.writeTextFileSync(`${repo.dir}/extension/lib/tool.js`, "resolved\n");
  repo.git(["add", "."]);
  repo.git(["commit", "-q", "-m", "Merge branch 'side'"]);

  const ledger = deriveLedger({ repo: repo.dir });
  assertEquals(ledger.owed, [], "a merge commit is bookkeeping even when its resolution touches product code");
  assert(ledger.notOwed >= 2, `the non-merge commits under the merge are classified: ${ledger.notOwed}`);
  const cli = repo.runCli();
  assertEquals(cli.code, 0, `merge-only landings do not owe entries (stderr: ${cli.err})`);
  await cleanupFixtures();
});

Deno.test("ledger: the live repo is clean — HEAD's release covers every product commit", async () => {
  // The standing guard: this goes red the moment a product commit lands on this
  // tree without its release entry, which is exactly the drift that left the
  // changelog a full day behind at 0.3.577.
  const ledger = deriveLedger({ repo: repoRoot });
  assertEquals(ledger.owed, [], `product commits owed entries: ${JSON.stringify(ledger.owed, null, 2)}`);
  assertEquals(ledger.pkgVersion, ledger.newest.version, "package.json and the newest changelog entry agree");
});
