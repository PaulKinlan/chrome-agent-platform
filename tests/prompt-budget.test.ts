// tests/prompt-budget.test.ts — CAP-FB-20260830-MODEL-CALL-ECONOMY-01.
// @ts-nocheck — the prompt registry is deliberately dynamic.
//
// The hub's composed system prompt rides EVERY model call of every run. It
// was 23.7 KB at the base tip (26.5 KB on the wire once agent-do adds its own
// loop instruction). The operating manual now stays under a measured budget,
// and `measurePromptLayers` is the one authority a test or a surface reads the
// per-layer bytes from.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  composeSystemPrompt,
  measurePromptLayers,
  PROMPT_BUDGET_BYTES,
  PROTECTED_CONSTRAINTS,
} from "../extension/lib/system-prompts.js";
import { MASTER_SKILL } from "../extension/lib/master-skill.js";

const utf8 = (s) => new TextEncoder().encode(String(s ?? "")).length;

Deno.test("hub system prompt composes under 6,144 bytes", () => {
  const composed = composeSystemPrompt({ baseId: "cap.hub.master" });
  const bytes = utf8(composed.text);
  assert(bytes < 6144, `the composed hub prompt is ${bytes} bytes; the budget is 6,144`);
  assertEquals(PROMPT_BUDGET_BYTES, 6144, "the budget constant is the one the acceptance names");
  // The composition still ends with the protected layer — the cut never
  // touched the constraints or their ordering.
  assert(composed.text.endsWith(PROTECTED_CONSTRAINTS), "the protected runtime policy is still the final layer");
  assert(composed.text.startsWith(MASTER_SKILL), "the operating manual is still the product base");
});

Deno.test("measurePromptLayers reports bytes per layer that sum to the composed total", () => {
  const measured = measurePromptLayers("hub");
  const composed = composeSystemPrompt({ baseId: "cap.hub.master" });
  assertEquals(measured.total, utf8(composed.text), "the total is the composed prompt's UTF-8 byte count");
  assertEquals(measured.budget, PROMPT_BUDGET_BYTES);
  assertEquals(measured.withinBudget, measured.total < PROMPT_BUDGET_BYTES);
  const ids = measured.layers.map((l) => l.id);
  assertEquals(ids, ["cap.hub.master", "cap.constraints.core"], "one row per composed layer, in composition order");
  for (const layer of measured.layers) assert(Number.isInteger(layer.bytes) && layer.bytes > 0, `${layer.id} carries a byte count`);
  // Layer bytes + the separators between them = the total (no hidden text).
  const joined = measured.layers.reduce((n, l) => n + l.bytes, 0) + 2 * (measured.layers.length - 1);
  assertEquals(joined, measured.total, "the layers account for every byte of the composition");
  // The worker base is measured the same way, and an unknown scope fails
  // closed to the protected layer only.
  const worker = measurePromptLayers("worker");
  assertEquals(worker.layers[0].id, "cap.worker.base");
  assert(worker.withinBudget, `the worker base is within budget (${worker.total} bytes)`);
  const unknown = measurePromptLayers("nope");
  assertEquals(unknown.layers.map((l) => l.id), ["cap.constraints.core"]);
});

Deno.test("measurePromptLayers counts the per-run layers too (role, skills, run-time context)", () => {
  const measured = measurePromptLayers("agent:critic", {
    role: "You review pull requests.",
    skills: [{ name: "reader", description: "Reads a page carefully." }],
    runtimeContext: { placeholder: true },
  });
  const ids = measured.layers.map((l) => l.id);
  assertEquals(ids, ["cap.hub.master", "agent-role", "skills", "runtime-context", "untrusted-content-policy", "cap.constraints.core"]);
  const composed = composeSystemPrompt({
    baseId: "cap.hub.master",
    role: "You review pull requests.",
    skills: [{ name: "reader", description: "Reads a page carefully." }],
    runtimeContext: { placeholder: true },
  });
  assertEquals(measured.total, utf8(composed.text));
});
