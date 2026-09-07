// scripts/lib/kat-bistro-caller.ts — the French Bistro KAT caller's decision
// logic, EXTRACTED VERBATIM from scripts/kat-webmcp-bistro.ts so committed
// tests execute the REAL caller units (the kat-finalizer.ts pattern; the
// 3yfs rule: never a simulated evaluator). chrome-agent-platform-cvlf.
//
// er6x pinned these guards by grepping the caller's source text, which can
// only prove the text exists — not that it executes, not that a predicate is
// the RIGHT predicate, not that ordering holds. Every unit here is exported
// and executed by tests/kat-bistro-caller.test.ts; the script itself is
// reduced to wiring.

import { createHash } from "node:crypto";
import { withTimeout } from "./chrome-launch.ts";
import { durableDir } from "./durable-root.mjs";
import { allocateRunEvidenceDir, finalizeKatExecution, sanitizeKatLogError } from "./kat-finalizer.ts";

// ── 1. Launch / discovery configuration ─────────────────────────────────────

/** The demo URL carries ?toolautosubmit so the tool step submits itself. */
export const URL_BISTRO = "https://googlechromelabs.github.io/webmcp-tools/demos/french-bistro/?toolautosubmit";

/** The WebMCP feature flag the browser MUST launch with — dropping it makes
 * every later check fail for the wrong reason. */
export const WEBMCP_LAUNCH_ARGS = ["--enable-features=WebMCP"];

/** The readiness expression the caller waits for: the page must be COMPLETE
 * and expose a REAL modelContext with getTools — not merely any loaded page. */
export const BISTRO_READY_EXPRESSION = `document.readyState === "complete" && typeof document.modelContext?.getTools === "function"`;

/** The chromium binary, parameterized (was hardcoded in the caller): the
 * current value is the default, and a fake-browser harness can redirect it. */
export const BISTRO_DEFAULT_BINARY = "/usr/bin/chromium";

export function buildBistroLaunchConfig({
  extensionDir,
  profileDir,
  binary = BISTRO_DEFAULT_BINARY,
  timeoutMs = 30_000,
}: {
  extensionDir: string;
  profileDir: string;
  binary?: string;
  timeoutMs?: number;
}) {
  return {
    binary,
    extension: extensionDir,
    profile: profileDir,
    timeoutMs,
    args: [...WEBMCP_LAUNCH_ARGS],
  };
}

/** The per-invocation browser profile: durable, never /tmp (a tmpfs profile
 * changes the storage semantics the run claims to exercise). */
export function bistroProfileDir(now = Date.now(), durable = durableDir) {
  return durable(`kat-webmcp-bistro-profile-${now}`);
}

/** The run-bound evidence child: EVERY invocation owns a fresh, exclusively
 * created directory under the parent (z6w receipt authority). */
export async function runBistroEvidenceDir({ parent, allocate = allocateRunEvidenceDir as (parent: string) => Promise<string> }: {
  parent: string;
  allocate?: (parent: string) => Promise<string>;
}) {
  return allocate(parent);
}

// ── 2. Run-error capture (ll7q) ─────────────────────────────────────────────

/** The bounded run-error for the RECEIPT: the stack carries run paths, so the
 * receipt keeps the bounded message and the CONSOLE gets only the sanitized
 * class (announceRunError). A crash must NEVER capture as null. */
export function captureRunError(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

/** The console line: the sanitizer's class, never raw paths. */
export function announceRunError(err: unknown, { consoleError = (...a: unknown[]) => console.error(...a) } = {}) {
  consoleError("KAT Execution Error:", sanitizeKatLogError(err));
}

// ── 3. The check predicates (pure functions of observed values) ─────────────

/** 1. FALSIFICATION: Object args must FAIL the native WebMCP JSONReader with
 * the parse error — not with any error, and not by succeeding. */
export function bistroFalsificationHolds(objRes: unknown): boolean {
  return (objRes as any)?.ok === false && /Failed to parse input string as JSON/i.test((objRes as any)?.error ?? "");
}

/** 2. SUCCESS: JSON-string args settle ok AND the response text is the demo's
 * real confirmation copy — an ok with the wrong body is not a pass. */
export function bistroJsonStringSuccessHolds(strRes: unknown): boolean {
  return (strRes as any)?.ok === true && typeof (strRes as any)?.res === "string" &&
    (strRes as any).res.includes("We look forward to welcoming you");
}

/** 3. DOM & DIALOG: the page visibly reflects EVERY exact booking field and
 * opens its result dialog — a dialog alone proves nothing. */
export function bistroDomBookingHolds(visible: unknown, validBooking: {
  name: string; phone: string; date: string; time: string; guests: string; seating: string;
}): boolean {
  return (visible as any)?.dialogOpen === true &&
    (visible as any)?.name === validBooking.name &&
    (visible as any)?.phone === validBooking.phone &&
    (visible as any)?.date === validBooking.date &&
    (visible as any)?.time === validBooking.time &&
    (visible as any)?.guests === validBooking.guests &&
    (visible as any)?.seating === validBooking.seating &&
    (visible as any)?.modalText.includes("We look forward to welcoming you");
}

/** 4. SCREENSHOT: real bytes were captured — a vacuous true would pass an
 * undefined capture. */
export function screenshotCapturedHolds(shot: unknown): boolean {
  return !!(shot as any)?.length;
}

/** The service-worker registration check: the URL must be an EXTENSION URL —
 * a truthy worker with a foreign URL is not our extension. */
export function serviceWorkerRegisteredHolds(worker: unknown): boolean {
  return !!(worker as any)?.url?.startsWith("chrome-extension://");
}

// ── 4. Report assembly (pure) ────────────────────────────────────────────────

/** The receipt report: `expected` is THIS run's head (a stale/foreign expected
 * would green-light a diff), every field passes through untouched. */
export function assembleBistroReport({
  head,
  tree,
  dirty,
  mainWorldSha256,
  url,
  browserVersion,
  lockWaitMs,
  outDir,
}: {
  head: string; tree: string; dirty: boolean; mainWorldSha256: string;
  url: string; browserVersion: unknown; lockWaitMs: number | null; outDir: string;
}) {
  return {
    expected: head,
    head,
    tree,
    dirty,
    mainWorldSha256,
    url,
    browserVersion,
    lockWaitMs,
    outDir,
  };
}

/** The teardown bundle the finalizer needs to clean the REAL browser, the
 * REAL CDP connection and the REAL profile — a null field orphans it. */
export function assembleBistroTeardown({ cdp, chrome, profilePath, withTimeout: wt }: {
  cdp: unknown; chrome: unknown; profilePath: string; withTimeout: unknown;
}) {
  return { cdp, chrome, profilePath, withTimeout: wt };
}

/** The main-world script digest: the SHA-256 of the bytes actually shipped —
 * a constant would let a silently swapped content script green the report. */
export function mainWorldSha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The run's report: the outDir is THIS invocation's evidence CHILD (the
 * fresh run-bound directory), never the parent. */
export function bistroRunReport({ evidence, head, tree, dirty, mainWorldSha256, url, browserVersion, lockWaitMs }: {
  evidence: string; head: string; tree: string; dirty: boolean; mainWorldSha256: string;
  url: string; browserVersion: unknown; lockWaitMs: number | null;
}) {
  return assembleBistroReport({ head, tree, dirty, mainWorldSha256, url, browserVersion, lockWaitMs, outDir: evidence });
}

/** The dirty-tree bit straight from `git status --porcelain` output. */
export function hasGitChanges(statusOutput: string): boolean {
  return statusOutput.length > 0;
}

/** The captured screenshot is PERSISTED into the run's evidence dir — a
 * discarded capture would make the visual check unauditable. */
export async function persistBistroScreenshot({ shot, outDir, write = (p: string, b: Uint8Array) => Deno.writeFile(p, b) }: {
  shot: Uint8Array | null | undefined;
  outDir: string;
  write?: (path: string, bytes: Uint8Array) => Promise<void>;
}) {
  if (shot) {
    await write(`${outDir}/bistro-json-string-success.png`, shot);
  }
}

// ── 5. The finally block ─────────────────────────────────────────────────────

/** GUARANTEED TEARDOWN + decision + receipt announcement + fail-closed exit —
 * ONE call into the production finalizer, then the announcement ONLY when a
 * receipt exists, then the failure-derived exit. Seams injectable so the
 * committed tests execute THIS code without exiting the test process. */
export async function settleBistroRun({
  runError,
  checks,
  teardown,
  report,
  finalize = finalizeKatExecution,
  log = (...a: unknown[]) => console.log(...a),
  exit = (code: number) => Deno.exit(code),
}: {
  runError: string | null;
  checks: Array<{ name: string; passed: boolean; detail?: unknown }>;
  teardown: unknown;
  report: Record<string, unknown>;
  finalize?: typeof finalizeKatExecution;
  log?: (...a: unknown[]) => void;
  exit?: (code: number) => void;
}) {
  const outcome = await finalize({ runError, checks, teardown, report } as Parameters<typeof finalizeKatExecution>[0]);
  // The harness's REAL receipt announcement: the EXACT path the finalizer
  // returned — never a reconstructed path, never announced without one.
  if (outcome.receiptPath) log(`KAT receipt: ${outcome.receiptPath}`);
  // The failure-derived exit: the code comes from the finalizer's decision
  // (0 on GREEN, 1 on RED) — never a constant.
  exit(outcome.exitCode);
  return outcome;
}

/** The bounded success probe: the JSON-string execution eval MUST be bounded
 * (a wedged page evaluation otherwise hangs the whole KAT). The withTimeout
 * seam is injectable for tests; the default is the production one. */
export async function bistroJsonStringProbe(
  cdp: { eval(sessionId: string, expression: string): Promise<unknown> },
  sessionId: string,
  payload: string,
  { timeoutMs = 30_000, withTimeout: wt = withTimeout }: {
    timeoutMs?: number;
    withTimeout?: <T>(op: Promise<T>, ms: number) => Promise<T>;
  } = {},
) {
  return wt(
    cdp.eval(sessionId, `(async () => {
      const tool = (await document.modelContext.getTools()).find(t => t.name === "book_table_le_petit_bistro");
      try {
        const res = await document.modelContext.executeTool(tool, ${JSON.stringify(payload)});
        return { ok: true, res };
      } catch (err) {
        return { ok: false, error: String(err?.name) + ": " + String(err?.message) };
      }
    })()`),
    timeoutMs,
  );
}
