import { runFreshWorker, WALL_TIMEOUT_MS } from './js-minifier-lifecycle.js';

const workerFiles = Object.freeze({
  terser_bounded: './terser-bounded.worker.js',
  csso_bounded: './csso-bounded.worker.js',
  html_minifier_terser_bounded: './html-minifier-terser-bounded.worker.js'
});
let nextJob = 0;

export function runMinifier(kind, code, options = {}, { WorkerCtor = globalThis.Worker } = {}) {
  const workerFile = workerFiles[kind];
  if (!workerFile) return Promise.reject(new TypeError('unknown bounded minifier kind'));
  const id = String(++nextJob);
  return runFreshWorker(new URL(workerFile, import.meta.url), {
    type: 'js-minifier-job',
    sessionId: 'bounded-js-minifiers',
    executionId: id,
    jobId: id,
    kind,
    code,
    options
  }, { WorkerCtor, timeoutMs: WALL_TIMEOUT_MS });
}
