// Unit tests for normaliseModelId — the Gemini model-name format fix.

import { assertEquals } from "jsr:@std/assert@1";

import { normaliseModelId } from "../extension/lib/models/model-name.js";

const GEMINI = "https://generativelanguage.googleapis.com/v1beta/openai";

Deno.test("normaliseModelId lowercases + hyphenates a Gemini model name", () => {
  assertEquals(normaliseModelId("Gemini 3.7 Flash", GEMINI), "gemini-3.7-flash");
  assertEquals(normaliseModelId("  GEMINI  2.5  Pro  ", GEMINI), "gemini-2.5-pro");
  assertEquals(normaliseModelId("Gemini 3.1 Flash-Lite", GEMINI), "gemini-3.1-flash-lite");
});

Deno.test("normaliseModelId leaves an already-correct Gemini id untouched", () => {
  assertEquals(normaliseModelId("gemini-3.7-flash", GEMINI), "gemini-3.7-flash");
  assertEquals(normaliseModelId("gemini-2.5-pro", GEMINI), "gemini-2.5-pro");
});

Deno.test("normaliseModelId leaves non-Gemini providers untouched", () => {
  assertEquals(normaliseModelId("gpt-4o", "https://api.openai.com/v1"), "gpt-4o");
  assertEquals(normaliseModelId("claude-sonnet-4-5", "https://api.anthropic.com/v1"), "claude-sonnet-4-5");
  assertEquals(normaliseModelId("deepseek-chat", "https://api.deepseek.com/v1"), "deepseek-chat");
});

Deno.test("normaliseModelId handles empty/undefined gracefully", () => {
  assertEquals(normaliseModelId("", GEMINI), "");
  assertEquals(normaliseModelId(null, GEMINI), null);
  assertEquals(normaliseModelId(undefined, GEMINI), undefined);
});
