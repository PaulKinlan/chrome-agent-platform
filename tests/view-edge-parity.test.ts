import { assertEquals } from "jsr:@std/assert@1";
import { viewEdgeParity } from "../scripts/lib/view-edge-parity.ts";

const wide = { artifacts: 235, directory: 235, settings: 230, hostWidth: 1430, settingsWidth: 1420, contentMax: 1040 };
const narrow = { artifacts: 40, directory: 40, settings: 40, hostWidth: 1014, settingsWidth: 1004, contentMax: 1040 };

Deno.test("z4gg: in-page browse aligns, Settings' nested scrollport has a measured five-pixel inset", () => {
  assertEquals(viewEdgeParity(wide), { inPageAligned: true, settingsAccounted: true, expectedSettingsInset: 5 });
  assertEquals(viewEdgeParity(narrow), { inPageAligned: true, settingsAccounted: true, expectedSettingsInset: 0 });
});

Deno.test("i8ii: a hidden or absent browse host cannot establish Settings parity", () => {
  for (const hostWidth of [0, null]) {
    assertEquals(viewEdgeParity({ ...wide, hostWidth }),
      { inPageAligned: false, settingsAccounted: false, expectedSettingsInset: null });
  }
});

Deno.test("z4gg: changing Artifacts alone REDs browse parity, even if Settings stays within its known inset", () => {
  assertEquals(viewEdgeParity({ ...wide, artifacts: 36 }).inPageAligned, false);
  assertEquals(viewEdgeParity({ ...narrow, artifacts: 25 }).inPageAligned, false);
});

Deno.test("z4gg: Settings drift and a missing or invalid edge cannot be excused as an iframe inset", () => {
  assertEquals(viewEdgeParity({ ...wide, settings: 225 }).settingsAccounted, false);
  assertEquals(viewEdgeParity({ ...wide, settings: null }).settingsAccounted, false);
  assertEquals(viewEdgeParity({ ...wide, settingsWidth: 0 }).settingsAccounted, false);
  assertEquals(viewEdgeParity({ ...wide, directory: null }).inPageAligned, false);
});
