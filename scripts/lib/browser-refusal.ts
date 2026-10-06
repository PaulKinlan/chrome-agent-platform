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

export interface BrowserResolution {
  binary: string | null;
  tried: string[];
}

/** The refusal for a missing browser, or null when one resolved (so it cannot refuse spuriously). */
export function browserRefusal(
  report: BrowserResolution,
  browserDependentTests: string[],
): { line: string; marker: string; payload: Record<string, unknown>; exit: number } | null {
  if (report.binary) return null;
  const refused = browserDependentTests.length;
  return {
    line:
      `ENVIRONMENT: no resolvable browser — refusing ${refused} browser-dependent test(s): ` +
      `${browserDependentTests.map((t) => `"${t}"`).join(", ")}. ` +
      `Tried: ${report.tried.join(", ") || "<nothing to try>"}. ` +
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
