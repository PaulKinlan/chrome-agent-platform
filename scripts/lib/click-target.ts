// scripts/lib/click-target.ts — the ONE way a harness turns a page-measured
// point into REAL CDP mouse input (chrome-agent-platform-0lb4).
//
// THE DEFECT THIS ENDS. The security gate's click helper read its probe as
//
//     const b = await cdp.eval(session, expr).catch(() => null);
//     if (!b || typeof b.x !== "number") return false;
//
// so a PAGE-SIDE THROW and an ABSENT TARGET were the same `false`, and the
// gate reported that `false` as a product state (`composer:false`) while its
// own instrument had thrown. That is the conversion this class already cost on
// a11y-audit (4vfj: four ARIA checks red off a null element) and on the
// sender-authority probe (4s4j), and it is the reason `cdp.eval` throws rather
// than returning undefined.
//
// THE CONTRACT — two outcomes and one failure:
//   • the probe resolved a point -> genuine mousePressed + mouseReleased,
//     `{ clicked: true, x, y }`
//   • the probe resolved anything else -> `{ clicked: false,
//     reason: "absent-target" }` — the DECLARED tolerance that a polling
//     caller retries on; absent is a value here, never a substitute for a
//     failure
//   • the probe THREW -> EvalSurfaceError naming this site and quoting the
//     page-side description. Instrument death is never folded into the
//     refusal, so a caller can tell "not there yet" from "the harness broke".
//
// The ONE retry carried over from the helper this replaces is a TRANSPORT
// execution-context failure: the same "Cannot find default execution context"
// message chrome-journeys' evalIn retries, which names a session whose frame
// has not come up rather than a page answer. It is bounded, and it is decided
// on the ERROR KIND first — a page throw is tagged `PageThrowError` at the
// source (openCdp.eval) and is never retried, because a page expression can
// literally throw that phrase and the retry would swallow it (0lb4 P1).
import type { CdpClient } from "./chrome-launch.ts";
import { EvalSurfaceError, PageThrowError } from "./cdp-eval.ts";

const SITE = "click-target";
const TRANSIENT_CONTEXT = "Cannot find default execution context";
const CONTEXT_ATTEMPTS = 5;
const CONTEXT_RETRY_MS = 250;

export type ClickOutcome =
  | { clicked: true; x: number; y: number }
  | { clicked: false; reason: "absent-target" };

/** Click what `expr` locates. The expression must resolve `{x, y}` — a point
 * measured inside the page — or resolve an absent value while the target is
 * not there yet. */
export async function clickAt(cdp: CdpClient, session: string, expr: string): Promise<ClickOutcome> {
  const point = await probePoint(cdp, session, expr);
  if (point === null) return { clicked: false, reason: "absent-target" };
  for (const [type, buttons] of [["mousePressed", 1], ["mouseReleased", 0]] as const) {
    await cdp.send(
      "Input.dispatchMouseEvent",
      { type, x: point.x, y: point.y, button: "left", buttons, clickCount: 1 },
      session,
    );
  }
  return { clicked: true, x: point.x, y: point.y };
}

async function probePoint(cdp: CdpClient, session: string, expr: string): Promise<{ x: number; y: number } | null> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < CONTEXT_ATTEMPTS; attempt++) {
    try {
      const value = await cdp.eval(session, expr);
      return isPoint(value) ? value : null;
    } catch (e) {
      lastErr = e;
      // A PAGE throw is not a transport failure, whatever its text says: an
      // expression that itself throws "Cannot find default execution context"
      // must SURFACE, not be retried into an absence answer (0lb4 P1).
      if (e instanceof PageThrowError) break;
      const message = String((e as Error)?.message ?? e);
      if (!message.includes(TRANSIENT_CONTEXT) || attempt === CONTEXT_ATTEMPTS - 1) break;
      await new Promise((resolve) => setTimeout(resolve, CONTEXT_RETRY_MS));
    }
  }
  throw new EvalSurfaceError(SITE, `${String((lastErr as Error)?.message ?? lastErr)} — expr: ${snip(expr)}`);
}

function isPoint(value: unknown): value is { x: number; y: number } {
  const p = value as { x?: unknown; y?: unknown } | null | undefined;
  return !!p && typeof p.x === "number" && typeof p.y === "number";
}

/** The expression, flattened and bounded, so the failure message carries the
 * page-side text as evidence without burying it. */
function snip(expr: string): string {
  return expr.replace(/\s+/g, " ").slice(0, 160);
}
