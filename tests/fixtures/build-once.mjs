// tests/fixtures/build-once.mjs — chrome-agent-platform-kj9s (condition 4).
//
// ONE real production build's OUTPUT, reusable by later serial files that need a real build's
// stdout and artifact, WITHOUT each of them paying for another build.
//
// WHY A REUSED STDOUT IS NOT A REUSED VERDICT: a record is keyed by the built tree's OWN source
// authority — the dist.complete marker's commit, its sha256 over EVERY indexed source file,
// and sha256 of the marker's own bytes (including generated output hashes). A record is trusted
// only when (a) the live dist.complete validates against the current tree (the same 2-4 s check
// `npm run note:dist` performs) and (b) its key equals that live marker's key. So a new build of
// the same indexed source but with different generated bundles also gets a different record.
// Any change the repo's OWN staleness contract would catch — a new
// commit, or any edit to an INDEXED source including the build and the scrub logic — produces a
// different key, and a record can never stand in for a tree it did not build. SCOPE OF THE CLAIM,
// stated rather than implied: this is exactly the authority dist.complete defines and no more. That
// authority lists INDEXED files (git ls-files) but reads their LIVE contents, so an UNSTAGED edit to
// a tracked file DOES change the digest and invalidates a record (the tamper gate in
// tests/build-debug-mode.test.ts proves exactly that); what it cannot see is an UNTRACKED file, which
// is the same blind spot the repo's own pre-test staleness check has — a consumer that needs more
// must not rely on this.
//
// A FAILED build is never recorded: its output is evidence for the run that produced it, and
// caching a failure could hide it later.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { validateDistCompleteMarker } from "../../scripts/dist-complete.mjs";
import { buildOnceKeyFromMarkerText } from "../../scripts/lib/build-once-key.mjs";
import { durableRoot } from "../../scripts/lib/durable-root.mjs";
import { PRODUCTION_BUILD_TIMEOUT_MS } from "../../scripts/test-partition.mjs";

const RECORD_DIR_NAME = "serial-build-once";

export function readMarker(root) {
  try {
    const raw = readFileSync(join(root, "extension", "dist", "dist.complete"), "utf8");
    const key = buildOnceKeyFromMarkerText(raw);
    if (!key) return null;
    return { key };
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
  const key = marker?.key ?? null;
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
      if (live?.key === key) {
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

  // kj9s review Finding 1 (P1): the key/recordPath computed BEFORE the build describe the OLD tree —
  // or are null when dist.complete was absent. Writing the NEW build's stdout there either recorded
  // nothing (a cold tree was never memoized) or filed a new tree's output under an OLD tree's key (a
  // record that could later stand in for a tree it did not build). Key the record by the marker the
  // build JUST wrote, not by the one it replaced.
  if (code === 0) {
    const built = readMarker(root);
    const builtKey = built?.key ?? null;
    if (builtKey) {
      try {
        writeFileSync(join(recordDir(), `${builtKey}.json`), JSON.stringify({ code, stdout, at: new Date().toISOString() }));
      } catch {
        /* a record we cannot write is not fatal: the caller already has the output */
      }
    }
    return { code, stdout, source: "build", key: builtKey };
  }
  return { code, stdout, source: "build", key };
}
