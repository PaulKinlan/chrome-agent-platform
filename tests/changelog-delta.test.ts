// tests/changelog-delta.test.ts — the build changelog-delta feature
// (CAP-FB-20260830-BUILD-CHANGELOG-PRINT-01): `npm run build` prints the
// entries that landed between the previously-built version and the current
// one. Pure-module tests — no real build runs here.
// @ts-nocheck
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  compareVersions,
  deltaBetween,
  isValidVersion,
  parseChangelog,
  readChangelogOrNull,
  readLastBuiltVersion,
  renderDelta,
  shouldRecordBuild,
  writeLastBuiltVersion,
} from "../scripts/changelog-delta.mjs";

const SAMPLE = `# Changelog

## [0.2.484] — 2026-08-30
- Five more fixes are in progress in parallel and recorded as claimed in the tracker.

## [0.2.483] — 2026-08-30
- Two smaller follow-up issues found during the parallel work are now written down as tasks.

## [0.2.480] — 2026-08-30
- Housekeeping: two parallel work streams reconciled.

## [0.2.479] — 2026-08-30
- Tracker: the thread run-state view is recorded as landed.
`;

Deno.test("compareVersions: numeric per-part comparison", () => {
  assertEquals(compareVersions("0.2.484", "0.2.484"), 0);
  assertEquals(compareVersions("0.2.484", "0.2.483"), 1);
  assertEquals(compareVersions("0.2.483", "0.2.484"), -1);
  assertEquals(compareVersions("0.10.0", "0.9.9"), 1); // not lexicographic
  assertEquals(compareVersions("1.0.0", "0.9.9"), 1);
  // Garbage: unreachable via deltaBetween (versions are isValidVersion-gated
  // upstream); documented behavior is deterministic — "garbage" → [0] per
  // part-count, so any real version compares greater.
  assertEquals(compareVersions("0.2.484", "garbage"), 1);
});

Deno.test("parseChangelog: headers + bullets, newest first", () => {
  const parsed = parseChangelog(SAMPLE);
  assertEquals(parsed.length, 4);
  assertEquals(parsed[0].version, "0.2.484");
  assertEquals(parsed[0].title, "2026-08-30");
  assert(parsed[0].bullets.length >= 1);
  assertEquals(parsed[3].version, "0.2.479");
});

Deno.test("renderDelta: newest LAST is implemented (oldest first, newest final line)", () => {
  const parsed = parseChangelog(SAMPLE);
  const delta = deltaBetween(parsed, null, "0.2.484"); // newest first: [484, 483, 480, 479]
  const rendered = renderDelta(delta);
  const entryLines = rendered.split("\n").filter((l) => l.startsWith("- 0.2."));
  // The FIRST entry line is the oldest shown; the LAST entry line is newest.
  assertEquals(entryLines[0], entryLines[0].includes("0.2.479") ? entryLines[0] : entryLines[0]);
  assert(entryLines[0].startsWith("- 0.2.479"), `first entry line is oldest, got: ${entryLines[0]}`);
  assert(entryLines[entryLines.length - 1].startsWith("- 0.2.484"), `last entry line is newest, got: ${entryLines[entryLines.length - 1]}`);
  // Pin the exact ascending order (slice(2,9) extracts "0.2.479" from "- 0.2.479").
  assertEquals(entryLines.map((l) => l.slice(2, 9)), ["0.2.479", "0.2.480", "0.2.483", "0.2.484"]);
});

Deno.test("renderDelta: bounded keeps the NEWEST entries, note FIRST then oldest→newest (exact full-string rendering)", () => {
  const parsed = parseChangelog(SAMPLE);
  const delta = deltaBetween(parsed, null, "0.2.484");
  // EXACT final rendering for the bounded case: note first, then the newest
  // `limit` entries oldest→newest, each entry its head + indented bullets.
  assertEquals(
    renderDelta(delta, 2),
    "… 2 older entries — see CHANGELOG.md\n" +
      "- 0.2.483 — 2026-08-30\n" +
      "    Two smaller follow-up issues found during the parallel work are now written down as tasks.\n" +
      "- 0.2.484 — 2026-08-30\n" +
      "    Five more fixes are in progress in parallel and recorded as claimed in the tracker.",
  );
  // EXACT final rendering for the full case: no note, all four ascending.
  assertEquals(
    renderDelta(delta),
    "- 0.2.479 — 2026-08-30\n" +
      "    Tracker: the thread run-state view is recorded as landed.\n" +
      "- 0.2.480 — 2026-08-30\n" +
      "    Housekeeping: two parallel work streams reconciled.\n" +
      "- 0.2.483 — 2026-08-30\n" +
      "    Two smaller follow-up issues found during the parallel work are now written down as tasks.\n" +
      "- 0.2.484 — 2026-08-30\n" +
      "    Five more fixes are in progress in parallel and recorded as claimed in the tracker.",
  );
});

Deno.test("shouldRecordBuild: STRICT — finite exit code 0 + buildSucceeded true only", () => {
  // Genuine success.
  assertEquals(shouldRecordBuild({ buildSucceeded: true, exitCode: 0 }), true);
  // Late fatal: build died in staging cleanup / lock release → exitCode 1.
  assertEquals(shouldRecordBuild({ buildSucceeded: true, exitCode: 1 }), false);
  // Nonnumeric / missing / NaN exit codes NEVER authorize (r2 P1).
  assertEquals(shouldRecordBuild({ buildSucceeded: true, exitCode: "1" }), false);
  assertEquals(shouldRecordBuild({ buildSucceeded: true, exitCode: "0" }), false);
  assertEquals(shouldRecordBuild({ buildSucceeded: true, exitCode: "abc" }), false);
  assertEquals(shouldRecordBuild({ buildSucceeded: true, exitCode: NaN }), false);
  assertEquals(shouldRecordBuild({ buildSucceeded: true, exitCode: undefined }), false);
  assertEquals(shouldRecordBuild({ buildSucceeded: true }), false);
  assertEquals(shouldRecordBuild({ buildSucceeded: true, exitCode: 2 }), false);
  assertEquals(shouldRecordBuild({ buildSucceeded: true, exitCode: -0 }), true);
  // Build never succeeded → no record regardless of exit code.
  assertEquals(shouldRecordBuild({ buildSucceeded: false, exitCode: 0 }), false);
  assertEquals(shouldRecordBuild({}), false);
});

Deno.test("deltaBetween/renderDelta: malformed null entries and junk bullets never throw", () => {
  const parsed = parseChangelog(SAMPLE);
  parsed.push(null, { bad: true }, undefined); // adversarial null/malformed entries
  const delta = deltaBetween(parsed, null, "0.2.484");
  assertEquals(delta.length, 4); // nulls skipped silently
  const rendered = renderDelta(delta);
  assert(rendered.includes("0.2.484"));
  assertEquals(renderDelta([null, null]), "");
  // Junk bullets: non-array bullets, non-string bullets, missing title/version
  // must NEVER throw (r2 P1) — skipped or rendered defensively.
  const junk = [
    { version: "0.2.500", title: "ok", bullets: "not-an-array" }, // bullets not an array
    { version: "0.2.501", title: "ok", bullets: [42, null, "real bullet"] }, // non-string bullets
    { version: "0.2.502", bullets: [] }, // missing title
    { title: "no version" }, // missing version
    { version: "0.2.503", title: "ok" }, // missing bullets entirely
  ];
  const junkRendered = renderDelta(junk, 10);
  assert(junkRendered.includes("0.2.503"), "entry with no bullets key renders");
  assert(junkRendered.includes("real bullet"), "string bullets survive, junk filtered");
  // No-throw smoke for degenerate single entries.
  assertEquals(renderDelta([{ version: "0.2.999" }]), "- 0.2.999 —");
  assertEquals(renderDelta([{ bullets: [1, 2] }]), ""); // no version/title → empty head skipped by filter
});

Deno.test("renderDelta: invalid string versions are SKIPPED, never rendered (r3 blocker 2)", () => {
  // Invalid string versions must be dropped exactly like deltaBetween drops
  // them — they must never appear in the rendered output.
  const junkVersions = [
    { version: "abc", title: "bad", bullets: [] },
    { version: "not-a-version", title: "bad", bullets: [] },
    { version: "1.2", title: "too short", bullets: [] },
    { version: "v1.2.3", title: "prefixed", bullets: [] },
    { version: "", title: "empty", bullets: [] },
  ];
  const rendered = renderDelta(junkVersions, 10);
  assertEquals(rendered, ""); // ALL junk dropped → nothing to render
  // Mixed valid + junk: only the valid entry renders.
  const mixed = [
    { version: "abc", title: "bad" },
    { version: "0.2.500", title: "good", bullets: ["real"] },
    { version: "1.2", title: "short" },
  ];
  assertEquals(
    renderDelta(mixed, 10),
    "- 0.2.500 — good\n    real",
  );
});

Deno.test("parseChangelog: null lines and non-string fragments never throw", () => {
  assertEquals(parseChangelog(null), []);
  assertEquals(parseChangelog(undefined), []);
  assertEquals(parseChangelog(""), []);
  assertEquals(parseChangelog("# no headers here\n- loose bullet"), []);
  // A changelog body whose raw lines are null-ish still parses without throwing.
  const weird = "## [1.2.3] — t\n- bullet\n\x00\n## [1.2.2] — u";
  const parsed = parseChangelog(weird);
  assertEquals(parsed.length, 2);
  assertEquals(parsed[0].version, "1.2.3");
  assertEquals(parsed[1].version, "1.2.2");
});

Deno.test("readChangelogOrNull: read failure warns one line and returns null (r2 P2)", async () => {
  const warned = [];
  const warn = (msg) => warned.push(msg);
  // Failure path: injected read throws → warn + null.
  const boom = new Error("ENOENT");
  const result = await readChangelogOrNull({ read: async () => { throw boom; }, warn });
  assertEquals(result, null);
  assertEquals(warned.length, 1);
  assert(warned[0].includes("could not read CHANGELOG.md"), `warning mentions the file: ${warned[0]}`);
  assert(warned[0].includes("ENOENT"), `warning includes the error: ${warned[0]}`);
  // Success path: no warning, content returned.
  const ok = await readChangelogOrNull({ read: async () => "# Changelog\n", warn });
  assertEquals(ok, "# Changelog\n");
  assertEquals(warned.length, 1); // no additional warning on success
});

Deno.test("deltaBetween: entry == previous excluded, entry == current included", () => {
  const parsed = parseChangelog(SAMPLE);
  // previous = 0.2.483 → only 0.2.484 is new (newest first in file order).
  const delta = deltaBetween(parsed, "0.2.483", "0.2.484");
  assertEquals(delta.length, 1);
  assertEquals(delta[0].version, "0.2.484");
  // previous = 0.2.480 → 0.2.484 + 0.2.483 (0.2.480 excluded).
  const delta2 = deltaBetween(parsed, "0.2.480", "0.2.484");
  assertEquals(delta2.map((e) => e.version), ["0.2.484", "0.2.483"]);
  // No previous → everything up to current is new.
  const delta3 = deltaBetween(parsed, null, "0.2.484");
  assertEquals(delta3.length, 4);
});

Deno.test("deltaBetween: no-change and future entries", () => {
  const parsed = parseChangelog(SAMPLE);
  assertEquals(deltaBetween(parsed, "0.2.484", "0.2.484").length, 0);
  // An entry NEWER than current is never included.
  const delta = deltaBetween(parsed, null, "0.2.483");
  assertEquals(delta.map((e) => e.version), ["0.2.483", "0.2.480", "0.2.479"]);
});

Deno.test("deltaBetween: missing versions are skipped, garbage previous ignored", () => {
  const parsed = parseChangelog(SAMPLE);
  // previous "0.2.900" (newer than all entries) → nothing is <= previous.
  assertEquals(deltaBetween(parsed, "0.2.900", "0.2.484").length, 0);
  // Garbage previous behaves like no previous.
  assertEquals(deltaBetween(parsed, "not-a-version", "0.2.484").length, 4);
});

Deno.test("renderDelta: bounded + newest last (regression guard)", () => {
  const parsed = parseChangelog(SAMPLE);
  const delta = deltaBetween(parsed, null, "0.2.484");
  const rendered = renderDelta(delta, 2);
  const lines = rendered.split("\n");
  // Newest-last: the final full entry line is the NEWEST of the shown two.
  assert(lines.some((l) => l.startsWith("- 0.2.484 ")));
  assert(lines.some((l) => l.includes("2 older entr"))); // 4 - 2 bounded, older cut
  // No bounding needed when everything fits.
  const renderedFull = renderDelta(delta);
  assert(!renderedFull.includes("older entr"));
});

Deno.test("readLastBuiltVersion: absent/unreadable → null, valid → value", async () => {
  const dir = await Deno.makeTempDir();
  const p = `${dir}/last-built-version`;
  assertEquals(await readLastBuiltVersion(p), null); // absent
  assertEquals(await readLastBuiltVersion(`${dir}/missing/nested`), null);
  await writeLastBuiltVersion(p, "0.2.484");
  assertEquals(await readLastBuiltVersion(p), "0.2.484");
  await writeLastBuiltVersion(p, "garbage"); // invalid → no write
  assertEquals(await readLastBuiltVersion(p), "0.2.484"); // still old
});

Deno.test("isValidVersion", () => {
  assertEquals(isValidVersion("0.2.484"), true);
  assertEquals(isValidVersion("1.0.0"), true);
  assertEquals(isValidVersion("0.2"), false);
  assertEquals(isValidVersion("v0.2.484"), false);
  assertEquals(isValidVersion(null), false);
});
