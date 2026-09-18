// tests/source-materialization.test.ts — permanent controls for the source
// closure a fresh-checkout fixture must contain (chrome-agent-platform-woem).
//
// The defect these pin: `git ls-files` alone is the TRACKED set, so a candidate
// that adds a source module materialized WITHOUT it and the child generator died
// with ERR_MODULE_NOT_FOUND — a "fresh checkout" verifying a tree the candidate
// never built. Reproduced end-to-end on 53e28546 by adding an untracked module
// and importing it from a tracked file: the fixture's child failed to resolve
// that module from inside the fixture's own temporary directory. With the
// closure materializer the same dependency is copied and the child runs. The
// exact pre-fix and post-fix outputs are recorded in
// cap-evidence/woem-two-state-evidence.md.
//
// Hermetic: every case builds its own scratch git repo under the durable root,
// so it proves inclusion EXCLUSION and fail-closed behaviour without dirtying
// this checkout. Scratch never goes to tmpfs (bead chp).
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import { listSourceClosure, materializeSourceTree } from "../scripts/lib/source-materialization.mjs";

function git(root: string, args: string[]): string {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return String(r.stdout ?? "").trim();
}

/** A scratch repo whose tracked entry imports an UNTRACKED module, with ignored
 * scratch/ and node_modules/ content present on disk but never in the index. */
async function scratchRepo(): Promise<string> {
  const root = await Deno.makeTempDir({ dir: durableDir("source-materialization") });
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "source-closure@example.com"]);
  git(root, ["config", "user.name", "source closure test"]);
  Deno.mkdirSync(join(root, "src"), { recursive: true });
  Deno.mkdirSync(join(root, "scratch"), { recursive: true });
  Deno.mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(root, ".gitignore"), "scratch/\nnode_modules/\n");
  writeFileSync(
    join(root, "src", "entry.mjs"),
    'import { DEP } from "./untracked-dep.mjs";\nconsole.log(`DEP-${DEP}`);\n',
  );
  writeFileSync(join(root, "scratch", "secret.txt"), "must never be copied\n");
  writeFileSync(join(root, "node_modules", "pkg", "index.js"), "export const borrowed = true;\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "base"]);
  // The dependency the candidate adds AFTER the commit: untracked, not ignored.
  writeFileSync(join(root, "src", "untracked-dep.mjs"), 'export const DEP = "OK";\n');
  return root;
}

Deno.test("source materialization: an untracked non-ignored dependency is included and RUNS from the copy (woem)", async () => {
  const root = await scratchRepo();
  const dest = join(dirnameOf(root), `${basename(root)}-copy`);
  try {
    const closure = listSourceClosure({ root });
    assert(
      closure.includes("src/untracked-dep.mjs"),
      `the untracked dependency is missing from the closure: ${JSON.stringify(closure)}`,
    );
    // Ignored content stays out — that is what keeps scratch, secrets and
    // borrowed dependencies from entering a fixture.
    assert(!closure.includes("scratch/secret.txt"), "ignored scratch entered the closure");
    assert(!closure.includes("node_modules/pkg/index.js"), "node_modules entered the closure");

    const { count } = materializeSourceTree({ root, dest });
    assert(count >= 3, `expected at least entry/.gitignore/dep, got ${count}`);
    assert(!existsSync(join(dest, "scratch", "secret.txt")), "ignored scratch was copied");
    assert(!existsSync(join(dest, "node_modules")), "node_modules was copied");

    // BEHAVIOUR, not just a list: run the materialized entry. Before the fix the
    // copy lacked the dependency and node exited with ERR_MODULE_NOT_FOUND.
    const child = spawnSync("node", [join(dest, "src", "entry.mjs")], { encoding: "utf8" });
    assert(
      child.status === 0 && String(child.stdout).includes("DEP-OK"),
      `the materialized tree could not run: status=${child.status} stdout=${child.stdout} stderr=${child.stderr}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});

Deno.test("source materialization: a listed source missing on disk fails the materialization closed (woem)", async () => {
  const root = await scratchRepo();
  const dest = join(dirnameOf(root), `${basename(root)}-copy2`);
  try {
    // Still in the index, deleted from the working tree: a fixture must never
    // silently omit it.
    rmSync(join(root, "src", "entry.mjs"));
    await assertRejects(
      async () => materializeSourceTree({ root, dest }),
      Error,
      "missing on disk",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});

Deno.test("source materialization: the closure is deterministic and the named evidence roots are the only ignored inputs (woem)", async () => {
  const root = await scratchRepo();
  try {
    Deno.mkdirSync(join(root, "evidence-tree"), { recursive: true });
    writeFileSync(join(root, "evidence-tree", "receipt.json"), "{}\n");
    writeFileSync(join(root, ".gitignore"), "scratch/\nnode_modules/\nevidence-tree/\n");
    const bare = listSourceClosure({ root });
    const named = listSourceClosure({ root, evidenceRoots: ["evidence-tree"] });
    assertEquals(bare.includes("evidence-tree/receipt.json"), false, "an ignored tree entered without being named");
    assertEquals(named.includes("evidence-tree/receipt.json"), true, "a NAMED evidence root was not included");
    assertEquals(listSourceClosure({ root }), bare, "the closure must be deterministic");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// path.dirname without importing it twice
function dirnameOf(p: string): string {
  return p.slice(0, p.lastIndexOf("/")) || "/";
}
