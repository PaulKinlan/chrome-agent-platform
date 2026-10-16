// tests/environmental-verdict.test.ts — verification for chrome-agent-platform-9dvae.
// Single-sourced environmental refusal exit and marker constants.

import { assertEquals } from "jsr:@std/assert@1";
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

Deno.test("9dvae: environmental-verdict constants are single-sourced and match quiet-window.ts and browser-prerequisite.mjs", () => {
  assertEquals(ENVIRONMENTAL_REFUSAL_EXIT, 75);
  assertEquals(ENVIRONMENTAL_REFUSAL_MARKER, "CAP_ENVIRONMENTAL_REFUSAL");
  assertEquals(QUIET_WINDOW_EXIT, ENVIRONMENTAL_REFUSAL_EXIT, "quiet-window exit must equal environmental-verdict");
  assertEquals(QUIET_WINDOW_MARKER, ENVIRONMENTAL_REFUSAL_MARKER, "quiet-window marker must equal environmental-verdict");
  assertEquals(BROWSER_PREREQ_EXIT, ENVIRONMENTAL_REFUSAL_EXIT, "browser-prerequisite exit must equal environmental-verdict");
  assertEquals(BROWSER_PREREQ_MARKER, ENVIRONMENTAL_REFUSAL_MARKER, "browser-prerequisite marker must equal environmental-verdict");
});
