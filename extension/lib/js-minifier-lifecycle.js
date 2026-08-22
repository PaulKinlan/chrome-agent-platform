const encoder = new TextEncoder();
export const INPUT_LIMIT_BYTES = 1_048_576;
export const OUTPUT_LIMIT_BYTES = 1_048_576;
export const WALL_TIMEOUT_MS = 3_000;

export function runFreshWorker(url, request, { WorkerCtor = globalThis.Worker, timeoutMs = WALL_TIMEOUT_MS } = {}) {
  if (typeof WorkerCtor !== 'function') return Promise.reject(new Error('Worker unavailable; no main-thread fallback'));
  if (encoder.encode(request.code).byteLength > INPUT_LIMIT_BYTES) {
    return Promise.reject(Object.assign(new RangeError('input exceeds 1 MiB'), { errno: 27 }));
  }
  let worker;
  try {
    worker = new WorkerCtor(url, { type: 'module' });
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = async (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { await worker.terminate(); } catch {}
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(Object.assign(new Error('worker timeout after 3000 ms'), { errno: 110 })), timeoutMs);
    worker.onmessage = (event) => {
      const value = event.data;
      if (value?.ok && typeof value?.result?.output === 'string' && encoder.encode(value.result.output).byteLength > OUTPUT_LIMIT_BYTES) {
        finish(Object.assign(new RangeError('output exceeds 1 MiB'), { errno: 27 }));
        return;
      }
      finish(null, value);
    };
    worker.onerror = (event) => finish(event?.error ?? new Error(event?.message ?? 'worker failure'));
    try { worker.postMessage(request); } catch (error) { finish(error); }
  });
}
