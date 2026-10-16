// scripts/lib/environmental-verdict.mjs — canonical environmental refusal constants.
// Used across Node runner scripts and Deno test suites to avoid duplicated literals and drift.

/** The exit code used for an environmental refusal (e.g. host loaded, heavy slot timeout, missing browser prerequisite).
 *  Distinct from 0 (green) and 1 (product failure). */
export const ENVIRONMENTAL_REFUSAL_EXIT = 75;

/** The marker line an aggregator or runner greps to classify an environmental refusal. */
export const ENVIRONMENTAL_REFUSAL_MARKER = "CAP_ENVIRONMENTAL_REFUSAL";
