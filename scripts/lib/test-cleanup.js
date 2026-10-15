// Test-only cleanup boundary. A finally block cannot tell whether an assertion
// is already failing; this wrapper owns both the body and its teardown so it
// can preserve the original error without hiding a failed cleanup on success.
/**
 * @template T
 * @param {() => T | Promise<T>} body
 * A cleanup step returning false is a failure (e.g. a timed-out reap). Use
 * { run, allowFalse: true } only for a deliberately best-effort boolean step;
 * rejected promises and thrown errors always fail, even with allowFalse.
 * @param {Array<(() => unknown) | { run: () => unknown, allowFalse: true }>} steps
 * @param {(line: string) => void} [report]
 * @returns {Promise<T>}
 */
export async function withCleanup(body, steps, report = (line) => console.error(line)) {
  let result;
  let bodyFailed = false;
  let bodyError;
  try {
    result = await body();
  } catch (error) {
    bodyFailed = true;
    bodyError = error;
  }

  let cleanupFailed = false;
  let firstCleanupError;
  for (const step of steps) {
    try {
      const result = await (typeof step === "function" ? step() : step.run());
      if (result === false && (typeof step === "function" || step.allowFalse !== true)) {
        throw new Error("cleanup step returned false");
      }
    } catch (error) {
      if (!cleanupFailed) {
        cleanupFailed = true;
        firstCleanupError = error;
      }
      // A broken reporter is also a teardown failure, not permission to skip
      // the rest or replace an assertion error already in flight.
      try {
        report(`cleanup step failed: ${error instanceof Error ? error.message : String(error)}`);
      } catch { /* preserve the captured failure and keep running later steps */ }
    }
  }
  if (bodyFailed) throw bodyError;
  if (cleanupFailed) throw firstCleanupError;
  return result;
}
