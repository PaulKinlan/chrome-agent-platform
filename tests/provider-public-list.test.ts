// tests/provider-public-list.test.ts — public provider visibility + migration safety.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { PROVIDER_CHOICES } from "../extension/lib/provider.js";
import {
  INTERNAL_PROVIDER_ACTIVE_MESSAGE,
  INTERNAL_PROVIDER_IDS,
  providerSelectionPresentation,
  publicProviderChoices,
  renderInternalProviderStatus,
} from "../extension/lib/provider-visibility.js";

const PUBLIC_IDS = [
  "openai",
  "anthropic",
  "gemini",
  "deepseek",
  "openai-compatible",
  "ollama",
  "lm-studio",
];

Deno.test("provider public list: filters internal choices without changing runtime authority", () => {
  const before = PROVIDER_CHOICES.map((choice) => choice.id);
  const visible = publicProviderChoices(PROVIDER_CHOICES);
  assertEquals(visible.map((choice) => choice.id), PUBLIC_IDS);
  assertEquals(
    PROVIDER_CHOICES.map((choice) => choice.id),
    before,
    "the internal authority was mutated",
  );
  for (const id of INTERNAL_PROVIDER_IDS) {
    assert(
      PROVIDER_CHOICES.some((choice) => choice.id === id),
      `${id} stopped being internally resolvable`,
    );
    assert(
      !visible.some((choice) => choice.id === id),
      `${id} leaked into the public list`,
    );
  }
});

Deno.test("provider options: the settings picker source never offers an internal provider", async () => {
  // Structured extraction, not a substring scan (test-honesty rule 2): slice
  // the PROVIDERS array literal out of options.js and read the ids actually
  // declared inside it, so a demo/prompt-api card added back into the picker
  // fails this test by construction. The exclusion lives by ABSENCE from this
  // array (Paul 2026-08-17 note in options.js) — this pin is what makes the
  // absence a guarded property instead of an accident.
  const js = await Deno.readTextFile("extension/options/options.js");
  const arrayStart = js.indexOf("const PROVIDERS = [");
  assert(arrayStart !== -1, "the settings PROVIDERS array literal is missing");
  const arrayEnd = js.indexOf("\n];", arrayStart);
  assert(arrayEnd !== -1, "the settings PROVIDERS array literal has no terminator");
  const literal = js.slice(arrayStart, arrayEnd);
  const declaredIds = [...literal.matchAll(/\bid:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert(declaredIds.length > 0, "the settings picker declares no provider cards");
  for (const internal of INTERNAL_PROVIDER_IDS) {
    assert(
      !declaredIds.includes(internal),
      `${internal} became selectable in the settings picker`,
    );
  }
  // One-directional sync: every card the picker declares is a provider the
  // runtime authority serves as PUBLIC. (The inverse is deliberately not
  // asserted — lm-studio is public but needs no picker card to stay valid.)
  const publicIds = publicProviderChoices(PROVIDER_CHOICES).map((choice) => choice.id);
  for (const declared of declaredIds) {
    assert(
      publicIds.includes(declared),
      `${declared} is a settings picker card but is not in the public authority list`,
    );
  }
});

Deno.test("provider public list: malformed choice inputs fail closed", () => {
  assertEquals(publicProviderChoices(null), []);
  assertEquals(
    publicProviderChoices([null, { id: "demo" }, { id: "openai" }]),
    [{ id: "openai" }],
  );
});

for (const provider of INTERNAL_PROVIDER_IDS) {
  Deno.test(`provider options: stored global ${provider} renders truthful state without migration`, () => {
    const config = Object.freeze({
      provider,
      baseURL: "",
      model: provider === "prompt-api" ? "gemini-nano" : "",
    });
    const before = JSON.stringify(config);
    const state = providerSelectionPresentation(
      config,
      publicProviderChoices(PROVIDER_CHOICES),
    );
    assertEquals(state.hiddenInternal, true);
    assertEquals(state.selectValue, "");
    assertEquals(state.message, INTERNAL_PROVIDER_ACTIVE_MESSAGE);
    assertEquals(
      JSON.stringify(config),
      before,
      "render presentation mutated the stored global config",
    );

    const target = { hidden: true, textContent: "stale" };
    renderInternalProviderStatus(target, state);
    assertEquals(target, {
      hidden: false,
      textContent: INTERNAL_PROVIDER_ACTIVE_MESSAGE,
    });
    assert(
      INTERNAL_PROVIDER_ACTIVE_MESSAGE.length < 100,
      "the visible state must stay bounded",
    );
  });

  Deno.test(`provider options: stored per-agent ${provider} remains intact until an owner replacement`, () => {
    const override = Object.freeze({
      provider,
      baseURL: "",
      model: provider === "prompt-api" ? "gemini-nano" : "demo-local",
      hasApiKey: false,
    });
    const before = JSON.stringify(override);
    const state = providerSelectionPresentation(
      override,
      publicProviderChoices(PROVIDER_CHOICES),
    );
    assertEquals(state.hiddenInternal, true);
    assertEquals(
      state.selectValue,
      "",
      "an internal id must not become a selectable public value",
    );
    assertEquals(
      JSON.stringify(override),
      before,
      "render presentation mutated the stored per-agent override",
    );
  });
}

Deno.test("provider options: listed providers remain selected and clear the internal-only status", () => {
  const state = providerSelectionPresentation(
    { provider: "gemini", model: "gemini-3.7-flash" },
    publicProviderChoices(PROVIDER_CHOICES),
  );
  assertEquals(state.hiddenInternal, false);
  assertEquals(state.selectValue, "gemini");
  const target = { hidden: false, textContent: "stale" };
  renderInternalProviderStatus(target, state);
  assertEquals(target, { hidden: true, textContent: "" });
});

Deno.test("provider options source: global and per-agent settings renderers consume the shared no-migration state", async () => {
  const html = await Deno.readTextFile("extension/options/options.html");
  const js = await Deno.readTextFile("extension/options/options.js");
  const css = await Deno.readTextFile("extension/options/options.css");

  assert(
    !html.includes("The on-device Prompt API"),
    "the stale public Prompt API/Demo hint remains",
  );
  assertStringIncludes(html, 'id="provider-selection-status"');
  assertStringIncludes(html, 'role="status"');
  assertStringIncludes(js, "providerSelectionPresentation(cfg, PROVIDERS)");
  assertStringIncludes(js, "providerSelectionPresentation(cur, PROVIDERS)");
  assertStringIncludes(
    js,
    "renderInternalProviderStatus(internalStatus, storedSelection)",
  );
  assertStringIncludes(js, "hiddenLegacyUnchanged");
  assertStringIncludes(js, "setAgentProvider.disabled = hiddenLegacyUnchanged");
  assertStringIncludes(css, ".agent-provider-internal-status");
});
