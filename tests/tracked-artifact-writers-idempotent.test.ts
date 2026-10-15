// chrome-agent-platform-bverr: THE GATE'S OWN BUILD MUST NOT TOUCH A TRACKED FILE IT DOES NOT CHANGE.
//
// Measured 2026-10-14: `npm run build:production` (which every full gate runs, via build.mjs) rewrote 34
// tracked files - 33 under docs/ and extension/about/about.html - with IDENTICAL bytes, so `git status` stayed
// clean and only their nsec ctime moved. The fleet's gate witness records nsec ctime rather than content ON
// PURPOSE (so a mutate-then-revert cannot hide), which is why that movement invalidated CAP full gates as
// STALE over a tree nobody had changed. This test is built to that defect: it runs the two writers the build
// calls, in WRITE mode, against this in-sync tree and asserts no tracked file under their targets moved in
// time. On the pre-fix writers it reds once per rewritten file.
//
// PREMISE FIRST: both check modes must report no drift before anything is written, so a drifted tree fails
// loudly here rather than being silently "fixed" by a test.
import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { fileURLToPath } from "node:url";
import { sameBytes, syncGallery } from "../scripts/sync-gallery.mjs";
import { syncAboutPage } from "../scripts/generate-about-page.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// Millisecond resolution (this Deno's FileInfo has no *Ns fields). The short settling wait below is only there
// so that a write, if one happens, cannot land in the same millisecond as the snapshot - it widens the window
// in which a defect is DETECTED, so a busy machine cannot turn this red test green.
function stamps(paths: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of paths) {
    const s = Deno.statSync(p);
    out[p] = `${s.size}:${s.mtime?.getTime() ?? -1}:${s.ctime?.getTime() ?? -1}`;
  }
  return out;
}

async function settle(): Promise<void> {
  const until = Date.now() + 25;
  while (Date.now() < until) await new Promise((r) => setTimeout(r, 5));
}

function trackedUnder(dir: string): string[] {
  const run = new Deno.Command("git", { args: ["ls-files", "-z", dir], cwd: ROOT, stdout: "piped" }).outputSync();
  return new TextDecoder().decode(run.stdout).split("\0").filter(Boolean).map((p) => `${ROOT}/${p}`);
}

Deno.test("bverr: an in-sync gallery write pass rewrites nothing under docs/", async () => {
  const docs = trackedUnder("docs");
  assert(docs.length > 20, `expected the tracked docs tree, found ${docs.length} file(s)`);
  assertEquals(
    await syncGallery({ check: true }),
    true,
    "docs/ has drifted from extension/; repair the tree before this test can mean anything",
  );
  const before = stamps(docs);
  await settle();
  assertEquals(await syncGallery(), true, "the write pass must still report success");
  for (const p of docs) assertEquals(stamps([p])[p], before[p], `${p} was rewritten although it was in sync`);
});

Deno.test("bverr: an in-sync about-page pass rewrites nothing", async () => {
  const page = `${ROOT}/extension/about/about.html`;
  assertEquals(
    await syncAboutPage({ root: ROOT, check: true }),
    true,
    "extension/about/about.html has drifted; repair the tree before this test can mean anything",
  );
  const before = stamps([page]);
  await settle();
  assertEquals(await syncAboutPage({ root: ROOT, check: false }), true);
  assertEquals(stamps([page])[page], before[page], "about.html was rewritten although it was already current");
});

// The other half of "write only when bytes differ": a real change must still be a write, and a missing deployed
// copy must still be created. (End to end, a real drift is still detected and repaired: the check modes above
// fail on it, `npm run check:about`/`sync:gallery -- --check` are the CLI forms, and
// tests/about-page-drift-guard.test.ts proves the about path against a fixture root.)
Deno.test("bverr falsifier: byte differences are still writes", () => {
  const bytes = (s: string) => new TextEncoder().encode(s);
  assert(sameBytes(bytes("same"), bytes("same")), "identical bytes must read as in sync");
  assertFalse(sameBytes(null, bytes("same")), "an absent deployed copy must be created");
  assertFalse(sameBytes(bytes("same"), bytes("samf")), "a differing byte must be a write");
  assertFalse(sameBytes(bytes("same"), bytes("same-and-more")), "a length difference must be a write");
});
