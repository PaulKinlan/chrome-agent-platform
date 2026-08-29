// tests/mutation-claim-check.test.ts — runtime honesty backstop for mutation
// claims (the prompt clause alone depends on model compliance — the owner's
// "I created the agent" with ZERO tool calls must be caught at runtime).

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { correctUnsupportedMutationClaims } from "../extension/lib/mutation-claim-check.js";

Deno.test("claim-check: a fabricated create claim with NO tool call is detected and corrected", () => {
  const { text, corrections } = correctUnsupportedMutationClaims(
    "Done — I've created the Research Analyst agent for you.",
    [],
  );
  assertEquals(corrections.length, 1);
  assertStringIncludes(text, "Correction");
  assertStringIncludes(text, "no such change was made");
});

Deno.test("claim-check: passive claim shapes are caught too", () => {
  for (const t of [
    "The agent was created successfully.",
    "Your agent is now scheduled.",
    "The agent has been deleted.",
    "The agent was updated.",
  ]) {
    const { corrections } = correctUnsupportedMutationClaims(t, []);
    assertEquals(corrections.length, 1, `expected correction for: ${t}`);
  }
});

Deno.test("claim-check: a claim BACKED by a successful create_named_agent is not flagged", () => {
  const { text, corrections } = correctUnsupportedMutationClaims(
    "I've created the Research Analyst agent.",
    ["search_tools", "create_named_agent"],
  );
  assertEquals(corrections.length, 0);
  assertEquals(text, "I've created the Research Analyst agent.");
});

Deno.test("claim-check: a claim backed only by a FAILED call is still flagged", () => {
  // Failed calls never enter the successful set — only the reads did.
  const { corrections } = correctUnsupportedMutationClaims(
    "I've created the agent.",
    ["search_tools", "list_named_agents"],
  );
  assertEquals(corrections.length, 1);
});

Deno.test("claim-check: update/delete/schedule claims each need their own backing tool", () => {
  assertEquals(correctUnsupportedMutationClaims("I updated the agent.", ["update_named_agent"]).corrections.length, 0);
  assertEquals(correctUnsupportedMutationClaims("I deleted the agent.", ["delete_named_agent"]).corrections.length, 0);
  assertEquals(correctUnsupportedMutationClaims("I scheduled the agent.", ["schedule_task"]).corrections.length, 0);
  // The WRONG kind of success does not back the claim.
  assertEquals(correctUnsupportedMutationClaims("I deleted the agent.", ["create_named_agent"]).corrections.length, 1);
  assertEquals(correctUnsupportedMutationClaims("I scheduled the task.", ["create_named_agent"]).corrections.length, 1);
});

Deno.test("claim-check: non-claim text passes through untouched", () => {
  for (const t of [
    "Here's the list of agents you currently have.",
    "I couldn't create the agent — the tool call failed.",
    "To create an agent, ask me and I'll run the tool.",
    "",
  ]) {
    const { text, corrections } = correctUnsupportedMutationClaims(t, []);
    assertEquals(corrections.length, 0, `false positive on: ${t}`);
    assertEquals(text, t);
  }
});

Deno.test("claim-check: multiple unsupported claims each get a correction", () => {
  const { corrections } = correctUnsupportedMutationClaims(
    "I created the agent and then deleted the agent.",
    [],
  );
  assertEquals(corrections.length, 2);
});

Deno.test("claim-check wiring: agent.js runs the check on the done path", async () => {
  const src = await Deno.readTextFile(new URL("../extension/lib/agent.js", import.meta.url));
  assertStringIncludes(src, 'from "./mutation-claim-check.js"');
  assertStringIncludes(src, "correctUnsupportedMutationClaims(e.result, okToolNames)");
});
