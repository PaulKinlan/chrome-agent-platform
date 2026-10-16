// tests/environmental-verdict.test.ts — verification for chrome-agent-platform-9dvae.
// Single-sourced environmental refusal exit and marker constants.

import { assertEquals, assert } from "jsr:@std/assert@1";
import {
  ENVIRONMENTAL_REFUSAL_EXIT,
  ENVIRONMENTAL_REFUSAL_MARKER,
} from "../scripts/lib/environmental-verdict.mjs";
import {
  ENVIRONMENTAL_REFUSAL_EXIT as QUIET_WINDOW_EXIT,
  ENVIRONMENTAL_REFUSAL_MARKER as QUIET_WINDOW_MARKER,
} from "../scripts/lib/quiet-window.ts";
import {
  ENVIRONMENTAL_REFUSAL_EXIT as BROWSER_PREREQ_EXIT,
  ENVIRONMENTAL_REFUSAL_MARKER as BROWSER_PREREQ_MARKER,
} from "../scripts/lib/browser-prerequisite.mjs";
import { areAllFailuresEnvironmental } from "../scripts/run-tests.mjs";

Deno.test("9dvae: environmental-verdict constants are single-sourced and match quiet-window.ts and browser-prerequisite.mjs", () => {
  assertEquals(ENVIRONMENTAL_REFUSAL_EXIT, 75);
  assertEquals(ENVIRONMENTAL_REFUSAL_MARKER, "CAP_ENVIRONMENTAL_REFUSAL");
  assertEquals(QUIET_WINDOW_EXIT, ENVIRONMENTAL_REFUSAL_EXIT, "quiet-window exit must equal environmental-verdict");
  assertEquals(QUIET_WINDOW_MARKER, ENVIRONMENTAL_REFUSAL_MARKER, "quiet-window marker must equal environmental-verdict");
  assertEquals(BROWSER_PREREQ_EXIT, ENVIRONMENTAL_REFUSAL_EXIT, "browser-prerequisite exit must equal environmental-verdict");
  assertEquals(BROWSER_PREREQ_MARKER, ENVIRONMENTAL_REFUSAL_MARKER, "browser-prerequisite marker must equal environmental-verdict");
});

Deno.test("k3a4c: scripts/run-tests.mjs imports ENVIRONMENTAL_REFUSAL_MARKER and uses no bare literals", () => {
  const runTestsContent = Deno.readTextFileSync(new URL("../scripts/run-tests.mjs", import.meta.url));
  assert(
    runTestsContent.includes("import { ENVIRONMENTAL_REFUSAL_EXIT, ENVIRONMENTAL_REFUSAL_MARKER } from \"./lib/environmental-verdict.mjs\""),
    "run-tests.mjs must import ENVIRONMENTAL_REFUSAL_MARKER from environmental-verdict.mjs",
  );
  assert(
    !runTestsContent.includes("\"CAP_ENVIRONMENTAL_REFUSAL\""),
    "run-tests.mjs must not contain bare literal \"CAP_ENVIRONMENTAL_REFUSAL\"",
  );

  const testOutput = `
 ERRORS 

test with environmental marker => ./tests/sample.test.ts:12:1
error: Error: ${ENVIRONMENTAL_REFUSAL_MARKER} {"reason":"prereq-failed"}
  throw new Error("${ENVIRONMENTAL_REFUSAL_MARKER}");
        ^

 FAILURES 
`;
  assertEquals(areAllFailuresEnvironmental(testOutput), true);
});
