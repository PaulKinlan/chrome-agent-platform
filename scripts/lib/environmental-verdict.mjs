// scripts/lib/environmental-verdict.mjs — canonical environmental refusal constants.
// Used across Node runner scripts and Deno test suites to avoid duplicated literals and drift.

/** The exit code used for an environmental refusal (e.g. host loaded, heavy slot timeout, missing browser prerequisite).
 *  Distinct from 0 (green) and 1 (product failure). */
export const ENVIRONMENTAL_REFUSAL_EXIT = 75;

/** The marker line an aggregator or runner greps to classify an environmental refusal. */
export const ENVIRONMENTAL_REFUSAL_MARKER = "CAP_ENVIRONMENTAL_REFUSAL";

/**
 * Inspects clean error output from a test process to check if all failures are environmental refusals.
 *
 * @param {string} cleanOutput - Error output with ANSI color codes stripped
 * @returns {boolean} True if and only if there is at least one error and EVERY error block is an environmental refusal
 */
export function areAllFailuresEnvironmental(cleanOutput) {
  const errorsIndex = cleanOutput.indexOf(" ERRORS ");
  if (errorsIndex === -1) return false;

  const failuresIndex = cleanOutput.indexOf(" FAILURES ", errorsIndex);
  const errorsText = failuresIndex !== -1
    ? cleanOutput.slice(errorsIndex, failuresIndex)
    : cleanOutput.slice(errorsIndex);

  // Each failure in Deno test error output starts with "\n\n<test_name> =>" or "\n<test_name> =>"
  const errorBlocks = errorsText.split(/\n+(?=[^\s\n].*?=>\s*)/).slice(1);
  if (errorBlocks.length === 0) return false;

  for (const block of errorBlocks) {
    // Separate test heading (<test_name> => <path>) from the actual error body
    // so a test with QuietWindowRefusedError in its name does not falsely classify product errors.
    const arrowIdx = block.indexOf("=>");
    const errorBody = arrowIdx !== -1 ? block.slice(block.indexOf("\n", arrowIdx)) : block;

    // Finding 2y5h7: An AssertionError in the error body (e.g. from assertRejects) is a
    // test failure, never an uncaught environmental refusal.
    if (errorBody.includes("AssertionError:")) {
      return false;
    }

    const isRefusal =
      errorBody.includes(ENVIRONMENTAL_REFUSAL_MARKER) ||
      errorBody.includes("ENVIRONMENT: machine is not quiet enough for this gate") ||
      errorBody.includes("ENVIRONMENT: ntp-boot-staging refusal") ||
      errorBody.includes("ENVIRONMENT: the fleet-wide heavy-gate slot is busy") ||
      errorBody.includes("QuietWindowRefusedError: ENVIRONMENT:") ||
      errorBody.includes("BootStagingEnvironmentalRefusalError: ENVIRONMENT:") ||
      (errorBody.includes("ServiceWorkerTargetTimeoutError:") &&
        (errorBody.includes("[loaded]") || errorBody.includes("[unmeasurable]"))) ||
      (errorBody.includes("CdpEvaluateLoadTimeoutError:") &&
        (errorBody.includes("[loaded]") || errorBody.includes("[unmeasurable]"))) ||
      (errorBody.includes("CdpLoadTimeoutError:") &&
        (errorBody.includes("[loaded]") || errorBody.includes("[unmeasurable]")));
    if (!isRefusal) {
      return false;
    }
  }

  return true;
}

/**
 * Combines phase exit codes (e.g. serial, readOnly, parallel).
 * Product failures (exit 1, 124, etc.) strictly outrank environmental refusals (75).
 * Only when all non-zero phases are environmental refusals is the result 75.
 * If all phases are 0, returns 0.
 *
 * @param {number[]} codes
 * @returns {number}
 */
export function combinePhaseExitCodes(...codes) {
  const productFail = codes.find((c) => c !== 0 && c !== ENVIRONMENTAL_REFUSAL_EXIT);
  if (productFail !== undefined) return productFail;
  if (codes.includes(ENVIRONMENTAL_REFUSAL_EXIT)) return ENVIRONMENTAL_REFUSAL_EXIT;
  return 0;
}

