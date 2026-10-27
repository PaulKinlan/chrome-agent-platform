// scripts/lib/serial-lane-child.mjs — runs ONE serial lane in its own process
// (chrome-agent-platform-1oouo).
//
// scripts/lib/serial-phase.mjs runs a lane's files with spawnSync one at a time and prints the
// verdict for each. To overlap two lanes the parent cannot use the same blocking loop for both, so
// it runs one lane here, in a child, and reads the lane's failure records back from a JSON file
// (stdout stays the lane's own live output, so the gate log reads exactly as before).
//
// Usage: <runtime> scripts/lib/serial-lane-child.mjs <result.json> <file...>
// The runtime is whatever runs the parent (NODE for `npm test`, deno for the inner loop), so this file
// uses node:fs and process.exit only — Deno.* here made the lane spawn throw under node.
import { writeFileSync } from "node:fs";
import { runSerialFiles } from "./serial-phase.mjs";

const [resultPath, ...files] = process.argv.slice(2);
if (!resultPath || files.length === 0) {
  console.error("serial-lane-child: usage: <result.json> <file...>");
  process.exit(2);
}

const failures = [];
let rc = 1;
try {
  rc = runSerialFiles(files, { failuresOut: failures });
} catch (error) {
  // A lane that cannot even start must still be attributable: the parent reads this file, so write what
  // happened before exiting rather than leaving an empty result and a bare exit code.
  failures.push({
    file: files[0] ?? "",
    code: 1,
    timedOut: false,
    isRefusal: false,
    secs: "0",
    log: null,
    thrown: String(error?.stack ?? error),
  });
  console.error(`serial-lane-child: lane threw: ${error?.stack ?? error}`);
  rc = 1;
}

// Test seam (chrome-agent-platform-5xg1w review, blocker 1): exit WITHOUT writing the result file, so
// the parent's "lane never reported" path is driven by a real child instead of only being described.
// Used by tests (tests/gate-outcome-child-run.test.ts), never by the gate.
if (process.env.CAP_SERIAL_LANE_SKIP_RESULT === "1") {
  process.exit(rc);
}

try {
  writeFileSync(resultPath, JSON.stringify({ rc, failures }));
} catch (error) {
  console.error(`serial-lane-child: could not write ${resultPath}: ${error?.message ?? error}`);
  process.exit(rc === 0 ? 1 : rc);
}
process.exit(rc);
