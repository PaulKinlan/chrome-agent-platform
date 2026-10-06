// tests/fixtures/build-once.mjs — chrome-agent-platform-kj9s (condition 4).
//
// ONE real production build's OUTPUT, reusable by later serial files that need a real build's
// stdout and artifact, WITHOUT each of them paying for another build.
//
// WHY A REUSED STDOUT IS NOT A REUSED VERDICT: a record is keyed by the built tree's OWN source
// authority — the dist.complete marker's commit plus its sha256 over EVERY indexed source file
// (2183 files, which includes scripts/build.mjs and the scrub/denial logic, since the authority is
// a full Git-index inventory). A record is trusted only when (a) the live dist.complete validates
// against the current tree (the same 2-4 s check `npm run note:dist` performs) and (b) its key
// equals that live marker's key. So any change the repo's OWN staleness contract would catch — a new
// commit, or any edited-and-staged source including the build and the scrub logic — produces a
// different key, and a record can never stand in for a tree it did not build. SCOPE OF THE CLAIM,
// stated rather than implied: this is exactly the authority dist.complete defines and no more — an
// UNSTAGED working-tree edit is invisible to that authority, so it is invisible here too (the repo's
// existing staleness check has the same property; a consumer that needs more must not rely on it).
//
// A FAILED build is never recorded: its output is evidence for the run that produced it, and
// caching a failure could hide it later.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { validateDistCompleteMarker } from "../../scripts/dist-complete.mjs";
import { durableRoot } from "../../scripts/lib/durable-root.mjs";
import { PRODUCTION_BUILD_TIMEOUT_MS } from "../../scripts/test-partition.mjs";

const RECORD_DIR_NAME = "serial-build-once";

function readMarker(root) {
  try {
    const raw = readFileSync(join(root, "extension", "dist", "dist.complete"), "utf8");
    const marker = JSON.parse(raw);
    const commit = typeof marker?.commit === "string" ? marker.commit : "";
    const digest = typeof marker?.source?.digest === "string" ? marker.source.digest : "";
    if (!commit || !digest) return null;
    return { commit, digest, target: marker.target };
  } catch {
    return null;
  }
}

function recordDir() {
  const dir = join(durableRoot(), RECORD_DIR_NAME);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Run the production build at most ONCE per built tree, and let every later consumer reuse its
 * captured output.
 *
 * @param {{ root: string, timeoutMs?: number }} opts
 * @returns {Promise<{ code: number, stdout: string, source: "build" | "record", key: string|null }>}
 */
export async function storeBuildOnce({ root, timeoutMs = PRODUCTION_BUILD_TIMEOUT_MS } = {}) {
  const marker = readMarker(root);
  const key = marker ? `${marker.commit}-${marker.digest}` : null;
  const recordPath = key ? join(recordDir(), `${key}.json`) : null;

  if (recordPath && existsSync(recordPath)) {
    try {
      // Trust the record only if the tree it describes is the tree standing here NOW.
      await validateDistCompleteMarker({
        root,
        distRoot: join(root, "extension", "dist"),
        expectedTarget: "store",
      });
      const live = readMarker(root);
      if (live && `${live.commit}-${live.digest}` === key) {
        const record = JSON.parse(readFileSync(recordPath, "utf8"));
        if (record?.code === 0 && typeof record?.stdout === "string") {
          return { code: 0, stdout: record.stdout, source: "record", key };
        }
      }
    } catch {
      /* stale or invalid marker — fall through to a real build */
    }
  }

  let code = 1;
  let stdout = "";
  try {
    stdout = execFileSync("node", ["build.mjs", "--target=store"], {
      cwd: root,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
    code = 0;
  } catch (e) {
    code = typeof e?.status === "number" ? e.status : 1;
    stdout = `${e?.stdout ?? ""}${e?.stderr ?? ""}`;
  }

  if (code === 0 && recordPath) {
    try {
      writeFileSync(recordPath, JSON.stringify({ code, stdout, at: new Date().toISOString() }));
    } catch {
      /* a record we cannot write is not fatal: the caller already has the output */
    }
  }
  return { code, stdout, source: "build", key };
}
