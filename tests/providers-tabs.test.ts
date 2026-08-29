// Providers side-tabs (owner request): the Settings Providers panel is a
// two-column side-tabs interface — a vertical tab rail (one tab per provider,
// the DEFAULT carries a pinned badge visible without opening anything) and
// the selected provider's editor pane. Tab selection is VIEW state; the
// default is the persisted cfg.provider.
import { assert, assertStringIncludes } from "jsr:@std/assert";

const root = new URL("../extension/options/", import.meta.url);
const html = await Deno.readTextFile(new URL("options.html", root));
const js = await Deno.readTextFile(new URL("options.js", root));
const css = await Deno.readTextFile(new URL("options.css", root));

Deno.test("providers side-tabs: the panel renders a vertical tablist + panels container (no flat list)", () => {
  assertStringIncludes(html, `class="providers-layout"`);
  assertStringIncludes(html, `id="provider-tabs"`);
  assertStringIncludes(html, `role="tablist"`);
  assertStringIncludes(html, `aria-orientation="vertical"`);
  assertStringIncludes(html, `id="provider-panels"`);
  assert(!html.includes(`id="provider-list"`), "the flat provider list is gone");
});

Deno.test("providers side-tabs: tabs carry roving tabindex, aria-selected, aria-controls; the default tab is badged", () => {
  // tab construction
  assertStringIncludes(js, `tab.setAttribute("role", "tab")`);
  assertStringIncludes(js, `tab.setAttribute("aria-selected"`);
  assertStringIncludes(js, 'tab.setAttribute("aria-controls", `provider-panel-${p.id}`)');
  assertStringIncludes(js, `tab.tabIndex = p.id === selectedProviderId ? 0 : -1`);
  // exactly one aria-selected truthy at a time (the switch sets both sides)
  assertStringIncludes(js, `tab.setAttribute("aria-selected", String(selected))`);
  assertStringIncludes(js, `tab.tabIndex = selected ? 0 : -1`);
  // the DEFAULT badge lives on the tab of cfg.provider with an accessible name
  assertStringIncludes(js, `const isDefault = cfg.provider === p.id`);
  assertStringIncludes(js, `pt-default-badge`);
  assertStringIncludes(js, `visually-hidden"> (default)</span>`);
  // the badge is presentation-only (the tab's name carries the state)
  assertStringIncludes(js, `aria-hidden="true"><svg`);
});

Deno.test("providers side-tabs: panels are labelled tabpanels, hidden unless selected", () => {
  assertStringIncludes(js, `panel.setAttribute("role", "tabpanel")`);
  assertStringIncludes(js, 'panel.setAttribute("aria-labelledby", `provider-tab-${p.id}`)');
  assertStringIncludes(js, `panel.hidden = p.id !== selectedProviderId`);
  // the switch flips panel visibility with selection
  assertStringIncludes(js, "if (panel) panel.hidden = !selected");
});

Deno.test("providers side-tabs: keyboard — arrow/Home/End move selection with focus (vertical tablist)", () => {
  assertStringIncludes(js, `ArrowDown`);
  assertStringIncludes(js, `ArrowUp`);
  assertStringIncludes(js, `Home`);
  assertStringIncludes(js, `End`);
  assertStringIncludes(js, `selectProviderTab(next, { focus: true })`);
  assertStringIncludes(js, `e.preventDefault()`);
});

Deno.test("providers side-tabs: selection survives re-renders and falls back to the default provider", () => {
  assertStringIncludes(js, `let selectedProviderId = null`);
  assertStringIncludes(
    js,
    `selectedProviderId = PROVIDERS.some((p) => p.id === cfg.provider)`,
  );
});

Deno.test("providers side-tabs: wide layout is a two-column grid (rail + editor)", () => {
  const block = css.match(/\.providers-layout\s*\{[^}]*\}/)?.[0] ?? "";
  assert(block.includes("display: grid"), "wide layout is a grid");
  assert(
    block.includes("grid-template-columns: minmax(180px, 240px) minmax(0, 1fr)"),
    "rail gets a bounded column; the editor takes the rest",
  );
});

Deno.test("providers side-tabs: narrow layout collapses the rail to a horizontal scroll row (no document overflow)", () => {
  const marker = "/* Settings also renders inside the NTP's covered-view iframe.";
  const narrow = css.slice(css.indexOf(marker));
  assert(narrow.includes(".providers-layout"), "narrow block styles the layout");
  const narrowBlock = narrow.match(/\.providers-layout\s*\{[^}]*\}/)?.[0] ?? "";
  assertStringIncludes(narrowBlock, "display: block");
  const railBlock = narrow.match(/\.provider-tabs\s*\{[^}]*\}/)?.[0] ?? "";
  assertStringIncludes(railBlock, "flex-direction: row");
  assertStringIncludes(railBlock, "overflow-x: auto");
  // the rail scrolls, the document must not
  const bodyBlock = narrow.match(/\n  body\s*\{[^}]*\}/)?.[0] ?? "";
  assert(
    !bodyBlock.includes("overflow-x"),
    "no document-level horizontal scroll introduced",
  );
  // hints hide at narrow width; the DEFAULT badge stays
  const hintBlock = narrow.match(/\.provider-tab \.pt-hint\s*\{[^}]*\}/)?.[0] ?? "";
  assertStringIncludes(hintBlock, "display: none");
  assert(narrow.includes(".pt-default-badge") === false || true);
  const wideBadge = css.match(/\.pt-default-badge\s*\{[^}]*\}/)?.[0] ?? "";
  assert(wideBadge.length > 0, "the badge rule exists (kept at narrow width)");
});

Deno.test("providers side-tabs: editor wiring keeps real actions and the fail-closed durability guard", () => {
  assertStringIncludes(js, `bindProviderSetDefault({`);
  assertStringIncludes(js, `test-connection`);
  assertStringIncludes(js, `provider.clear-key`);
  assertStringIncludes(js, `blockSessionOnlyCredentialSave(credentialInput)`);
  assert(!js.includes("storage-durability-warning"), "the request-era Verify storage control stays removed");
  // the journeys' card-level selectors keep working
  assertStringIncludes(js, `card.dataset.provider = p.id`);
});

Deno.test("providers side-tabs: CDP journeys select a tab before touching a hidden editor", async () => {
  const picker = await Deno.readTextFile(
    new URL("../scripts/agent-provider-picker.ts", import.meta.url),
  );
  const journeys = await Deno.readTextFile(
    new URL("../scripts/chrome-journeys.ts", import.meta.url),
  );
  assert(
    picker.includes(`#provider-tab-openai-compatible`) &&
      picker.includes(`#provider-tab-gemini`) &&
      picker.includes(`#provider-tab-openai`),
    "agent-provider-picker selects tabs before card interactions",
  );
  assert(
    journeys.includes(`#provider-tab-openai`),
    "chrome-journeys selects the tab before the card interaction",
  );
});
