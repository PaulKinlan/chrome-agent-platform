// CAP-FB-20260830-PROVIDER-DEFAULT-AND-KEY-FLOW-01 — the provider readiness the
// hub strip reads. A keyed provider with NO model and NO catalogue default must
// fail closed ("model id missing") so a real provider id never silently runs
// the demo model; a keyed provider whose model is empty but HAS a catalogue
// default is ready (it runs the recommended default). This guards the property
// the fresh-user flow depends on (the fail-closed itself landed with
// CAP-FB-20260830-MODEL-FIELD-EMPTY-SAVE-01; this keeps it from regressing).

import { assert, assertEquals } from "jsr:@std/assert@1";
import { providerRunGate } from "../extension/lib/provider-gate.js";
import { defaultModelFor } from "../extension/lib/model-catalog.js";

Deno.test("a keyed provider with an empty model and no catalogue default reports ok:false 'model id missing'", async () => {
  // openai-compatible (BYO endpoint) has no catalogue default.
  assertEquals(defaultModelFor("openai-compatible"), "");
  const gate = await providerRunGate({
    provider: "openai-compatible",
    baseURL: "https://byo.example/v1",
    apiKey: "k",
    model: "",
  });
  assertEquals(gate.ok, false);
  assertEquals(gate.code, "model id missing");
});

Deno.test("a keyed provider with an empty model but a catalogue default is ready (runs the default)", async () => {
  // openai's catalogue default is the recommended id.
  assertEquals(defaultModelFor("openai"), "gpt-5.6-luna");
  const gate = await providerRunGate({
    provider: "openai",
    baseURL: "https://api.openai.com/v1",
    apiKey: "k",
    model: "",
  });
  assert(gate.ok, "an empty model runs the catalogue default rather than failing");
});

Deno.test("the recommended default is OpenAI gpt-5.6-luna; the alternative is Gemini gemini-3.7-flash", () => {
  assertEquals(defaultModelFor("openai"), "gpt-5.6-luna");
  assertEquals(defaultModelFor("gemini"), "gemini-3.7-flash");
});
