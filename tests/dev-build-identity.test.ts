// tests/dev-build-identity.test.ts — chrome-agent-platform-x0vas.
//
// With the per-commit version hook gone (uikt5), the version in the tree is the
// LAST LANDED version on every dev build; the ADR's display decision is that a
// dev build shows "v<last-landed> (<branch>)" so two loaded worktrees are
// distinguishable. This file pins the three pieces: the build-side identity
// helpers, the display-side label/reader, and the live wiring (build writes the
// identity; the About surfaces render the label).

import { assert, assertEquals } from "jsr:@std/assert@1";
import { currentGitBranch, devVersionLabel as buildSideLabel, isLandedBranch } from "../scripts/lib/build-identity.mjs";
import { devVersionLabel, loadDevBuildIdentity } from "../extension/lib/dev-build-identity.js";

Deno.test("build-identity: a landed branch is main/master/origin-*, anything else is dev", () => {
  assertEquals(isLandedBranch("main"), true);
  assertEquals(isLandedBranch("master"), true);
  assertEquals(isLandedBranch("origin/main"), true);
  assertEquals(isLandedBranch(undefined), true, "no branch reads as landed (fail plain)");
  assertEquals(isLandedBranch("fleet/imp-stack"), false);
  assertEquals(isLandedBranch(""), true, "empty normalizes to landed");
});

Deno.test("build-identity: the label is bare for landed builds and names the branch for dev builds", () => {
  assertEquals(buildSideLabel("0.3.724", "main"), "v0.3.724");
  assertEquals(buildSideLabel("0.3.724", undefined), "v0.3.724");
  assertEquals(buildSideLabel("0.3.724", "fleet/imp-stack"), "v0.3.724 (fleet/imp-stack)");
  assertEquals(buildSideLabel(undefined, "fleet/imp-stack"), "", "no version → empty (placeholder stays)");
});

Deno.test("build-identity: an unavailable git never throws — it reads as landed", () => {
  const branch = currentGitBranch("/nonexistent-root-certainly", () => {
    throw new Error("no git here");
  });
  assertEquals(branch, null);
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

Deno.test("wiring: build.mjs stages the identity before the dist.complete marker", () => {
  const build = Deno.readTextFileSync("build.mjs");
  // LIVE write path: the staged file is named exactly where the marker's input
  // tree is finalized, and both identity fields come from the bounded git reads.
  assert(build.includes('path.join(STAGE, "build-identity.json")'), "build.mjs must write dist/build-identity.json into the STAGE");
  const marker = build.indexOf("writeDistCompleteMarker(");
  const identity = build.indexOf('path.join(STAGE, "build-identity.json")');
  assert(identity > 0 && marker > identity, "the identity must be staged BEFORE writeDistCompleteMarker hashes the tree");
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
