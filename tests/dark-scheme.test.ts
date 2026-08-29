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
  const components = read("extension/shared/components.js");
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

Deno.test("dark-scheme: primary pages declare the color-scheme meta", () => {
  for (const page of [
    "extension/ntp/ntp.html",
    "extension/sidepanel/sidepanel.html",
    "extension/options/options.html",
    "extension/artifact/artifact.html",
    "extension/artifacts/index.html",
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
  // components.js: the preview panel canvas and the count badge.
  const components = read("extension/shared/components.js");
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
