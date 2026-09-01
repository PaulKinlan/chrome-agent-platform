// Semantic contracts for the Settings page's narrow, iframe-safe layout.
import { assert, assertEquals } from "jsr:@std/assert";

const cssUrl = new URL("../extension/options/options.css", import.meta.url);

function rule(source: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert(match, `missing CSS rule for ${selector}`);
  return match[1].replace(/\s+/g, " ").trim();
}

Deno.test("settings responsive layout: the content breakpoint covers 500px and 360px without clipping", async () => {
  const css = await Deno.readTextFile(cssUrl);
  const marker =
    "/* Settings also renders inside the NTP's covered-view iframe.";
  const start = css.indexOf(marker);
  assert(start > -1, "narrow Settings contract marker exists");
  const narrow = css.slice(start);
  const breakpoint = narrow.match(/@media\s*\(max-width:\s*(\d+)px\)/);
  assert(breakpoint, "narrow Settings media query exists");
  const maxWidth = Number(breakpoint[1]);
  for (const width of [500, 360]) {
    assert(width <= maxWidth, `${width}px activates the narrow layout`);
  }

  assert(rule(narrow, "body").includes("flex-direction: column"));
  const side = rule(narrow, ".side");
  assert(side.includes("width: 100%"));
  assert(side.includes("flex: 0 0 auto"));
  assert(side.includes("position: static"));
  assert(side.includes("height: auto"));

  const content = rule(narrow, ".content");
  assert(content.includes("width: 100%"));
  assert(content.includes("max-width: none"));
  assert(content.includes("min-width: 0"));

  assert(rule(narrow, "nav").includes("flex-flow: row wrap"));
  assert(rule(narrow, ".nav-item").includes("min-height: 44px"));
  assert(
    rule(narrow, ".enroll-row").includes(
      "grid-template-columns: minmax(0, 1fr)",
    ),
  );
  assert(
    rule(narrow, ".background-agent-row").includes(
      "grid-template-columns: minmax(0, 1fr)",
    ),
  );
  assert(
    rule(narrow, ".perm-row").includes("grid-template-columns: minmax(0, 1fr)"),
  );

  assertEquals(
    /overflow\s*:\s*(?:hidden|clip)/.test(narrow),
    false,
    "the narrow adaptation must reflow rather than clip Settings content",
  );
});

Deno.test("settings responsive layout: flexible tracks can shrink below intrinsic form content", async () => {
  const css = await Deno.readTextFile(cssUrl);
  assert(rule(css, ".content").includes("min-inline-size: 0"));
  assert(rule(css, ".panel").includes("min-inline-size: 0"));
  assert(rule(css, ".provider-card").includes("min-inline-size: 0"));
  assert(
    rule(css, ".provider-card .fields").includes("minmax(0, 1fr)"),
    "the provider fields use a shrink-safe grid track (single column: API key + Advanced disclosure)",
  );
  assert(
    rule(css, ".toggle-field").includes(
      "grid-template-columns: auto minmax(0, 1fr)",
    ),
    "toggle descriptions can shrink and wrap without widening the document",
  );

  const marker =
    "/* Settings also renders inside the NTP's covered-view iframe.";
  const narrow = css.slice(css.indexOf(marker));
  const stackedGrids = rule(
    narrow,
    ".provider-card .fields,\n  .agent-provider-row,\n  .theme-grid",
  );
  assert(stackedGrids.includes("grid-template-columns: minmax(0, 1fr)"));
});
