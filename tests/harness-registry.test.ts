// CAP-FB-20260830-SUITE-HONESTY-01 — no harness runs nowhere.
//
// Before this gate, 68 of 85 `scripts/*.ts` were orphaned: not in any npm
// script, not in `test:all`, not run by anything — so a green suite said much
// less than it looked. The registry in scripts/lib/harness-registry.ts gives
// every harness exactly one class, and this test makes the classification
// mechanical:
//
//   gate    — an npm script that `test:all` runs.
//   named   — an npm script run on demand (the entry says why it is not a gate).
//   kat     — run by scripts/kat-runner.ts (`npm run test:kat`).
//   retired — kept for evidence/repro, explicitly NOT a gate, with a reason.
//   helper  — a server/tool other harnesses use; not a harness.
//
// A new harness with no entry fails here; a deleted harness with a stale entry
// fails here; a `gate` that is not actually in `test:all` fails here.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { HARNESSES, harnessFiles, katFiles, readKatVerdicts, RETIRED_KATS, staleExpectedReds } from "../scripts/lib/harness-registry.ts";

const ROOT = new URL("../", import.meta.url).pathname;
const pkg = JSON.parse(Deno.readTextFileSync(`${ROOT}package.json`));
const scripts: Record<string, string> = pkg.scripts ?? {};

Deno.test("every scripts/*.ts harness has exactly one registry entry", () => {
  const onDisk = harnessFiles().sort();
  const registered = Object.keys(HARNESSES).sort();
  const missing = onDisk.filter((f) => !registered.includes(f));
  const stale = registered.filter((f) => !onDisk.includes(f));
  assertEquals(missing, [], `harnesses on disk with no registry entry (wire it, retire it, or class it a helper):\n${missing.join("\n")}`);
  assertEquals(stale, [], `registry entries whose file no longer exists:\n${stale.join("\n")}`);
});

Deno.test("gate and named harnesses are real npm scripts pointing at their file", () => {
  const bad: string[] = [];
  for (const [file, entry] of Object.entries(HARNESSES)) {
    if (entry.class !== "gate" && entry.class !== "named") continue;
    const cmd = scripts[entry.npm ?? ""];
    const target = entry.via ?? `scripts/${file}`;
    if (!cmd || !cmd.includes(target)) bad.push(`${file} → npm run ${entry.npm} = ${cmd ?? "(missing)"} (expected ${target})`);
    if (entry.via && !Deno.statSync(`${ROOT}${entry.via}`).isFile) bad.push(`${file}: via ${entry.via} is not a file`);
  }
  assertEquals(bad, [], `registry npm scripts that do not run their file:\n${bad.join("\n")}`);
});

Deno.test("every gate is part of test:all, and test:all runs nothing unregistered", () => {
  const all = scripts["test:all"] ?? "";
  const steps = all.split("&&").map((s) => s.trim()).filter(Boolean);
  const runs = steps.filter((s) => s.startsWith("npm run ")).map((s) => s.slice("npm run ".length).trim());
  const gates = Object.entries(HARNESSES).filter(([, e]) => e.class === "gate").map(([, e]) => e.npm!);
  const notInAll = gates.filter((n) => !runs.includes(n));
  assertEquals(notInAll, [], `registry gates missing from test:all: ${notInAll.join(", ")}`);
  // Every harness-running npm script that test:all invokes must be a gate.
  const harnessNpm = new Map(Object.entries(HARNESSES).filter(([, e]) => e.npm).map(([f, e]) => [e.npm!, f]));
  const undeclared = runs.filter((n) => harnessNpm.has(n) && HARNESSES[harnessNpm.get(n)!].class !== "gate");
  assertEquals(undeclared, [], `test:all runs harnesses the registry does not class as gates: ${undeclared.join(", ")}`);
});

Deno.test("every kat-*.ts is either run by the KAT runner or explicitly set aside with a reason", () => {
  const kats = katFiles().sort();
  const bad: string[] = [];
  for (const f of kats) {
    const e = HARNESSES[f];
    if (!e) { bad.push(`${f}: no entry`); continue; }
    if (e.class === "kat") {
      if (e.expectedRed !== undefined && !e.expectedRed.trim()) bad.push(`${f}: empty expectedRed`);
      if (e.expectedRed && !(e.redReason ?? "").trim()) bad.push(`${f}: expectedRed without the failure mode (redReason)`);
      if (e.redReason && !e.expectedRed) bad.push(`${f}: redReason without an owner (expectedRed)`);
      continue;
    }
    if (e.class === "manual") {
      if (!RETIRED_KATS.has(f) || !(e.reason ?? "").trim()) bad.push(`${f}: set aside without a reason`);
      continue;
    }
    bad.push(`${f}: class ${e.class} (a KAT is either kat or manual)`);
  }
  assertEquals(bad, [], bad.join("\n"));
  const retiredNotKat = [...RETIRED_KATS].filter((f) => !kats.includes(f));
  assertEquals(retiredNotKat, [], `the set-aside list names files that are not KATs on disk: ${retiredNotKat.join(", ")}`);
});

Deno.test("manual and named entries carry a non-empty reason; expectedRed is kat-only; helpers are not harnesses", () => {
  const bad: string[] = [];
  for (const [file, e] of Object.entries(HARNESSES)) {
    if ((e.class === "manual" || e.class === "named") && !(e.reason ?? "").trim()) bad.push(`${file}: ${e.class} without a reason`);
    if (e.expectedRed && e.class !== "kat") bad.push(`${file}: expectedRed on a ${e.class} entry (only the KAT runner honours it)`);
    if (e.class === "helper" && /Deno\.exit\(/.test(Deno.readTextFileSync(`${ROOT}scripts/${file}`)) && !(e.reason ?? "").trim()) {
      bad.push(`${file}: helper with an exit path needs a reason it is not a harness`);
    }
  }
  assertEquals(bad, [], bad.join("\n"));
  assert(Object.keys(HARNESSES).length > 0);
});

// CAP-FB-20260902-KAT-AGENT-DELEGATION-RED-01 — a green KAT is not listed
// expected-red. The runner fails the moment an owned red passes; this makes
// `deno test` fail too, from the verdict ledger the runner leaves behind
// (.cache/kat-verdicts.json). With no ledger on this machine the guard has
// nothing to judge and says so — the runner remains the always-on check.
Deno.test("a KAT the runner last saw green is not still listed expected-red", () => {
  const verdicts = readKatVerdicts();
  const stale = staleExpectedReds(verdicts);
  assertEquals(stale, [], `KATs listed expected-red that the runner last saw GREEN — remove their expectedRed/redReason:\n${stale.join("\n")}`);
  if (Object.keys(verdicts).length === 0) console.log("  (no KAT verdict ledger on this machine yet — run npm run test:kat)");
});

Deno.test("staleExpectedReds: a green verdict for an expected-red KAT is stale; red verdicts and unlisted greens are not", () => {
  const at = "2026-09-02T00:00:00.000Z";
  const unlisted = Object.entries(HARNESSES).find(([f, e]) => isKatEntry(f, e) && !e.expectedRed)?.[0];
  assert(unlisted, "the registry has at least one KAT with no expectedRed");
  assertEquals(staleExpectedReds({}), [], "an empty ledger is never stale");
  assertEquals(staleExpectedReds({ [unlisted]: { exit: 0, at, ms: 1, expectedRed: null } }), [], "a green KAT that is not listed expected-red is fine");
  const listed = Object.entries(HARNESSES).find(([f, e]) => isKatEntry(f, e) && e.expectedRed)?.[0];
  // The owned-red list is meant to drain to empty; when it does, the three
  // listing-dependent cases below have nothing to exercise and the guard above
  // (plus the ledger-driven test) is the whole contract.
  if (!listed) return;
  assertEquals(staleExpectedReds({ [listed]: { exit: 1, at, ms: 1, expectedRed: "x" } }), [], "a red verdict for an owned red is expected, not stale");
  assertEquals(staleExpectedReds({ [listed]: { exit: 124, at, ms: 1, expectedRed: "x" } }), [], "a killed (hung) verdict is red, not stale");
  const stale = staleExpectedReds({ [listed]: { exit: 0, at, ms: 1, expectedRed: "x" } });
  assertEquals(stale.length, 1, "a green verdict for a KAT still listed expected-red IS stale");
  assert(stale[0].startsWith(`${listed}: green at ${at}`), stale[0]);
});

function isKatEntry(file: string, e: { class: string }) {
  return file.startsWith("kat-") && file !== "kat-runner.ts" && e.class === "kat";
}
