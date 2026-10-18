// scripts/lib/serial-lane-child.mjs — runs ONE serial lane in its own process
// (chrome-agent-platform-1oouo).
//
// scripts/lib/serial-phase.mjs runs a lane's files with spawnSync one at a time and prints the
// verdict for each. To overlap two lanes the parent cannot use the same blocking loop for both, so
// it runs one lane here, in a child, and reads the lane's failure records back from a JSON file
// (stdout stays the lane's own live output, so the gate log reads exactly as before).
//
// Usage: deno run -A --config deno.runner.jsonc scripts/lib/serial-lane-child.mjs <result.json> <file...>
import { runSerialFiles } from "./serial-phase.mjs";

const [resultPath, ...files] = process.argv.slice(2);
if (!resultPath || files.length === 0) {
  console.error("serial-lane-child: usage: <result.json> <file...>");
  Deno.exit(2);
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

try {
  await Deno.writeTextFile(resultPath, JSON.stringify({ rc, failures }));
} catch (error) {
  console.error(`serial-lane-child: could not write ${resultPath}: ${error?.message ?? error}`);
  Deno.exit(rc === 0 ? 1 : rc);
}
Deno.exit(rc);
