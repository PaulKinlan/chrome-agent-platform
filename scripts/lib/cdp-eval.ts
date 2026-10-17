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

/** A PAGE-SIDE throw surfaced by a transport's `Runtime.evaluate` (Chrome's
 * `exceptionDetails`). Thrown by `openCdp(...).eval()` where the exception is
 * unwrapped, so the detail is the page's own description.
 *
 * DISTINCT FROM A TRANSPORT FAILURE, and the distinction is load-bearing for
 * every caller that retries: a transport failure means the instrument could
 * not RUN the expression, while this means the page RAN it and threw. A page
 * expression can literally throw "Cannot find default execution context", so a
 * retry decided on the message text alone would retry it and swallow it into
 * an `undefined`/absent read — the exact conversion this module exists to end
 * (chrome-agent-platform-0lb4). Retry TRANSPORT failures; surface this. */
export class PageThrowError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "PageThrowError";
  }
}

/** The TRANSPORT failure every harness in this repo retries by hand: an
 * execution context that has not come up yet. Chrome reports it as a protocol
 * error on the Runtime.evaluate CALL, before any page code runs. */
export const TRANSIENT_CONTEXT_MESSAGE = "Cannot find default execution context";
/** Bounded: 5 attempts total, 250 ms apart (the numbers both hand-rolled copies
 * used, kept so this is a refactor and not a behaviour change). */
export const TRANSIENT_CONTEXT_ATTEMPTS = 5;
export const TRANSIENT_CONTEXT_RETRY_MS = 250;

export interface TransientContextRetryOptions {
  attempts?: number;
  delayMs?: number;
  /** Injected so a test can assert the retry schedule without waiting for it. */
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, message: string) => void;
}

/** Retry a Runtime.evaluate that died with the transient execution-context
 * TRANSPORT error, and ONLY that one.
 *
 * This is the single source for a retry that chrome-journeys' evalIn and
 * click-target's probePoint each carried a copy of, and that the journey/KAT
 * scripts beside them did NOT have at all (chrome-agent-platform-zq76k: a ~2 s
 * launch race in kat-site-delegation-attachments red a union gate and cost a
 * whole re-run because its local evalIn had no retry). One copy, one decision.
 *
 * DECIDED ON THE ERROR KIND FIRST: a `PageThrowError` is never retried, whatever
 * its text says — a page expression can literally throw "Cannot find default
 * execution context", and retrying it would swallow a real page failure into an
 * absent value (0lb4 P1). A transport failure that is NOT this phrase is not
 * retried either: it does not mean a frame is coming up.
 *
 * Exhausting `attempts` rethrows the LAST error unchanged, so each caller keeps
 * its own error contract (click-target wraps it in an EvalSurfaceError naming
 * its site; chrome-journeys rethrows it).
 */
export async function withTransientContextRetry<T>(
  evaluate: () => Promise<T>,
  opts: TransientContextRetryOptions = {},
): Promise<T> {
  const attempts = opts.attempts ?? TRANSIENT_CONTEXT_ATTEMPTS;
  const delayMs = opts.delayMs ?? TRANSIENT_CONTEXT_RETRY_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await evaluate();
    } catch (e) {
      lastErr = e;
      if (e instanceof PageThrowError) break;
      const message = String((e as Error)?.message ?? e);
      if (!message.includes(TRANSIENT_CONTEXT_MESSAGE) || attempt === attempts - 1) break;
      opts.onRetry?.(attempt + 1, message);
      await sleep(delayMs);
    }
  }
  throw lastErr;
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
