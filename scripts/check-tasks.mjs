// scripts/check-tasks.mjs — schema gate for TASKS.md + TASKS-DONE.md.
//
// Why this exists: on 2026-08-25 a sweep found three entries violating the
// schema TASKS.md itself defines — two headings with NO body, and one heading
// carrying THREE complete field sets whose statuses disagreed (DONE, IN_REVIEW,
// DONE). Two parsers written that day returned different answers about whether
// that entry was open, and an archive split read only the first field set and
// filed IN_REVIEW work as completed. A tracker that different readers parse
// differently is not a tracker.
//
// Checks, per CAP-FB-20260825-TRACKER-INTEGRITY-01:
//   1. every heading carries exactly one of each required field
//   2. Status and Priority values are inside the declared sets
//   3. no CAP-FB id is duplicated or reused ACROSS both files
//
// Exit 1 on any violation. `--json` prints machine-readable findings.

import { readFile } from "node:fs/promises";

// Introducing a gate to an existing tracker: 32 violations predate it, spread
// across entries owned by live lanes. Mass-editing them would collide with work
// in flight, and an advisory-only lint gets ignored. So the gate is strict for
// anything NEW and carries the known set in a baseline that should shrink to
// empty. Delete a line from the baseline when you fix that entry.
const BASELINE_PATH = "scripts/check-tasks-baseline.json";

const FILES = ["TASKS.md", "TASKS-DONE.md"];

// The schema block in TASKS.md documents these.
const REQUIRED = [
  "Feedback", "Updated", "Status", "Priority", "Owner", "Workspace",
  "Branch", "Base", "Candidate", "Shipping", "Acceptance", "Review", "Gates",
  "Blockers", "Next", "Recover", "History",
];

// `Resume` records the state a BLOCKED entry may return to, so it is required
// only there. It was previously required on every entry and omitted on 23 of
// them — a rule the fleet had already voted against in practice. TASKS.md
// § Entry schema states this explicitly.

// MERGED is legacy (collapsed into DONE on 2026-08-28, see AGENTS.md) — still
// accepted so the archived entries in TASKS-DONE.md validate. New entries use DONE.
const STATUSES = new Set(["OPEN", "IN_REVIEW", "MERGED", "DONE", "BLOCKED", "ABANDONED"]);
const PRIORITIES = new Set(["P0", "P1", "P2", "P3"]);

// The literal template heading in the schema section is documentation, not an entry.
const TEMPLATE = /^CAP-FB-YYYYMMDD/;

const findings = [];
const seen = new Map(); // id -> file it was first defined in

for (const file of FILES) {
  let src;
  try {
    src = await readFile(file, "utf8");
  } catch {
    continue; // TASKS-DONE.md may legitimately not exist yet
  }

  // Split on entry headings. A heading owns everything up to the next heading,
  // which is exactly the property the FDSTAT defect violated.
  const parts = src.split(/^## \[(CAP-FB-[A-Z0-9-]+)\](.*)$/m);
  for (let i = 1; i < parts.length; i += 3) {
    const id = parts[i];
    const title = parts[i + 1].trim();
    const body = parts[i + 2];
    if (TEMPLATE.test(id)) continue;

    const where = `${file} [${id}]`;

    if (seen.has(id)) {
      findings.push(`${where}: id already defined in ${seen.get(id)} — ids are immutable and never reused`);
    } else {
      seen.set(id, file);
    }

    if (!title) findings.push(`${where}: heading has no title`);

    for (const field of REQUIRED) {
      const n = (body.match(new RegExp(`^- ${field}:`, "gm")) || []).length;
      if (n === 1) continue;
      findings.push(
        n === 0
          ? `${where}: missing required field \`${field}\``
          : `${where}: ${n} \`${field}\` fields — one heading must carry exactly one field set`,
      );
    }

    const status = (body.match(/^- Status:\s*(.*)$/m) || [])[1]?.trim();
    if (status && !STATUSES.has(status)) {
      findings.push(`${where}: Status \`${status}\` is not one of ${[...STATUSES].join(" | ")}`);
    }
    const priority = (body.match(/^- Priority:\s*(.*)$/m) || [])[1]?.trim();
    if (priority && !PRIORITIES.has(priority)) {
      findings.push(`${where}: Priority \`${priority}\` is not one of ${[...PRIORITIES].join(" | ")}`);
    }
    if (status === "BLOCKED") {
      const resume = (body.match(/^- Resume:\s*(.*)$/m) || [])[1]?.trim();
      if (!resume || resume === "—") {
        findings.push(`${where}: BLOCKED requires \`Resume\` to record the state it may return to`);
      }
    }
  }
}

let baseline = [];
if (!process.argv.includes("--no-baseline")) {
  try {
    baseline = JSON.parse(await readFile(BASELINE_PATH, "utf8")).known ?? [];
  } catch { /* no baseline yet — every finding is new */ }
}
const known = new Set(baseline);
const fresh = findings.filter((f) => !known.has(f));
const stillKnown = findings.filter((f) => known.has(f));
const fixed = baseline.filter((b) => !findings.includes(b));

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(
    { ok: fresh.length === 0, entries: seen.size, new: fresh, baselined: stillKnown.length, fixed },
    null, 2,
  ));
} else if (fresh.length) {
  console.error(`TASKS SCHEMA FAIL — ${fresh.length} new violation(s) across ${seen.size} entries:\n`);
  for (const f of fresh) console.error(`  ${f}`);
  console.error("\nSchema is defined in TASKS.md § Entry schema.");
  if (stillKnown.length) console.error(`(${stillKnown.length} pre-existing violations are baselined and not counted.)`);
} else {
  console.log(`tasks schema: ${seen.size} entries across ${FILES.join(" + ")}, no new violations ✓`);
  if (stillKnown.length) {
    console.log(`  ${stillKnown.length} baselined violation(s) remain — see ${BASELINE_PATH}; shrink it, never grow it.`);
  }
  if (fixed.length) {
    console.log(`  ${fixed.length} baselined violation(s) are now fixed — remove them from the baseline:`);
    for (const f of fixed) console.log(`    ${f}`);
  }
}

process.exit(fresh.length ? 1 : 0);
