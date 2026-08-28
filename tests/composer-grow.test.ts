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

Deno.test("composer-grow: ONE layout read per input event — the natural height is cached, never re-read (review P1: layout thrash)", () => {
  // Extract the _autoGrow method body and count layout-forcing reads.
  const m = src.match(/_autoGrow\(\) \{([\s\S]*?)\n  \}/);
  if (!m) throw new Error("_autoGrow body not found");
  const body = m[1];
  const reads = body.match(/input\.scrollHeight/g) ?? [];
  // Exactly TWO: the pre-write hidden guard (no forced layout — styles are
  // clean at handler entry) + the single cached post-write read. The
  // pre-fix body read scrollHeight THREE times (guard + height + overflow),
  // alternating write→read→write→read = two forced synchronous layouts per
  // keystroke. Falsification: on the pre-fix body this count is 3 → RED.
  if (reads.length !== 2) {
    throw new Error(`_autoGrow must read input.scrollHeight exactly twice (guard + one cached read); found ${reads.length}`);
  }
  // The cached value must drive the overflow mode — no third layout read.
  if (!/overflowY = natural > cap/.test(body)) {
    throw new Error("overflow must derive from the CACHED natural height, not a fresh scrollHeight read");
  }
  if (!/const natural = input\.scrollHeight;/.test(body)) {
    throw new Error("the natural height must be cached exactly once after the height:auto write");
  }
});
