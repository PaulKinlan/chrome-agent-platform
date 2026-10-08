// scripts/lib/serial-lane.mjs — run ONE serial lane (files in order, each in its own process, with the
// per-file windows and failure attribution of runSerialFiles) as a child of scripts/run-tests.mjs,
// so the timing lane can run beside the artifact lane (gate-speed; see SERIAL_TIMING_LANE in
// scripts/test-partition.mjs). Usage: node scripts/lib/serial-lane.mjs [--no-check] <file>...
import { runSerialFiles } from "./serial-phase.mjs";

const args = process.argv.slice(2);
const noCheck = args.includes("--no-check");
const files = args.filter((a) => !a.startsWith("--"));
process.exit(files.length ? runSerialFiles(files, { noCheck }) : 0);
