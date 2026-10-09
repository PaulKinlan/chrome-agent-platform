// scripts/lib/kat-evaluate.ts — chrome-agent-platform-tf48c
// Load-classified CDP evaluate and command dispatch with CPU starvation budget extension.

import {
  classifyEvaluateTimeout,
  measureEvaluateTimeout,
  evaluateTimeoutReport,
  ENVIRONMENTAL_REFUSAL_EXIT,
  ENVIRONMENTAL_REFUSAL_MARKER,
  type EvaluateTimeoutVerdict,
  readLoadSample,
} from "./quiet-window.ts";

export {
  ENVIRONMENTAL_REFUSAL_EXIT,
  ENVIRONMENTAL_REFUSAL_MARKER,
  evaluateTimeoutReport,
  type EvaluateTimeoutVerdict,
};

export class CdpEvaluateLoadTimeoutError extends Error {
  readonly verdict: EvaluateTimeoutVerdict;
  readonly method: string;
  readonly baseTimeoutMs: number;
  readonly totalTimeoutMs: number;

  constructor(
    method: string,
    verdict: EvaluateTimeoutVerdict,
    baseTimeoutMs: number,
    totalTimeoutMs: number,
  ) {
    super(
      `CDP ${method} exceeded total budget (${totalTimeoutMs}ms, base ${baseTimeoutMs}ms) under host load [${verdict.cause}]: ${verdict.environment} (${verdict.reason})`,
    );
    this.name = "CdpEvaluateLoadTimeoutError";
    this.method = method;
    this.verdict = verdict;
    this.baseTimeoutMs = baseTimeoutMs;
    this.totalTimeoutMs = totalTimeoutMs;
  }
}

export class CdpEvaluateIdleTimeoutError extends Error {
  readonly verdict: EvaluateTimeoutVerdict;
  readonly method: string;
  readonly timeoutMs: number;

  constructor(method: string, verdict: EvaluateTimeoutVerdict, timeoutMs: number) {
    super(
      `PRODUCT RED (not environmental): CDP ${method} exceeded budget (${timeoutMs}ms) while the box was measurably IDLE [${verdict.environment}] — ${verdict.reason}`,
    );
    this.name = "CdpEvaluateIdleTimeoutError";
    this.method = method;
    this.verdict = verdict;
    this.timeoutMs = timeoutMs;
  }
}

export interface ClassifiedCdpOptions {
  baseTimeoutMs?: number; // default 10_000ms
  starvationTimeoutMs?: number; // default 25_000ms
  measureVerdict?: () => Promise<EvaluateTimeoutVerdict>;
  onLog?: (msg: string) => void;
  now?: () => number;
  setTimeoutFn?: (cb: () => void, ms: number) => any;
  clearTimeoutFn?: (id: any) => void;
}

export interface ClassifiedCdpClient {
  send: (method: string, params?: any, sessionId?: string, customTimeoutMs?: number) => Promise<any>;
  onMessage: (data: string | object) => void;
  close: () => void;
  pendingCount: () => number;
}

export function createClassifiedCdpClient(
  wsSend: (msg: string) => void,
  opts: ClassifiedCdpOptions = {},
): ClassifiedCdpClient {
  const baseTimeoutMs = opts.baseTimeoutMs ?? 10_000;
  const starvationTimeoutMs = opts.starvationTimeoutMs ?? 25_000;
  const log = opts.onLog ?? ((msg: string) => console.error(msg));
  const now = opts.now ?? (() => Date.now());
  const setTimer = opts.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = opts.clearTimeoutFn ?? ((id) => clearTimeout(id));

  const measure = opts.measureVerdict ?? (async () => {
    return await measureEvaluateTimeout().catch(async () => {
      const sample = await readLoadSample().catch(() => null);
      return classifyEvaluateTimeout(sample);
    });
  });

  let nextId = 0;
  const pending = new Map<
    number,
    {
      resolve: (val: any) => void;
      reject: (err: Error) => void;
      timer: any;
      method: string;
      startedAt: number;
      extended: boolean;
      effectiveTimeoutMs: number;
    }
  >();

  function onMessage(data: string | object) {
    let d: any;
    if (typeof data === "string") {
      try {
        d = JSON.parse(data);
      } catch {
        return;
      }
    } else {
      d = data;
    }
    if (d?.id && pending.has(d.id)) {
      const req = pending.get(d.id)!;
      clearTimer(req.timer);
      pending.delete(d.id);
      if (req.extended) {
        log(
          `[kat-evaluate] CDP ${req.method} (reqId=${d.id}) succeeded within CPU starvation extension (${req.effectiveTimeoutMs}ms budget)`,
        );
      }
      if (d.error) {
        req.reject(new Error(`CDP error ${d.id}: ${d.error.message ?? JSON.stringify(d.error)}`));
      } else {
        req.resolve(d);
      }
    }
  }

  function handleTimeout(id: number) {
    const req = pending.get(id);
    if (!req) return;

    (async () => {
      try {
        const verdict = await measure();
        // Finding P2: If close() ran or request was settled while awaiting measure(), abort
        if (!pending.has(id) || pending.get(id) !== req) return;

        // Finding P1: Recalculate elapsed AFTER measurement completes
        const elapsedAfterMeasure = now() - req.startedAt;

        if (verdict.cause === "loaded" || verdict.environmental) {
          if (!req.extended && starvationTimeoutMs > elapsedAfterMeasure) {
            req.extended = true;
            const remainingMs = Math.max(1, starvationTimeoutMs - elapsedAfterMeasure);
            req.effectiveTimeoutMs = starvationTimeoutMs;
            log(
              `[kat-evaluate] CDP ${req.method} (reqId=${id}) exceeded initial budget (${baseTimeoutMs}ms) under host load [${verdict.cause}]: extending budget to ${starvationTimeoutMs}ms for CPU starvation retry (${verdict.environment})`,
            );
            req.timer = setTimer(() => handleTimeout(id), remainingMs);
            return;
          }

          pending.delete(id);
          req.reject(
            new CdpEvaluateLoadTimeoutError(
              req.method,
              verdict,
              baseTimeoutMs,
              starvationTimeoutMs,
            ),
          );
          return;
        }

        // Idle box — never settled: PRODUCT RED
        pending.delete(id);
        req.reject(
          new CdpEvaluateIdleTimeoutError(
            req.method,
            verdict,
            req.effectiveTimeoutMs,
          ),
        );
      } catch (err: any) {
        if (pending.has(id) && pending.get(id) === req) {
          pending.delete(id);
          req.reject(new Error(`CDP ${req.method} timed out (classification failed: ${err?.message ?? err})`));
        }
      }
    })();
  }

  function send(
    method: string,
    params: any = {},
    sessionId?: string,
    customTimeoutMs?: number,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const initialBudget = customTimeoutMs ?? baseTimeoutMs;
      const timer = setTimer(() => handleTimeout(id), initialBudget);
      pending.set(id, {
        resolve,
        reject,
        timer,
        method,
        startedAt: now(),
        extended: false,
        effectiveTimeoutMs: initialBudget,
      });

      const frame: any = { id, method, params };
      if (sessionId) frame.sessionId = sessionId;
      wsSend(JSON.stringify(frame));
    });
  }

  function close() {
    for (const [id, req] of pending) {
      clearTimer(req.timer);
      req.reject(new Error(`CDP connection closed with pending request ${id} (${req.method})`));
    }
    pending.clear();
  }

  return {
    send,
    onMessage,
    close,
    pendingCount: () => pending.size,
  };
}
