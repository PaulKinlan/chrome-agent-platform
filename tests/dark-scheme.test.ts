// UX-003 (docs/UX-AUDIT-2026-08-28.md): the design system must respect
// prefers-color-scheme: dark. The implementation is a light-dark() token layer
// over the single design system in theme.css — NOT a theme switcher (theme
// switching was deliberately removed in 0.2.301).
//
// Provable-fail gate: reverting the theme.css token layer, the meta tags, or
// any of the hardcoded-color fixes below makes these assertions RED.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { join } from "https://deno.land/std@0.208.0/path/mod.ts";

const ROOT = join(import.meta.dirname!, "..");
const read = (p: string) => Deno.readTextFileSync(join(ROOT, p));

const COLOR_TOKENS = [
  "--bg", "--panel", "--panel-2", "--border", "--text", "--muted",
  "--accent", "--accent-hover", "--accent2", "--danger", "--success",
  "--warning", "--btn-fg", "--on-accent-muted",
];

Deno.test("dark-scheme: theme.css opts the root into both schemes", () => {
  const css = read("extension/shared/theme.css");
  assert(
    /color-scheme:\s*light dark/.test(css),
    ":root must declare color-scheme: light dark (UA widgets follow the OS preference)",
  );
});

Deno.test("dark-scheme: every color token has a light-dark() definition", () => {
  const css = read("extension/shared/theme.css");
  const root = css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")));
  for (const token of COLOR_TOKENS) {
    const decls = [...root.matchAll(new RegExp(`${token}:\\s*([^;]+);`, "g"))].map((m) => m[1]);
    assert(
      decls.some((v) => v.includes("light-dark(")),
      `${token} must be declared with light-dark(<light>, <dark>)`,
    );
    // The light fallback (plain hex) must come BEFORE the light-dark()
    // declaration so engines without light-dark() still resolve the light scheme.
    const plain = decls.findIndex((v) => !v.includes("light-dark("));
    const modern = decls.findIndex((v) => v.includes("light-dark("));
    assert(plain !== -1, `${token} keeps a plain light fallback`);
    assert(modern > plain, `${token}: the light-dark() declaration must win (come after the fallback)`);
  }
});

Deno.test("dark-scheme: the on-accent ink aliases route through --btn-fg", () => {
  const css = read("extension/shared/theme.css");
  for (const alias of ["--accent-contrast", "--on-accent", "--accent-ink"]) {
    assert(
      new RegExp(`${alias}:\\s*var\\(--btn-fg\\)`).test(css),
      `${alias} must be var(--btn-fg) so dark flips it together with the accent ink`,
    );
  }
});

Deno.test("dark-scheme: user message surface resolves through the scheme-aware panel chain", () => {
  const css = read("extension/shared/theme.css");
  const components = read("extension/shared/components-conversation.js");
  assert(
    /--secondary-layer:\s*var\(--panel-2\)/.test(css),
    "--secondary-layer must alias --panel-2 instead of falling back to a light surface inside message-bubble",
  );
  assert(
    components.includes(':host([role="user"]) .msg { background:var(--secondary-layer,#efede8); }'),
    "the user bubble must consume the semantic secondary-layer token",
  );
  assert(/--ink:\s*var\(--text\)/.test(css), "message ink must resolve through the scheme-aware --text token");
});

Deno.test("dark-scheme: JSON tree preview text resolves through scheme-aware ink", () => {
  const css = read("extension/shared/theme.css");
  const components = read("extension/shared/components-conversation.js");
  assert(
    /--fg:\s*var\(--text\)/.test(css),
    "--fg must alias --text instead of falling back to near-black inside the dark JSON tree",
  );
  assert(
    components.includes(".tool .tt-preview { color:var(--fg,#1c1a17)"),
    "the tool-response preview must consume the foreground token chain",
  );
});

Deno.test("dark-scheme: primary pages declare the color-scheme meta", () => {
  for (const page of [
    "extension/ntp/ntp.html",
    "extension/sidepanel/sidepanel.html",
    "extension/options/options.html",
    "extension/artifact/artifact.html",
    "extension/artifacts/index.html",
    "extension/sandbox/artifact-preview.html",
  ]) {
    assert(
      read(page).includes('<meta name="color-scheme" content="light dark">'),
      `${page} must declare <meta name="color-scheme" content="light dark">`,
    );
  }
});

Deno.test("dark-scheme: no hardcoded ink/canvas left on dynamic surfaces", () => {
  // ntp.js styled the panel frame white and primary buttons white inline.
  const ntp = read("extension/ntp/ntp.js");
  assert(!ntp.includes('frame.style.background = "#fff"'), "panel frame background must be var(--panel)");
  assert(!ntp.includes('b.style.color = "#fff"'), "primary button ink must be var(--btn-fg)");
  // components: the preview panel canvas and the count badge.
  const components = [
    read("extension/shared/components-core.js"),
    read("extension/shared/components-artifacts.js"),
  ].join("\n");
  assert(
    components.includes("overflow:hidden; background:var(--panel,#fff); }"),
    "preview canvas must be var(--panel)",
  );
  assert(
    !/background:var\(--danger,#b3261e\); color:#fff/.test(components),
    "danger badges must take the scheme-aware ink (var(--btn-fg))",
  );
  // The default-google-blue fallback violated the design identity (no default blue).
  assert(!components.includes("0b57d0"), "no default-blue fallbacks in components");
});

/** The LAST definition of each custom property in docs/theme.css.
 *
 *  theme.css declares every colour token twice by design: a light fallback for
 *  engines without light-dark(), then the light-dark(<light>, <dark>) pair that
 *  wins where it is supported. The last one is therefore the effective one, and
 *  that is what a page using `var(--token)` actually resolves.
 */
function themeTokens(css: string): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const m of css.matchAll(/(--[A-Za-z0-9-]+)\s*:\s*([^;]+);/g)) tokens.set(m[1], m[2].trim());
  return tokens;
}

/** Is this declaration scheme-aware — either a literal light-dark() pair, or a
 *  var(--token) whose EFFECTIVE definition in docs/theme.css is one?
 *
 *  chrome-agent-platform-8mw5l (coord ruling): the assertion this replaces was
 *  `indexHtml.includes("light-dark(")` — a PRESENCE check on the page's text
 *  standing in for a property of the page. A page that takes its surfaces from
 *  theme.css tokens resolves both schemes perfectly and contains no literal, so
 *  the honest test is derivational: follow each adaptable declaration to the
 *  token definition. It keeps its teeth — an undefined token, a token that
 *  resolves to a single colour, or a bare hex/rgb literal are all still RED.
 */
function schemeAwareColour(value: string, tokens: Map<string, string>, where: string): void {
  const trimmed = value.trim();
  // A light-dark() pair counts wherever it sits in the value: `border: 1px solid
  // light-dark(#ddd8d2, #6b6355)` is as scheme-aware as `background: light-dark(…)`.
  if (/light-dark\(/.test(trimmed)) return;
  const referenced = [...trimmed.matchAll(/var\(\s*(--[A-Za-z0-9-]+)\s*(?:,[^)]*)?\)/g)].map((m) => m[1]);
  if (referenced.length) {
    for (const token of referenced) {
      const definition = tokens.get(token);
      assert(definition !== undefined, `${where} uses ${token}, which docs/theme.css does not define`);
      assert(
        /light-dark\(/.test(definition!),
        `${where} uses ${token}, which docs/theme.css defines as a SINGLE colour (${definition}) — it cannot adapt to the scheme`,
      );
    }
    // A literal outside the var() (e.g. `border: 1px solid var(--border) #fff`) is
    // still a theme-blind value, so only the var()s may carry colour.
    const withoutVars = trimmed.replace(/var\(\s*--[A-Za-z0-9-]+\s*(?:,[^)]*)?\)/g, " ");
    assert(
      !/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i.test(withoutVars),
      `${where} hard-codes a colour literal beside its tokens (${trimmed})`,
    );
    return;
  }
  assert(
    false,
    `${where} must adapt to the scheme, with a light-dark() pair or a var(--token) that resolves to one (got "${trimmed}")`,
  );
}

Deno.test("fte5y: docs surfaces resolve light-dark() and contain no stale mock/theme rules", () => {
  // 1. docs/index.html declares color-scheme: light dark and its adaptable
  //    colours reach a light-dark() pair — literally, or through a theme.css
  //    token that is defined as one (8mw5l/coord: derive it, do not grep the text).
  const indexHtml = read("docs/index.html");
  assert(indexHtml.includes("color-scheme: light dark"), "docs/index.html must declare color-scheme: light dark");
  const tokens = themeTokens(read("docs/theme.css"));
  assert(tokens.size > 20, "docs/theme.css must define the colour tokens");
  const adaptable = [
    ...indexHtml.matchAll(/(?:^|[;{\s])(background|background-color|color|border-color|border)\s*:\s*([^;{}]+)/g),
  ].filter((m) => !/^\s*(?:none|0|inherit|initial|unset|transparent)\b/i.test(m[2]));
  assert(adaptable.length >= 3, `docs/index.html must declare its adaptable colours (found ${adaptable.length})`);
  for (const m of adaptable) {
    schemeAwareColour(m[2], tokens, `docs/index.html ${m[1]}`);
  }

  // 2. docs/showcase.css has no hardcoded html[data-theme='sunlit'] or dead --chrome-accent
  const showcaseCss = read("docs/showcase.css");
  assert(!showcaseCss.includes("html[data-theme="), "docs/showcase.css must not contain hardcoded theme-switcher rules");
  assert(!showcaseCss.includes("--chrome-accent:"), "docs/showcase.css must not define dead --chrome-accent token");

  // 3. docs/mock.css is removed (withdrawn mock stylesheet)
  try {
    Deno.statSync(join(ROOT, "docs/mock.css"));
    assert(false, "docs/mock.css must be removed");
  } catch (e) {
    assert(e instanceof Deno.errors.NotFound, "docs/mock.css must not exist");
  }
});

