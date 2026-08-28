// tests/composer-grow.test.ts — source pins for the composer auto-grow fix
// (owner bug 2026-08-28: the task input scrolled typed text out of view after
// 1–2 lines). The behavioral proof is the live KAT
// (scripts/kat-composer-grow.ts — falsification-gated against the pre-fix
// component); these pins stop a silent regression of the wiring.

const src = await Deno.readTextFile(
  new URL("../extension/shared/components.js", import.meta.url),
);

Deno.test("composer-grow: the textarea auto-grows on input (the _onComposerInput path)", () => {
  if (!/async _onComposerInput\(\) \{[\s\S]{0,200}?this\._autoGrow\(\)/.test(src)) {
    throw new Error("_onComposerInput must call _autoGrow()");
  }
});

Deno.test("composer-grow: the cap derives from the COMPUTED line-height (10 lines), not hardcoded px", () => {
  if (!/lineHeight \* 10/.test(src)) throw new Error("the cap must be lineHeight * 10");
  if (!/parseFloat\(style\.lineHeight\)/.test(src)) throw new Error("line-height must come from getComputedStyle");
});

Deno.test("composer-grow: manual resize is disabled and overflow flips at the cap", () => {
  if (!/agent-composer \.composer textarea \{[^}]*resize:none/.test(src)) throw new Error("textarea must be resize:none");
  if (!/overflowY = .* ? "auto" : "hidden"/.test(src)) throw new Error("overflow-y must flip to auto only past the cap");
});

Deno.test("composer-grow: programmatic value changes also grow (set value + mic transcript + send-reset)", () => {
  if (!/set value\(v\) \{[\s\S]{0,120}?_autoGrow\(\)/.test(src)) throw new Error("set value must auto-grow");
  if (!/transcript[\s\S]{0,200}?_autoGrow\(\)/.test(src)) throw new Error("mic transcript must auto-grow");
  if (!/_input\) \{ this\._input\.value = ""; this\._autoGrow\(\)/.test(src)) throw new Error("_send must reset the height after clearing");
});

Deno.test("composer-grow: a HIDDEN composer is never pinned to 0px (thread composer before its view opens)", () => {
  if (!/if \(!input\.scrollHeight\) return/.test(src)) throw new Error("the hidden-composer guard must exist");
});
