// scripts/lib/browser-refusal.ts — chrome-agent-platform-hlgr.
//
// A browser-dependent guard must refuse ENVIRONMENTALLY on a host with no resolvable browser: NAMED,
// COUNTED, and distinguishable from BOTH a pass and a product failure. The repo already has the third
// verdict (ENVIRONMENTAL_REFUSAL_EXIT / MARKER in ./quiet-window.ts, as ./heavy-gate-slot.ts uses);
// this module is that verdict for a missing browser, so the wording and the count exist in ONE place
// and can be driven deterministically by a test.
//
// The count matters as much as the name: a silent ignore reads as green, and a bare exit code is
// invisible to the human reading the log. Both the human-readable ENVIRONMENT: line and the
// machine-readable marker payload carry the reason AND the number of tests that went unverified.
import { ENVIRONMENTAL_REFUSAL_EXIT, ENVIRONMENTAL_REFUSAL_MARKER } from "./quiet-window.ts";

/**
 * Is a REPORTED binary a usable one — a real, executable FILE?
 *
 * chrome-agent-platform-s7wr: this is now the ONE definition of "usable", shared with the resolver in
 * ./chrome-launch.ts, so the resolution helper and the refusal module cannot drift on what a usable
 * browser path means. (The check exists here first because the refusal module had to compensate for a
 * resolver that accepted an override unchecked.)
 *
 * review P2 (delta): the existence check alone accepted a DIRECTORY (CAP_CHROMIUM=/tmp) and a
 * non-executable file (CAP_CHROMIUM=/etc/passwd) as resolved, so the refusal never fired and the
 * launch died EISDIR / EACCES — the same product-red-for-an-environment-difference this module
 * exists to prevent, one shape over. `statSync` FOLLOWS symlinks, so a dangling symlink is absent
 * (correct) and a symlink to a real executable is usable (also correct).
 */
export function isUsableBinary(path: string | null | undefined): path is string {
  if (!path) return false;
  try {
    // Deno.statSync, NOT node:fs's: in node:fs, `isFile` is a METHOD, so `!st.isFile` is false for a
    // directory too (a function is truthy) and the check silently passes — I shipped exactly that and
    // a drill with CAP_CHROMIUM=/tmp caught it. Deno's FileInfo exposes `isFile` as a BOOLEAN.
    const st = Deno.statSync(path);
    if (!st.isFile) return false;
    // A path that cannot be executed is as absent as a missing one. (There is no execute bit to
    // check on Windows; spawnability there is decided by the extension, not by mode.)
    return Deno.build.os === "windows" || ((st.mode ?? 0) & 0o111) !== 0;
  } catch {
    return false;
  }
}

export interface BrowserResolution {
  binary: string | null;
  tried: string[];
}

/** The refusal for a missing browser, or null when one resolved (so it cannot refuse spuriously). */
export function browserRefusal(
  report: BrowserResolution,
  browserDependentTests: string[],
): { line: string; marker: string; payload: Record<string, unknown>; exit: number } | null {
  // review P1: resolveChromiumBinaryReport trusts a CAP_CHROMIUM override without checking that the
  // path EXISTS (scripts/lib/chrome-launch.ts — j5yz-owned, so this is defended here rather than edited
  // there). A missing override would otherwise pass as resolved, the refusal would not fire, and the
  // launch would die with ENOENT: a product red for an environment difference, which is the exact
  // failure this bead removes.
  const binary = isUsableBinary(report.binary) ? report.binary : null;
  if (binary) return null;
  const refused = browserDependentTests.length;
  return {
    line:
      `ENVIRONMENT: no resolvable browser — refusing ${refused} browser-dependent test(s): ` +
      `${browserDependentTests.map((t) => `"${t}"`).join(", ")}. ` +
      `Tried: ${report.tried.join(", ") || "<nothing to try>"}` +
      `${report.binary && !binary ? ` (the reported path does not exist: ${report.binary})` : ""}. ` +
      `Set CAP_CHROMIUM or install a browser to run ${refused === 1 ? "it" : "them"}; ` +
      `this is an environment difference, not a product failure. ` +
      `(environmental verdict, exit ${ENVIRONMENTAL_REFUSAL_EXIT})`,
    marker: ENVIRONMENTAL_REFUSAL_MARKER,
    payload: {
      reason: "no-resolvable-browser",
      refused,
      tests: browserDependentTests,
      tried: report.tried,
    },
    exit: ENVIRONMENTAL_REFUSAL_EXIT,
  };
}

/**
 * Print the refusal and end the run with the environmental verdict. Called by a guard when its browser
 * is missing; never returns on that path. On the happy path it returns so the guard continues.
 */
export function refuseWithoutBrowser(report: BrowserResolution, browserDependentTests: string[]): void {
  const refusal = browserRefusal(report, browserDependentTests);
  if (!refusal) return;
  console.log(refusal.line);
  console.log(refusal.marker, JSON.stringify(refusal.payload));
  Deno.exit(refusal.exit);
}
