// scripts/lib/cdp-eval.ts — the ONE guard for reading values out of
// Runtime.evaluate (chrome-agent-platform-kwrx).
//
// THE DEFECT THIS ENDS: a harness wraps Runtime.evaluate, returns the value,
// and never inspects `exceptionDetails` — so a page-side throw becomes
// `undefined` and the CONSUMER reports it as a product failure. Three such
// conversions are on the record (4vfj: four a11y checks red on main; cwy2:
// twenty checks skipped; 0lb4/4s4j: the security gate reading `composer:false`
// where its instrument actually failed). Before this file the guard was
// hand-written in six places with TWO spellings, because the transports
// differ — and the spelling difference is invisible to a reader, so every
// paste is a fresh landmine no test notices.
//
// THE DESIGN: callers do not get a generic `evaluate`. They get one entry
// point PER TRANSPORT, named for the shape their CDP wrapper resolves:
//
//   • wireValue(msg, site, …)   — the harness resolves the WHOLE wire message
//     `{ id, result: { result: { value }, exceptionDetails? } }`
//     (chrome-journeys' `resolve(d)` family).
//   • methodValue(res, site, …) — the harness resolves the UNWRAPPED method
//     result `{ result: { value }, exceptionDetails? }`
//     (a11y-audit / capability-lifecycle / perf-leak-trace family).
//
// Picking the wrong mode is a compile error on real payloads, not a silent
// `undefined`: each mode reads `exceptionDetails` where THAT transport puts
// it, and neither shape satisfies the other's lookup.
//
// FAIL LOUD IS THE DEFAULT: a surfaced exception throws EvalSurfaceError
// naming the site and quoting the page-side text. Tolerance is opt-in and
// EVIDENCED: `{ tolerant: true, why: "<reason>" }` is required at every
// call site that wants a non-throwing read, and the result is a NAMED
// diagnostic (`EvalDiagnostic`, `__cdpEvalError` + site) — never a bare
// `undefined` or `false` the consumer cannot tell from a product answer.
// `why` exists so the reason lives in code next to the tolerance, not in a
// comment that drifts (kwrx AC-3).

export interface EvalDiagnostic {
  readonly __cdpEvalError: string;
  readonly site: string;
}

export class EvalSurfaceError extends Error {
  constructor(site: string, detail: string) {
    super(`[cdp-eval:${site}] page expression threw: ${detail}`);
    this.name = "EvalSurfaceError";
  }
}

/** Wire envelope: what a `resolve(d)` CDP wrapper hands back. */
export interface WireEvaluateMessage {
  id?: number;
  sessionId?: string;
  result?: {
    result?: { value?: unknown; subtype?: string; type?: string };
    exceptionDetails?: unknown;
  };
  error?: unknown;
}

/** Method result: what a `resolve(m.result)` (or explicit-unwrap) wrapper hands back. */
export interface MethodEvaluateResult {
  result?: { value?: unknown; subtype?: string; type?: string };
  exceptionDetails?: unknown;
}

export type EvalMode =
  | { tolerant?: false; why?: undefined }
  | { tolerant: true; why: string };

/** exceptionDetails -> one honest line of text. Never returns "" for a
 * present details object: an unparseable shape is serialized, not swallowed. */
function surfaceText(ed: unknown): string {
  if (!ed || typeof ed !== "object") return String(ed);
  const e = ed as {
    text?: string;
    exception?: { description?: string; value?: unknown };
    url?: string;
    lineNumber?: number;
  };
  const where = e.url ? ` @${e.url}:${e.lineNumber ?? "?"}` : "";
  const ex = e.exception?.description ??
    (e.exception?.value !== undefined ? String(e.exception.value) : undefined);
  return (ex ?? e.text ?? JSON.stringify(ed)) + where;
}

function readValue<T>(
  valueBox: { value?: unknown } | undefined,
  ed: unknown,
  site: string,
  mode: EvalMode | undefined,
): T | EvalDiagnostic {
  if (ed !== undefined && ed !== null) {
    const detail = surfaceText(ed);
    if (mode?.tolerant) {
      if (!mode.why || !mode.why.trim()) {
        throw new EvalSurfaceError(
          site,
          "tolerant eval requires a non-empty `why` (the reason tolerance is correct here)",
        );
      }
      return { __cdpEvalError: detail, site };
    }
    throw new EvalSurfaceError(site, detail);
  }
  return valueBox?.value as T;
}

/** Absent or protocol-error envelopes are instrument deaths, not product
 * answers: strict throws, tolerant names — undefined never passes silently. */
function envelopeTrip<T>(
  bad: WireEvaluateMessage | MethodEvaluateResult | null | undefined,
  site: string,
  mode: EvalMode | undefined,
): T | EvalDiagnostic | null {
  let why: string | null = null;
  if (bad === null || bad === undefined) why = "no-response-envelope";
  else if ((bad as WireEvaluateMessage).error !== undefined) {
    why = `cdp-protocol-error ${JSON.stringify((bad as WireEvaluateMessage).error).slice(0, 200)}`;
  }
  if (why === null) return null;
  if (mode?.tolerant) {
    if (!mode.why || !mode.why.trim()) {
      throw new EvalSurfaceError(site, "tolerant eval requires a non-empty `why`");
    }
    return { __cdpEvalError: why, site };
  }
  throw new EvalSurfaceError(site, `${why} — the instrument died; this is not a product answer`);
}

/** Read a value from a FULL wire message (`resolve(d)` transports). */
export function wireValue<T = unknown>(msg: WireEvaluateMessage | null | undefined, site: string): T;
export function wireValue<T = unknown>(msg: WireEvaluateMessage | null | undefined, site: string, mode: EvalMode): T | EvalDiagnostic;
export function wireValue<T = unknown>(
  msg: WireEvaluateMessage | null | undefined,
  site: string,
  mode?: EvalMode,
): T | EvalDiagnostic {
  const trip = envelopeTrip<T>(msg, site, mode);
  if (trip !== null) return trip;
  // Wrong-mode trip: a top-level exceptionDetails means a METHOD-result
  // payload arrived at the wire reader. Silently reading `undefined` here is
  // the invisible cross-transport bug cap-astra named — make it loud.
  if (msg && "exceptionDetails" in msg) {
    throw new EvalSurfaceError(
      site,
      "transport mismatch: method-result payload passed to wireValue — use methodValue for resolve(m.result) harnesses",
    );
  }
  return readValue<T>(msg?.result?.result, msg?.result?.exceptionDetails, site, mode);
}

/** Read a value from an UNWRAPPED method result (`resolve(m.result)` transports). */
export function methodValue<T = unknown>(res: MethodEvaluateResult | null | undefined, site: string): T;
export function methodValue<T = unknown>(res: MethodEvaluateResult | null | undefined, site: string, mode: EvalMode): T | EvalDiagnostic;
export function methodValue<T = unknown>(
  res: MethodEvaluateResult | null | undefined,
  site: string,
  mode?: EvalMode,
): T | EvalDiagnostic {
  const trip = envelopeTrip<T>(res, site, mode);
  if (trip !== null) return trip;
  // Wrong-mode trip: an exceptionDetails NESTED under .result means the FULL
  // wire message arrived at the method reader.
  const inner = res?.result as { exceptionDetails?: unknown } | undefined;
  if (inner && typeof inner === "object" && "exceptionDetails" in inner) {
    throw new EvalSurfaceError(
      site,
      "transport mismatch: wire-envelope payload passed to methodValue — use wireValue for resolve(d) harnesses",
    );
  }
  return readValue<T>(res?.result, res?.exceptionDetails, site, mode);
}

/** True when a value is a surfaced-eval diagnostic (tolerant-mode results). */
export function isEvalDiagnostic(v: unknown): v is EvalDiagnostic {
  return typeof v === "object" && v !== null && "__cdpEvalError" in v;
}
