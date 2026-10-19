// tests/dev-build-identity.test.ts — chrome-agent-platform-x0vas.
//
// With the per-commit version hook gone (uikt5), the version in the tree is the
// LAST LANDED version on every dev build; the ADR's display decision is that a
// dev build shows "v<last-landed> (<branch>)" so two loaded worktrees are
// distinguishable. This file pins the three pieces: the build-side identity
// helpers, the display-side label/reader, and the live wiring (build writes the
// identity; the About surfaces render the label).

import { assert, assertEquals } from "jsr:@std/assert@1";
import { currentGitBranch, currentGitCommit, devVersionLabel as buildSideLabel, isLandedBranch } from "../scripts/lib/build-identity.mjs";
import { devVersionLabel, loadDevBuildIdentity } from "../extension/lib/dev-build-identity.js";

Deno.test("build-identity: a landed branch is main/master/origin-*, anything else is dev", () => {
  assertEquals(isLandedBranch("main"), true);
  assertEquals(isLandedBranch("master"), true);
  assertEquals(isLandedBranch("origin/main"), true);
  assertEquals(isLandedBranch(undefined), true, "no branch reads as landed (fail plain)");
  assertEquals(isLandedBranch("fleet/imp-stack"), false);
  assertEquals(isLandedBranch(""), true, "empty normalizes to landed");
  // chrome-agent-platform-7usma: a detached checkout reports branch "HEAD" —
  // that is a DEV build, never a landed one.
  assertEquals(isLandedBranch("HEAD"), false, "detached HEAD is a dev checkout");
});

Deno.test("build-identity: the label is bare for landed builds and names the branch for dev builds", () => {
  // The node side re-exports the CANONICAL label (4169y): identity-object shape.
  assertEquals(buildSideLabel("0.3.724", { branch: "main" }), "v0.3.724");
  assertEquals(buildSideLabel("0.3.724", undefined), "v0.3.724");
  assertEquals(buildSideLabel("0.3.724", { branch: "fleet/imp-stack" }), "v0.3.724 (fleet/imp-stack)");
  assertEquals(buildSideLabel(undefined, { branch: "fleet/imp-stack" }), "", "no version → empty (placeholder stays)");
});

Deno.test("build-identity: a detached checkout renders the commit, never the bare HEAD (7usma)", () => {
  assertEquals(devVersionLabel("0.3.724", { branch: "HEAD", commit: "2c19f92" }), "v0.3.724 (detached 2c19f92)");
  assertEquals(devVersionLabel("0.3.724", { branch: "HEAD", commit: null }), "v0.3.724 (detached unknown)", "a commit-less detached read stays honest, not bare");
  assertEquals(devVersionLabel("0.3.724", { branch: "fleet/x", commit: "abc" }), "v0.3.724 (fleet/x)", "a real branch name is still the label");
});

Deno.test("build-identity: an unavailable git never throws — it reads as landed", async () => {
  const branch = await currentGitBranch("/nonexistent-root-certainly", () => {
    throw new Error("no git here");
  });
  assertEquals(branch, null);
  const commit = await currentGitCommit("/nonexistent-root-certainly", () => null);
  assertEquals(commit, null, "a bounded-runner null stays null, never the string \"null\"");
});

Deno.test("display: devVersionLabel renders branch identity from the loaded identity object", () => {
  assertEquals(devVersionLabel("0.3.724", null), "v0.3.724");
  assertEquals(devVersionLabel("0.3.724", { branch: "main", commit: "abc" }), "v0.3.724");
  assertEquals(devVersionLabel("0.3.724", { branch: "fleet/x", commit: "abc" }), "v0.3.724 (fleet/x)");
  assertEquals(devVersionLabel("0.3.724", { branch: null, commit: null }), "v0.3.724");
  assertEquals(devVersionLabel(undefined, { branch: "fleet/x" }), "");
});

Deno.test("display: loadDevBuildIdentity reads the staged identity and fails soft to a landed build", async () => {
  const ok = await loadDevBuildIdentity({
    getURL: (p) => `chrome-extension://id/${p}`,
    fetch: (async () => ({ ok: true, json: async () => ({ branch: "fleet/x", commit: "abc1234" }) })) as any,
  });
  assertEquals(ok, { branch: "fleet/x", commit: "abc1234" });

  const httpFailure = await loadDevBuildIdentity({
    getURL: (p) => `chrome-extension://id/${p}`,
    fetch: (async () => ({ ok: false })) as any,
  });
  assertEquals(httpFailure, null, "a non-ok read is a landed build, never an error");

  const malformed = await loadDevBuildIdentity({
    getURL: (p) => `chrome-extension://id/${p}`,
    fetch: (async () => ({ ok: true, json: async () => "not an object" })) as any,
  });
  assertEquals(malformed, null);
});

Deno.test("display: loadDevBuildIdentity normalizes absent fields to null", async () => {
  const partial = await loadDevBuildIdentity({
    getURL: (p) => `chrome-extension://id/${p}`,
    fetch: (async () => ({ ok: true, json: async () => ({ branch: "", extra: 1 }) })) as any,
  });
  assertEquals(partial, { branch: null, commit: null });
});

/**
 * a7ybr: what a duplicate landed-ness rule LOOKS like, in every spelling that
 * means "is this branch a landed ref" — a branch-membership test against
 * origin/* or main/master. Matching one literal form (`startsWith("origin/")`)
 * let a variant spelling through; matching the family does not.
 */
const LANDEDNESS_RULE = new RegExp([
  String.raw`(?:startsWith|includes|endsWith)\s*\(\s*["'\`]origin[\/-]`,
  String.raw`(?:indexOf|search)\s*\(\s*["'\`]origin[\/-][^)]*\)\s*[!=]==?\s*0`,
  String.raw`[!=]==?\s*["'\`](?:main|master)["'\`]`,
  String.raw`["'\`](?:main|master)["'\`]\s*[!=]==?`,
].join("|"));

/** Node-side files that own identity plumbing and must NOT restate the rule. */
const NODE_SIDE_IDENTITY_FILES = ["build.mjs", "scripts/lib/build-identity.mjs"];

/**
 * a7ybr: a third file must not be able to escape by living one directory away.
 * Every `scripts/lib/*.mjs` is scanned (a single-level read of one directory, no
 * repo walk), so moving the rule into a sibling helper is still caught.
 */
function nodeIdentityLibraryFiles(): string[] {
  return [...Deno.readDirSync("scripts/lib")]
    .filter((entry) => entry.isFile && entry.name.endsWith(".mjs"))
    .map((entry) => `scripts/lib/${entry.name}`);
}

Deno.test("wiring: build.mjs stages the identity before the dist.complete marker, through the single-sourced loader (4169y)", async () => {
  const build = Deno.readTextFileSync("build.mjs");
  // LIVE write path: the staged file is named exactly where the marker's input
  // tree is finalized, and both identity fields come from the shared loader.
  assert(build.includes('path.join(STAGE, "build-identity.json")'), "build.mjs must write dist/build-identity.json into the STAGE");
  const marker = build.indexOf("writeDistCompleteMarker(");
  const identity = build.indexOf('path.join(STAGE, "build-identity.json")');
  assert(identity > 0 && marker > identity, "the identity must be staged BEFORE writeDistCompleteMarker hashes the tree");
  assert(build.includes('"./scripts/lib/build-identity.mjs"'), "build.mjs must read identity through scripts/lib/build-identity.mjs, not inline git reads (4169y)");
  assert(build.includes("currentGitBranch(ROOT, gitShow)"), "the branch read goes through the shared loader with the bounded runner");
  assert(build.includes("currentGitCommit(ROOT, gitShow)"), "the commit read goes through the shared loader with the bounded runner");
  assert(!LANDEDNESS_RULE.test(build.slice(0, build.indexOf("gitShow"))),
    "build.mjs carries no landed-ness rule above its gitShow usage (4169y/a7ybr)");
  // 4169y: the re-export must be FUNCTIONAL, not prose — the node module's
  // devVersionLabel/isLandedBranch must be the SAME function objects as the
  // canonical extension lib (a text pin here was an import shadow: it passed
  // with the guarded construct deleted).
  const canonical = await import("../extension/lib/dev-build-identity.js");
  assertEquals(buildSideLabel, canonical.devVersionLabel, "the node side must re-export the CANONICAL devVersionLabel");
  assertEquals(isLandedBranch, canonical.isLandedBranch, "the node side must re-export the CANONICAL isLandedBranch");
  // a7ybr: the old pin was (1) unable to fail — `|| true` — and (2) matched ONE
  // spelling, so `b.indexOf("origin/") === 0` or a `=== "main"` test escaped. The
  // rule is a BRANCH-MEMBERSHIP TEST, so the scan matches the family, and it
  // includes a POSITIVE CONTROL: if the canonical rule vanishes, this fails.
  const CANONICAL_IDENTITY = "extension/lib/dev-build-identity.js";
  const ruleSites = [...NODE_SIDE_IDENTITY_FILES, ...nodeIdentityLibraryFiles()]
    .filter((rel) => rel !== CANONICAL_IDENTITY && LANDEDNESS_RULE.test(Deno.readTextFileSync(rel)));
  assertEquals(ruleSites, [], `the landed-ness rule must be single-sourced in ${CANONICAL_IDENTITY}, re-defined in: ${ruleSites}`);
  assert(LANDEDNESS_RULE.test(Deno.readTextFileSync(CANONICAL_IDENTITY)),
    `the canonical landed-ness rule is MISSING from ${CANONICAL_IDENTITY} — the scan above proves nothing without it`);
});

Deno.test("wiring: both About surfaces render the identity label, not a bare version concat", () => {
  for (const rel of ["extension/options/panels/about.js", "extension/options/options.js"]) {
    const src = Deno.readTextFileSync(rel);
    assert(src.includes("devVersionLabel("), `${rel} must render through devVersionLabel`);
    assert(src.includes("loadDevBuildIdentity()"), `${rel} must load the build identity`);
    // The #about-version / #app-version site itself must go through the label
    // (changelog-entry heads legitimately keep their own "v" + version render).
    assert(!/\$\("#(about|app)-version"\)[\s\S]{0,200}textContent = "v" \+ v/.test(src), `${rel} version element must use devVersionLabel`);
  }
});
