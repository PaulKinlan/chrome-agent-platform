// tests/beads-landing-link.test.ts — the landing→bead link (j4t1).
//
// Three closures in one hour (nwhc, z5hh, xrh4) were beads whose work was
// already on main while the record stayed open, and the inverse failure (closed
// beads whose work never landed) is worse. Ancestry proves nothing either way,
// so the durable link is the commit-message reference the fleet already writes:
// 28 of the last 30 commits on main name a bead.
//
// Hermetic cases build their own scratch git repo under the durable root; the
// last case is SOURCE-BOUND: it runs the real extractor over the real history
// and requires it to find the links that exist there.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { spawnSync } from "node:child_process";
import { writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import { extractBeadRefs, groupByBead, landingLinks, verifyBeadLanded } from "../scripts/beads-landing-link.mjs";

function git(root: string, args: string[]): string {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return String(r.stdout ?? "").trim();
}

/** A scratch repo whose commits carry bead references the way the fleet writes them. */
function scratchRepo(): string {
  const root = Deno.makeTempDirSync({ dir: durableDir("beads-landing-link") });
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "landing-link@example.com"]);
  git(root, ["config", "user.name", "landing link test"]);
  const commit = (subject: string, body = "") => {
    writeFileSync(join(root, "state.txt"), `${subject}\n`, { flag: "a" });
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", subject, ...(body ? ["-m", body] : [])]);
  };
  commit("chrome-agent-platform-aaaa: first piece of work");
  commit("chrome-agent-platform-bbbb: second piece", "Refs chrome-agent-platform-aaaa too (body reference).");
  commit("unrelated subject with no bead id");
  commit("chrome-agent-platform-cccc.2: a dotted child id");
  return root;
}

Deno.test("beads-landing-link: subjects, bodies and dotted child ids are extracted, once per commit (j4t1)", () => {
  const refs = extractBeadRefs([
    "a".repeat(40) + "\x1fchrome-agent-platform-aaaa: work\x1f",
    "b".repeat(40) + "\x1fchrome-agent-platform-bbbb: more\x1fRefs chrome-agent-platform-aaaa in the body",
    "c".repeat(40) + "\x1fno bead here\x1f",
    "d".repeat(40) + "\x1fchrome-agent-platform-cccc.2: child\x1f",
  ].join("\x1e"));
  const beads = refs.map((r) => r.bead).sort();
  assertEquals(beads, [
    "chrome-agent-platform-aaaa",
    "chrome-agent-platform-aaaa",
    "chrome-agent-platform-bbbb",
    "chrome-agent-platform-cccc.2",
  ]);
  assertEquals(refs.filter((r) => r.bead.endsWith("aaaa")).length, 2, "a body reference is a reference");
});

Deno.test("beads-landing-link: a real range reports every referenced bead with its commits (j4t1)", () => {
  const root = scratchRepo();
  try {
    const links = landingLinks({ cwd: root, range: "HEAD" });
    assertEquals(links.map((l) => l.bead).sort(), [
      "chrome-agent-platform-aaaa",
      "chrome-agent-platform-bbbb",
      "chrome-agent-platform-cccc.2",
    ]);
    const bbbb = links.find((l) => l.bead === "chrome-agent-platform-bbbb");
    assert(bbbb?.commits[0].subject.includes("second piece"), JSON.stringify(bbbb));
    assertEquals(groupByBead([]).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

Deno.test("beads-landing-link: a bead with no landing reference is reported as not landed (the inverse failure) (j4t1)", () => {
  const root = scratchRepo();
  try {
    const landed = verifyBeadLanded({ cwd: root, bead: "chrome-agent-platform-bbbb", branch: "HEAD" });
    assertEquals(landed.landed, true);
    assertEquals(landed.commits.length, 1);
    const never = verifyBeadLanded({ cwd: root, bead: "chrome-agent-platform-zzzz", branch: "HEAD" });
    assertEquals(never.landed, false, "a bead nobody referenced must report not-landed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

Deno.test("beads-landing-link: SOURCE-BOUND — the real history yields the links that exist there (j4t1)", async () => {
  const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
  const links = landingLinks({ cwd: root, range: "origin/main~30..origin/main" });
  // The measured fact that motivated the tool: most recent commits name a bead.
  assert(links.length >= 15, `expected the real history to reference many beads, got ${links.length}`);
  assert(links.every((l) => l.bead.startsWith("chrome-agent-platform-")), JSON.stringify(links.slice(0, 3)));
  // And at least one referenced bead is CLOSED, i.e. the link would have let a
  // lane see the landing from the record instead of re-deriving it.
  const closed = links.filter((l) =>
    String(spawnSync("bd", ["show", l.bead], { cwd: root, encoding: "utf8" }).stdout ?? "").includes("CLOSED")
  );
  assert(closed.length >= 1, "expected at least one already-closed referenced bead in the last 30 commits");
});
