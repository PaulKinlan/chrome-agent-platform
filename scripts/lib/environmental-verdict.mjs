// scripts/lib/environmental-verdict.mjs — canonical environmental refusal constants.
// Used across Node runner scripts and Deno test suites to avoid duplicated literals and drift.

/** The exit code used for an environmental refusal (e.g. host loaded, heavy slot timeout, missing browser prerequisite).
 *  Distinct from 0 (green) and 1 (product failure). */
export const ENVIRONMENTAL_REFUSAL_EXIT = 75;

/** The marker line an aggregator or runner greps to classify an environmental refusal. */
export const ENVIRONMENTAL_REFUSAL_MARKER = "CAP_ENVIRONMENTAL_REFUSAL";

/**
 * Split the ERRORS section into one block per failure header. Both Deno header shapes count
 * (see the call site); anything before the first header is the preamble.
 * @param {string} errorsText
 * @returns {string[]}
 */
export function splitErrorBlocks(errorsText) {
  const isHeader = (line) => /=>\s*\S+:\d+/.test(line) || /\(uncaught error\)\s*$/.test(line);
  const blocks = [];
  let current = null;
  for (const line of String(errorsText ?? "").split("\n")) {
    if (isHeader(line)) {
      if (current) blocks.push(current.join("\n"));
      current = [line];
      continue;
    }
    if (current) current.push(line);
  }
  if (current) blocks.push(current.join("\n"));
  return blocks;
}

/**
 * The number of error lines in a block. MORE THAN ONE means something else's text was glued
 * into it (the review's shape, and the reason this is counted rather than assumed): a single
 * failure prints one `error:` line, so a second one is an unclassified failure in disguise.
 * @param {string} block
 * @returns {number}
 */
function errorLineCount(block) {
  return (String(block).match(/^\s*error:/gm) ?? []).length;
}

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

  // Each failure in Deno test error output starts with a HEADER line. There are TWO header
  // shapes, and only the first was recognised before chrome-agent-platform-0i477's review:
  //   "<test_name> => <path>:<line>:<col>"   a failing test
  //   "./<file>.test.ts (uncaught error)"    a module-level throw / unhandled rejection
  // The second carries no `=>`, so an uncaught error printed after a refusal was glued into
  // the refusal's block and removed WITH it by the leftover check — the batch classified
  // environmental, and a tree with a top-level throw came back as retryable refusal 75. The
  // verdict also flipped with filename sort order, which is the tell that this was a parsing
  // accident and not a judgement. Measured on REAL Deno 2.9.7 output, not on a hand-written
  // fixture (the review supplied that; a fixture I wrote could agree with my own parser).
  const errorBlocks = splitErrorBlocks(errorsText);
  if (errorBlocks.length === 0) return false;

  for (const block of errorBlocks) {
    // 0i477 review: a block carrying two error lines has swallowed a second failure.
    if (errorLineCount(block) > 1) return false;
    // Separate test heading (<test_name> => <path>) from the actual error body
    // so a test with QuietWindowRefusedError in its name does not falsely classify product errors.
    const arrowIdx = block.indexOf("=>");
    const errorBody = arrowIdx !== -1 ? block.slice(block.indexOf("\n", arrowIdx)) : block;

    // Finding 2y5h7: An AssertionError in the error body (e.g. from assertRejects) is a
    // test failure, never an uncaught environmental refusal.
    if (errorBody.includes("AssertionError:")) {
      return false;
    }

    // Finding lckla / 56hfm: A failure designated as PRODUCT RED or idle/unnamed load
    // is strictly a product stop, never an environmental refusal.
    if (
      errorBody.includes("PRODUCT RED (not environmental):") ||
      errorBody.includes("[idle-never-settled]") ||
      errorBody.includes("zero concurrent named heavy-builder jobs")
    ) {
      return false;
    }

    const isRefusal =
      errorBody.includes("ENVIRONMENT: machine is not quiet enough for this gate") ||
      errorBody.includes("ENVIRONMENT: ntp-boot-staging refusal") ||
      errorBody.includes("ENVIRONMENT: the fleet-wide heavy-gate slot is busy") ||
      errorBody.includes("QuietWindowRefusedError: ENVIRONMENT:") ||
      errorBody.includes("BootStagingEnvironmentalRefusalError: ENVIRONMENT:") ||
      (errorBody.includes(ENVIRONMENTAL_REFUSAL_MARKER) &&
        errorBody.includes("ENVIRONMENT:") &&
        (errorBody.includes("ServiceWorkerTargetTimeoutError:") ||
          errorBody.includes("CdpEvaluateLoadTimeoutError:") ||
          errorBody.includes("CdpLoadTimeoutError:")) &&
        (errorBody.includes("[loaded]") || errorBody.includes("[unmeasurable]"))) ||
      (errorBody.includes(ENVIRONMENTAL_REFUSAL_MARKER) &&
        !errorBody.includes("ServiceWorkerTargetTimeoutError:") &&
        !errorBody.includes("CdpEvaluateLoadTimeoutError:") &&
        !errorBody.includes("CdpLoadTimeoutError:"));
    if (!isRefusal) {
      return false;
    }
  }

  // 0i477: EVERY error line must have been accounted for. The split above only starts a
  // new block at a `name => path` line, so text that does not carry that shape — the
  // canonical one being a module-load death (`error: Module not found …`) — stayed in the
  // preamble (dropped by slice(1)) or was swallowed by the neighbouring block's body. A
  // load death printed beside an environmental refusal therefore made the BATCH classify
  // as all-environmental: classifyPhaseExit turned a tree that could not even load a
  // module into refusal 75, which an operator requeues instead of investigating. Removing
  // the classified blocks and re-testing for an `error:` line is the fail-closed check:
  // any error text the classifier did not look at keeps the batch a FAILURE.
  let leftover = errorsText;
  for (const block of errorBlocks) leftover = leftover.replace(block, "");
  if (/\berror:/m.test(leftover)) {
    return false;
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

/** True when captured phase output carries any environmental-refusal needle. */
export function outputHasEnvironmentalMarker(output) {
  return output.includes(ENVIRONMENTAL_REFUSAL_MARKER) ||
    output.includes("QuietWindowRefusedError") ||
    output.includes("ENVIRONMENT: machine is not quiet enough for this gate") ||
    output.includes("ENVIRONMENT: ntp-boot-staging refusal") ||
    output.includes("ENVIRONMENT: the fleet-wide heavy-gate slot is busy");
}

/**
 * Classify a phase's exit using the phase's own captured output (erxkj).
 *
 * The full tier (scripts/run-tests.mjs) does this inline; the subset path
 * (scripts/select-tests.mjs) historically resolved the child's RAW code, so a
 * stolen box red-ed the fast gate with rc=1 and the landing queue paid a retry
 * for an environmental refusal. The rule is the full tier's, two-sided:
 * every failure a VERIFIED refusal → exit 75 (a re-run, never a red); anything
 * else — a product block beside the refusals, a marker with no FAILED summary,
 * no marker at all — keeps the raw code, because refusal changes what the
 * operator does (requeue) and a genuine failure must never read as retryable.
 *
 * @param {number} rawCode the child process's exit code
 * @param {string} capturedOutput everything the child wrote (stdout + stderr)
 * @returns {{ code: number, note?: string }}
 */
export function classifyPhaseExitFromOutput(rawCode, capturedOutput) {
  if (rawCode === 0) return { code: 0 };
  // kdeqx: a code of 128+n is a SIGNAL-derived exit (the child did not exit
  // normally — its captured output is partial by definition), and 124 is the
  // phase-timeout bound. Never classify either: fleet-check treats
  // 124/137/143 as KILLED (not a verdict, not cached), while 75 would be
  // cached as a deterministic FAIL.
  if (rawCode === 124 || rawCode >= 128) return { code: rawCode };
  if (!outputHasEnvironmentalMarker(capturedOutput)) return { code: rawCode };
  const clean = capturedOutput.replace(/\x1b\[[0-9;]*[mGKH]/gu, "");
  const summaryMatch = /FAILED\b[\s\S]*?\|\s*(\d+)\s*failed/i.exec(clean);
  if (!summaryMatch) {
    return { code: rawCode, note: "exited non-zero with a refusal marker but no FAILED summary — preserving the raw code" };
  }
  const failCount = Number(summaryMatch[1]);
  if (failCount > 0 && areAllFailuresEnvironmental(clean)) {
    return { code: ENVIRONMENTAL_REFUSAL_EXIT, note: "every failure was an environmental refusal" };
  }
  return { code: rawCode, note: "contains non-environmental failure(s) — preserving PRODUCT RED" };
}

