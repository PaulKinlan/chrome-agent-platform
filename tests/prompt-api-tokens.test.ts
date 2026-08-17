// tests/prompt-api-tokens.test.ts — the Prompt API reports NO token counts
// (0/0), which usage.js dropped (an on-device run was invisible in accounting).
// The fix: the adapter emits an ESTIMATE (~4 chars/token) so the on-device
// provider shows as a real zero-cost row. These tests lock the estimator.
// @ts-nocheck

import { assert, assertEquals } from "jsr:@std/assert@1";
import { estimateTokens } from "../extension/lib/models/prompt-api-model.js";

Deno.test("estimateTokens: empty text → 0", () => {
  assertEquals(estimateTokens(""), 0);
  assertEquals(estimateTokens(undefined), 0);
  assertEquals(estimateTokens(null), 0);
});

Deno.test("estimateTokens: ~4 chars/token, minimum 1 for non-empty", () => {
  assertEquals(estimateTokens("abcd"), 1);
  assertEquals(estimateTokens("abcdefgh"), 2);
  assertEquals(estimateTokens("abcdefghi"), 3); // ceil(9/4)=3
  assertEquals(estimateTokens("a"), 1); // minimum 1 for non-empty
});

Deno.test("estimateTokens: a realistic prompt is non-zero", () => {
  const prompt = "Summarise this page and save the summary to memory";
  assert(estimateTokens(prompt) > 0);
  assert(estimateTokens(prompt) >= Math.ceil(prompt.length / 4));
});
