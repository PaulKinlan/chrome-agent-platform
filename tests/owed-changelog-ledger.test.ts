// tests/owed-changelog-ledger.test.ts — the owed-changelog ledger
// (chrome-agent-platform-xe11), in the shape of web-uplift's ledger (its kdk
// bead): committed product changes after the newest CHANGELOG entry's
// introducing commit are OWED a release entry; the check fails naming them.
// The ledger also asserts EVERY version-declaring surface (package.json,
// extension/manifest.json version + version_name, package-lock.json root +
// packages[""], the inventory's `release`) agrees with the newest heading, and
// strips fenced code blocks before the heading scan so a quoted heading cannot
// satisfy coverage.
//
// The fixture cases are the falsification drills: each OWED expectation fails
// if the ledger regresses into silence (a mutant that classifies everything
// not-owed reds the "owed" cases; a mutant that skips the version-agreement
// leg reds the mismatch case; a mutant that drops fence stripping reds the
// fenced-heading case by turning the owed commit into its own anchor).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { fileURLToPath } from "node:url";
import {
  commitOwesProductChange,
  deriveLedger,
  isProductPath,
  parseNewestEntry,
  stripFencedCode,
} from "../scripts/check-owed-changelog.mjs";

const script = fileURLToPath(new URL("../scripts/check-owed-changelog.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

Deno.test("ledger: newest-heading parser and product-path classifier", () => {
  const md = "# Changelog\n\n## [1.2.3] — 2026-10-06\n- one\n\n## [1.2.2] — 2026-10-05\n- two\n";
  assertEquals(parseNewestEntry(md)?.version, "1.2.3");
  assertEquals(parseNewestEntry("# Changelog\n\nprose only"), null);

  // Fenced code blocks are stripped before the heading scan: a version heading
  // quoted inside a fence is documentation (an example, a pasted transcript),
  // not a release entry (the web-uplift reference's rule).
  const fenced =
    "# Changelog\n\n```text\n## [9.9.9] — 2026-10-07\n- quoted, not shipped\n```\n\n## [1.2.3] — 2026-10-06\n- one\n";
  assertEquals(parseNewestEntry(fenced)?.version, "1.2.3", "a fenced heading cannot be the newest release");
  assertEquals(
    parseNewestEntry("# Changelog\n\n```js\nconst md = '## [9.9.9] — 2026-10-07';\n```\n"),
    null,
    "a changelog whose only heading is fenced has no release entries",
  );
  assertEquals(stripFencedCode("```js\nfenced\n```\nkept"), "kept", "an opener with an info string opens");
  assertEquals(stripFencedCode("~~~\nfenced\n~~~\nkept"), "kept", "tilde fences work too");
  assertEquals(
    stripFencedCode("```\nstill fenced\n~~~\n```\nkept"),
    "kept",
    "a tilde fence does not close a backtick fence",
  );
  assertEquals(stripFencedCode("no fences\nhere"), "no fences\nhere");

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
  // The release baseline: a CHANGELOG entry and the version on EVERY surface
  // that declares it (the six bump-version.mjs maintains over five files), in
  // the commit that introduces the heading (the ledger's anchor).
  const writeSurfaces = (version: string) => {
    Deno.writeTextFileSync(`${dir}/package.json`, JSON.stringify({ name: "fixture", version }, null, 2));
    Deno.writeTextFileSync(
      `${dir}/extension/manifest.json`,
      JSON.stringify({ manifest_version: 3, name: "Fixture", version, version_name: version }, null, 2),
    );
    Deno.writeTextFileSync(
      `${dir}/package-lock.json`,
      JSON.stringify(
        { name: "fixture", version, lockfileVersion: 3, packages: { "": { name: "fixture", version } } },
        null,
        2,
      ),
    );
    Deno.writeTextFileSync(
      `${dir}/extension/lib/bundled-inventory-data.js`,
      `// GENERATED\nexport const BUNDLED_INVENTORY = Object.freeze({ "schemaVersion": 1, "release": "${version}" });\n`,
    );
  };
  Deno.writeTextFileSync(`${dir}/CHANGELOG.md`, "# Changelog\n\n## [1.0.0] — 2026-10-05\n- first\n");
  Deno.mkdirSync(`${dir}/extension/lib`, { recursive: true });
  writeSurfaces("1.0.0");
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
  return { dir, git, commit, runCli, writeSurfaces };
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
  // A product change + the new entry + the version on EVERY surface in ONE
  // release commit: the commit that introduces `## [1.1.0]` is excluded from
  // its own ledger.
  Deno.mkdirSync(`${repo.dir}/extension/lib`, { recursive: true });
  Deno.writeTextFileSync(`${repo.dir}/extension/lib/tool.js`, "export const x = 2;\n");
  Deno.writeTextFileSync(
    `${repo.dir}/CHANGELOG.md`,
    "# Changelog\n\n## [1.1.0] — 2026-10-06\n- what the user gets\n\n## [1.0.0] — 2026-10-05\n- first\n",
  );
  repo.writeSurfaces("1.1.0");
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

Deno.test("ledger: extension/manifest.json drifting from the changelog fails, naming the manifest", async () => {
  const repo = await mkLedgerRepo("manifest-drift");
  // The realistic rot: package.json, the lockfile and the changelog still agree
  // at 1.0.0, but the extension's BUILD identity (the manifest) drifted alone —
  // invisible to any package.json-only check.
  Deno.writeTextFileSync(
    `${repo.dir}/extension/manifest.json`,
    JSON.stringify({ manifest_version: 3, name: "Fixture", version: "0.9.9", version_name: "0.9.9" }, null, 2),
  );
  repo.commit("chore: the manifest drifts alone");

  const ledger = deriveLedger({ repo: repo.dir });
  const manifestVersion = ledger.surfaces.find((s) => s.label === "extension/manifest.json version");
  assertEquals(manifestVersion?.version, "0.9.9", "the manifest surface is read independently of package.json");
  const cli = repo.runCli();
  assertEquals(cli.code, 1, "a manifest/changelog version drift must exit 1");
  assert(cli.err.includes("extension/manifest.json"), "the failure names the manifest surface");
  assert(cli.err.includes("0.9.9"), "the failure names the manifest's version");
  assert(cli.err.includes("1.0.0"), "the failure names the release it drifts from");
  await cleanupFixtures();
});

Deno.test("ledger: every version-declaring surface agreeing with the newest entry passes", async () => {
  const repo = await mkLedgerRepo("agreement");
  // The full release shape: the new heading and the version on ALL six surfaces
  // (five files) in one commit — nothing drifted, nothing owed.
  Deno.writeTextFileSync(
    `${repo.dir}/CHANGELOG.md`,
    "# Changelog\n\n## [1.1.0] — 2026-10-06\n- what the user gets\n\n## [1.0.0] — 2026-10-05\n- first\n",
  );
  repo.writeSurfaces("1.1.0");
  repo.commit("release 1.1.0");

  const ledger = deriveLedger({ repo: repo.dir });
  assertEquals(ledger.surfaces.length, 6, `all six surfaces are read: ${JSON.stringify(ledger.surfaces)}`);
  for (const surface of ledger.surfaces) {
    assertEquals(surface.version, "1.1.0", `${surface.label} carries the new release`);
  }
  assertEquals(ledger.owed, [], "the release commit is its own anchor");
  const cli = repo.runCli();
  assertEquals(cli.code, 0, `full agreement must pass (stderr: ${cli.err})`);
  await cleanupFixtures();
});

Deno.test("ledger: a version heading inside a fenced code block does not satisfy coverage", async () => {
  const repo = await mkLedgerRepo("fenced");
  // One commit ships product code AND quotes a `## [1.1.0]` heading inside a
  // fenced block (a pasted transcript above the real entries). Without fence
  // stripping the quoted heading is "the newest release" and the commit becomes
  // its own anchor — coverage silently satisfied. With stripping, the heading is
  // documentation: the commit is still owed against the real [1.0.0] release.
  Deno.writeTextFileSync(
    `${repo.dir}/CHANGELOG.md`,
    "# Changelog\n\nA pasted transcript, not a release:\n\n```text\n## [1.1.0] — 2026-10-06\n- quoted, not shipped\n```\n\n## [1.0.0] — 2026-10-05\n- first\n",
  );
  Deno.mkdirSync(`${repo.dir}/extension/lib`, { recursive: true });
  Deno.writeTextFileSync(`${repo.dir}/extension/lib/tool.js`, "export const x = 3;\n");
  repo.commit("feat: ships code, quotes a release inside a fence");

  const ledger = deriveLedger({ repo: repo.dir });
  assertEquals(ledger.newest.version, "1.0.0", "the fenced heading is not treated as a release");
  assertEquals(ledger.owed.length, 1, "the fenced heading did not satisfy coverage — the commit is still owed");
  const cli = repo.runCli();
  assertEquals(cli.code, 1, "the owed commit still fails the gate");
  assert(
    cli.err.includes("feat: ships code, quotes a release inside a fence"),
    "the failure is the owed leg naming the commit, not a version disagreement",
  );
  await cleanupFixtures();
});

Deno.test("ledger: the live repo is clean — HEAD's release covers every product commit", async () => {
  // The standing guard: this goes red the moment a product commit lands on this
  // tree without its release entry, which is exactly the drift that left the
  // changelog a full day behind at 0.3.577.
  const ledger = deriveLedger({ repo: repoRoot });
  assertEquals(ledger.owed, [], `product commits owed entries: ${JSON.stringify(ledger.owed, null, 2)}`);
  assertEquals(ledger.surfaces.length, 6, `every surface is enumerated: ${JSON.stringify(ledger.surfaces)}`);
  for (const surface of ledger.surfaces) {
    assertEquals(
      surface.version,
      ledger.newest.version,
      `${surface.label} agrees with the newest changelog entry`,
    );
  }
  assertEquals(ledger.pkgVersion, ledger.newest.version, "package.json and the newest changelog entry agree");
});
