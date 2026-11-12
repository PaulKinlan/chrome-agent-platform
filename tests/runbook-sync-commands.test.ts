// tests/runbook-sync-commands.test.ts — chrome-agent-platform-28hwd + qnci3, filed as the
// runbook leg of 4iyck.
//
// WHY THIS FILE EXISTS. The two project-owned runbooks are the instruction set the two most
// frequent pushers (implementer lanes and the merger) actually follow, and until now NOTHING
// read them: a markdown runbook is "passive content" to the changed-file selector, so a doc
// claim could rot with every gate green. Two live examples (both verified on main before this
// test was written):
//   * 28hwd — AGENTS.md states "Every project-owned sync entry point routes through the
//     wrapper" and "a lane that runs `bd dolt push` directly steps outside the project-side
//     bound", while docs/MERGER-PLAYBOOK.md's landing recipe (step 10) and
//     .agents/skills/beads-flow/SKILL.md's Ship section BOTH prescribed the raw command. The
//     merger in particular was told to make the unbounded network push after every landing —
//     the exact shape of the 2026-10-31 25-minute lock hold (qhuf2).
//   * qnci3 — a failed `fleet-land-message` landed its own error string as the SUBJECT of
//     32b72e03f, a shape the unreviewed-landing sweep cannot parse, and the correct hand-built
//     fallback (0d5fa240a) was pinned nowhere.
//
// WHAT IT POLICES, and why each leg is red-able:
//   1. A PRESCRIPTION of a raw `bd dolt push` — a line that reads as a command a lane would run
//      (line-initial, optionally a list marker or code span) — is a violation unless the same
//      command site names the bounded wrapper. Prose that merely MENTIONS the raw command to
//      explain why it is out of scope is not a prescription and stays legal, which is why the
//      rule keys on the line's SHAPE rather than on the token.
//   2. The wrapper the runbooks name must exist and must actually implement push — a renamed or
//      deleted wrapper rots the instruction loudly instead of silently leaving a dead command.
//   3. The fleet-land-message fallback rule (qnci3) must stay pinned: non-zero exit means the
//      helper's output is NEVER the message, the subject is rebuilt in the canonical
//      `Merge fleet/<branch> (<bead>): <title>` shape, and the helper failure goes in the body.
//
// FALSIFICATION (measured; see the bead comment): restore either runbook's raw `bd dolt push`
// line -> leg 1 reds naming the file and line; delete the fallback section from the playbook ->
// leg 3 reds; remove scripts/bd-sync-bound.sh -> leg 2 reds.

import { assert, assertEquals } from "jsr:@std/assert@1";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// e273: never derive a filesystem root from a URL pathname (percent-encoding) — decode it.
const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** The project-owned runbooks: the documents a lane or the merger reads as instructions. AGENTS.md
 *  is included because it is the file that makes the ROUTING CLAIM the other two must not
 *  contradict. Each entry is exact — a directory or glob would police unrelated documents. */
const RUNBOOKS = [
  "docs/MERGER-PLAYBOOK.md",
  ".agents/skills/beads-flow/SKILL.md",
  "AGENTS.md",
];

const WRAPPER = "scripts/bd-sync-bound.sh";
/** How far a prescription's justification may sit from the command itself: a fenced block's comment
 *  header, or the paragraph right around it. Wide enough for prose, narrow enough that a runbook
 *  cannot cite the wrapper once at the top and prescribe the raw command a screenful later. */
const NEARBY_LINES = 6;

/** A line that reads as a COMMAND a lane would run: line-initial, after an optional list marker,
 *  fence, or code span. `bd dolt push` mid-sentence is a mention, not a prescription. */
const RAW_PRESCRIPTION_RE = /^\s*(?:[-*+]\s+)?(?:`{1,2})?bd\s+dolt\s+push\b/;

function lines(src: string): string[] {
  return src.split("\n");
}

/** Every prescription of the raw push and whether the same command site names the wrapper. */
export function findRawPushPrescriptions(src: string): { line: number; text: string; wrapped: boolean }[] {
  const all = lines(src);
  const out: { line: number; text: string; wrapped: boolean }[] = [];
  all.forEach((text, i) => {
    if (!RAW_PRESCRIPTION_RE.test(text)) return;
    const from = Math.max(0, i - NEARBY_LINES);
    const to = Math.min(all.length, i + NEARBY_LINES + 1);
    const nearby = all.slice(from, to).join("\n");
    out.push({ line: i + 1, text: text.trim(), wrapped: nearby.includes(WRAPPER) });
  });
  return out;
}

Deno.test("28hwd: no project-owned runbook prescribes an unbounded raw `bd dolt push`", async () => {
  const offences: string[] = [];
  for (const rel of RUNBOOKS) {
    const src = await Deno.readTextFile(path.join(ROOT, rel)).catch(() => null);
    assert(src !== null, `the project-owned runbook ${rel} must exist (it is part of this guard's subject set)`);
    for (const found of findRawPushPrescriptions(src)) {
      if (found.wrapped) continue;
      offences.push(
        `${rel}:${found.line} prescribes \`${found.text}\` with no reference to ${WRAPPER} within ` +
          `${NEARBY_LINES} lines — an unbounded push holds the fleet bd-sync lock and the dolt DB ` +
          `until it finishes (measured 25+ min, chrome-agent-platform-qhuf2)`,
      );
    }
  }
  assertEquals(
    offences,
    [],
    `raw bounded-sync prescriptions found (route them through ${WRAPPER} push):\n${offences.join("\n")}`,
  );
});

Deno.test("28hwd: the bounded wrapper the runbooks name exists and implements push", async () => {
  const wrapper = await Deno.readTextFile(path.join(ROOT, WRAPPER)).catch(() => null);
  assert(wrapper !== null, `${WRAPPER} must exist — the runbooks route every manual sync through it`);
  // The wrapper dispatches on its first argument; a `push` arm with nothing behind it would
  // satisfy a naming check while doing nothing. Assert the ARM exists AND that the script
  // actually reaches the beads sync (its usage line names `bd dolt push`).
  assert(/^\s*push\|pull\)/m.test(wrapper), `${WRAPPER} must dispatch a push arm on its first argument`);
  assert(
    /bd\s+dolt\s+push/.test(wrapper),
    `${WRAPPER} must run the beads sync — a push arm that never reaches \`bd dolt push\` is a stub`,
  );
});

Deno.test("qnci3: the merge playbook pins what to do when fleet-land-message fails", async () => {
  const playbook = await Deno.readTextFile(path.join(ROOT, "docs/MERGER-PLAYBOOK.md"));
  const ruleAt = playbook.search(/fleet-land-message`? exits NON-ZERO/);
  assert(
    ruleAt > 0,
    "docs/MERGER-PLAYBOOK.md must pin the failed-helper rule (qnci3): a failed `fleet-land-message` " +
      "landed its error string as a commit SUBJECT, which the unreviewed-landing sweep cannot see",
  );
  // Bound the rule to its own section so a phrase elsewhere cannot satisfy it.
  const section = playbook.slice(ruleAt, playbook.indexOf("\n## ", ruleAt) === -1 ? undefined : playbook.indexOf("\n## ", ruleAt));
  assert(
    /never commit its output/i.test(section),
    "the rule must forbid committing the helper's output — that is the whole defect (32b72e03f)",
  );
  assert(
    /^\s*Merge fleet\/<branch> \(<bead-id>\): /m.test(section),
    "the rule must prescribe the canonical subject shape the landing parsers read: " +
      "`Merge fleet/<branch> (<bead-id>): <title>`",
  );
  // The property that actually failed on 32b72e03f: the helper's failure was the MESSAGE. The
  // rule has to keep the failure in the body, under a labelled line, where the landing parsers
  // and the bead reader can both find it and neither confuses it for a subject.
  assert(
    /^\s*Helper: .*exited /m.test(section),
    "the rule must show the helper failure as a labelled BODY line (`Helper: ... exited <n> ...`) — " +
      "the 0d5fa240a precedent; a failure recorded nowhere gets reinvented as the subject",
  );
});
