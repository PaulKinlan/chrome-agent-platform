// Landing-clearance checker tests (chrome-agent-platform-drhi7).
//
// THE FALSIFIER THE BEAD DEMANDS: "a linear branch where commit N is FAILED and
// N+1 is PASSed must refuse to land the range, rather than clearing N on N+1's
// verdict." These tests drive the pure resolution logic with injected git/bd
// runners — no real repo, no real bd, per the suite-independence convention
// (chrome-agent-platform-p15i): every fixture is local to the test.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  extractBeadIds,
  resolveBeadClearance,
  resolveRange,
  verdictTokenOf,
} from "../scripts/check-landing-clearance.mjs";

Deno.test("drhi7: bead ids come from structured locations only — subject + explicit BEAD lines", () => {
  const ids = extractBeadIds(
    "chrome-agent-platform-T4UVT: the user-visible thing\n\nBEAD\nchrome-agent-platform-6z8yi - the failed attempt\nProse: quoted lane chrome-agent-platform-imp-rec and sibling chrome-agent-platform-aaa1 must NOT mint beads\nBEAD: chrome-agent-platform-dd00",
  );
  assertEquals(ids, ["chrome-agent-platform-6z8yi", "chrome-agent-platform-dd00", "chrome-agent-platform-t4uvt"]);
  assertEquals(extractBeadIds("Merge fleet/imp-tier-umj72 (chrome-agent-platform-umj72): landed\n\nLane chrome-agent-platform-imp-tier quoted in prose only"), ["chrome-agent-platform-umj72"]);
  assertEquals(extractBeadIds("no bead here"), []);
});

Deno.test("drhi7: verdict tokens parse from canonical fleet-verdict comments only", () => {
  assertEquals(verdictTokenOf("VERDICT: PASS (reviewer qwen3.8-max vs implementer glm-5.3-flash)"), "PASS");
  assertEquals(verdictTokenOf("VERDICT: PASS-with-notes (reviewer a vs implementer b)"), "PASS-with-notes");
  assertEquals(verdictTokenOf("VERDICT: FAIL (reviewer a vs implementer b)"), "FAIL");
  assertEquals(verdictTokenOf("looks like a VERDICT: but is not at line start"), null);
  assertEquals(verdictTokenOf("just a status comment"), null);
});

Deno.test("drhi7 FALSIFIER: review-failed label => failed, whatever the tip's own PASS says", () => {
  const resolved = resolveBeadClearance({
    labels: ["reviewed", "review-failed"],
    comments: [{ text: "VERDICT: FAIL (reviewer a vs implementer b)\nDelta: ..." }],
  });
  assertEquals(resolved.state, "failed");
  assertStringIncludes(resolved.reason, "review-failed");
});

Deno.test("drhi7: a FAIL verdict on hand-cleaned labels still refuses (the verdict is the evidence)", () => {
  const resolved = resolveBeadClearance({
    labels: ["reviewed"],
    comments: [{ text: "VERDICT: FAIL (reviewer a vs implementer b)" }],
  });
  assertEquals(resolved.state, "failed");
});

Deno.test("drhi7: cleared label + PASS verdict => cleared at that sha", () => {
  const resolved = resolveBeadClearance({
    labels: ["cleared:ae375d530", "merge-queue", "reviewed"],
    comments: [{ text: "VERDICT: PASS (reviewer a vs implementer b)" }],
  });
  assertEquals([resolved.state, resolved.clearedSha, resolved.verdict], ["cleared", "ae375d530", "PASS"]);
});

Deno.test("drhi7: FAIL-then-PASS on one bead is CLEARED (fleet-verdict removes review-failed on the later PASS)", () => {
  const resolved = resolveBeadClearance({
    labels: ["cleared:191713265", "merge-queue", "reviewed"],
    comments: [
      { text: "VERDICT: FAIL (older round)" },
      { text: "VERDICT: PASS (re-review after fixes)" },
    ],
  });
  assertEquals([resolved.state, resolved.verdict], ["cleared", "PASS"]);
});

Deno.test("drhi7: PASS-then-FAIL on one bead is FAILED (latest verdict wins)", () => {
  const resolved = resolveBeadClearance({
    labels: ["reviewed", "review-failed"],
    comments: [
      { text: "VERDICT: PASS (older round)" },
      { text: "VERDICT: FAIL (regression found)" },
    ],
  });
  assertEquals(resolved.state, "failed");
  assertEquals(resolved.verdict, "FAIL");
});

Deno.test("drhi7: no labels, no verdict => unreviewed, not failed", () => {
  const resolved = resolveBeadClearance({ labels: [], comments: [] });
  assertEquals(resolved.state, "unreviewed");
});

/** A fake bd: bead id -> { labels, comments }. Unknown ids look like bd but return an empty record. */
function fakeBd(beads: Record<string, { labels: string[]; comments?: { text: string }[] }>) {
  return (args: string[]) => {
    const id = args[1];
    const bead = beads[id] ?? { labels: [], comments: [] };
    if (args[0] === "show") return JSON.stringify([{ id, labels: bead.labels }]);
    if (args[0] === "comments") return JSON.stringify(bead.comments ?? []);
    throw new Error(`fakeBd: unexpected ${args.join(" ")}`);
  };
}

function fakeGit(commits: { sha: string; subject: string; body?: string }[]) {
  // commits: [{ sha, subject, body }] oldest-first; git log prints newest-first.
  const records = [...commits].reverse().map((c) => `${c.sha}\x1f${c.subject}\x1f${c.body ?? ""}\x1e`);
  return () => records.join("\n");
}

Deno.test("drhi7 THE FALSIFIER: commit N review-failed + commit N+1 PASSed => the RANGE refuses", async () => {
  const report = await resolveRange("base", "tip", {
    runGit: fakeGit([
      { sha: "d49528dc8ee".padEnd(40, "0"), subject: "chrome-agent-platform-base: prior work" },
      { sha: "6z8yi1e35054".padEnd(40, "0"), subject: "chrome-agent-platform-6z8yi: the failed attempt", body: "BEAD\nchrome-agent-platform-6z8yi" },
      { sha: "19171326500".padEnd(40, "0"), subject: "chrome-agent-platform-t4uvt: the fix on top", body: "BEAD\nchrome-agent-platform-t4uvt" },
    ]),
    runBd: fakeBd({
      "chrome-agent-platform-base": {
        labels: ["cleared:d49528d", "reviewed"],
        comments: [{ text: "VERDICT: PASS" }],
      },
      "chrome-agent-platform-6z8yi": {
        labels: ["reviewed", "review-failed"],
        comments: [{ text: "VERDICT: FAIL (reviewer a vs implementer b)" }],
      },
      "chrome-agent-platform-t4uvt": {
        labels: ["cleared:1917132", "merge-queue", "reviewed"],
        comments: [{ text: "VERDICT: PASS (reviewer a vs implementer b)" }],
      },
    }),
  });
  assertEquals(report.clear, false, "a PASS on N+1 must not clear N's FAILED bead");
  assertEquals(report.refusals.length, 1);
  assertEquals(report.refusals[0].bead, "chrome-agent-platform-6z8yi");
  assertEquals(report.refusals[0].verdict, "FAIL");
  assertEquals(report.refusals[0].commits.length, 1);
  assertStringIncludes(report.refusals[0].commits[0], "6z8yi");
});

Deno.test("drhi7: an all-cleared range with beadless merger stamps is CLEAR", async () => {
  const report = await resolveRange("base", "tip", {
    runGit: fakeGit([
      { sha: "a".padEnd(40, "0"), subject: "chrome-agent-platform-aaa1: reviewed work", body: "BEAD\nchrome-agent-platform-aaa1" },
      { sha: "b".padEnd(40, "0"), subject: "fleet-land-message: no bead chrome-agent-platform-xxx in this repo" },
      { sha: "c".padEnd(40, "0"), subject: "Merge fleet/imp-tier (chrome-agent-platform-aaa1): landed", body: "BEAD\nchrome-agent-platform-aaa1" },
    ]),
    runBd: fakeBd({
      "chrome-agent-platform-aaa1": {
        labels: ["cleared:aaa1000", "merge-queue", "reviewed"],
        comments: [{ text: "VERDICT: PASS-with-notes" }],
      },
    }),
  });
  assertEquals(report.clear, true);
  assertEquals(report.refusals, []);
  assertEquals(report.commitCount, 3);
  // The beadless stamp contributes no bead; the merge commit maps to the same bead.
  const aaa = report.beads.find((b) => b.id === "chrome-agent-platform-aaa1")!;
  assertEquals(aaa.state, "cleared");
  assertEquals(aaa.commits.length, 2);
});

Deno.test("drhi7: an ancestor bead with no verdict at all is unreviewed-but-not-failed — the delta PASS covers it", async () => {
  const report = await resolveRange("base", "tip", {
    runGit: fakeGit([
      { sha: "d".padEnd(40, "0"), subject: "chrome-agent-platform-zzz9: unreviewed ancestor" },
      { sha: "e".padEnd(40, "0"), subject: "chrome-agent-platform-t4uvt: the reviewed tip" },
    ]),
    runBd: fakeBd({
      "chrome-agent-platform-t4uvt": {
        labels: ["cleared:e000000", "reviewed"],
        comments: [{ text: "VERDICT: PASS" }],
      },
    }),
  });
  assertEquals(report.clear, true, "the falsifier is FAILED ancestry, not unreviewed ancestry");
  const zzz = report.beads.find((b) => b.id === "chrome-agent-platform-zzz9")!;
  assertEquals(zzz.state, "unreviewed");
});

Deno.test("drhi7: an id that names no bead is skipped as not-a-bead, never an environment failure", async () => {
  const report = await resolveRange("base", "tip", {
    runGit: fakeGit([
      { sha: "f".padEnd(40, "0"), subject: "chrome-agent-platform-imp-rec mentioned in a merge subject" },
    ]),
    runBd: (args: string[]) => {
      if (args[0] === "show") {
        const err = new Error(
          `Command failed: bd ${args.join(" ")}\nIssue ${args[1]} not found`,
        ) as Error & { stderr?: string };
        err.stderr = `Issue ${args[1]} not found`;
        throw err;
      }
      return "[]";
    },
  });
  assertEquals(report.clear, true, "a quoted lane name is not a bead; the range is not polluted");
  assertEquals(report.beads[0].state, "not-a-bead");
});

Deno.test("drhi7: a landed bead (merger swaps cleared for `merged`) reads as cleared, not unreviewed", () => {
  const resolved = resolveBeadClearance({
    labels: ["merged", "reviewed"],
    comments: [{ text: "VERDICT: PASS (reviewer a vs implementer b)" }],
  });
  assertEquals([resolved.state, resolved.verdict], ["cleared", "PASS"]);
  assertStringIncludes(resolved.reason, "landed on main");
});
