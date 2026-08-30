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
  readLastBuiltVersion,
  renderDelta,
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

Deno.test("parseChangelog: malformed input does not throw and yields []", () => {
  assertEquals(parseChangelog(null), []);
  assertEquals(parseChangelog(""), []);
  assertEquals(parseChangelog("# no headers here\n- loose bullet"), []);
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

Deno.test("renderDelta: bounded + newest last", () => {
  const parsed = parseChangelog(SAMPLE);
  const delta = deltaBetween(parsed, null, "0.2.484");
  const rendered = renderDelta(delta, 2);
  const lines = rendered.split("\n");
  // Newest-last: the final full entry line is the OLDEST of the shown two.
  assert(lines.some((l) => l.startsWith("- 0.2.484 ")));
  assert(lines.some((l) => l.includes("2 more entr"))); // 4 - 2 bounded
  // No bounding needed when everything fits.
  const renderedFull = renderDelta(delta);
  assert(!renderedFull.includes("more entr"));
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
