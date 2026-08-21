// CAP-FB-20260821-HUB-360-OVERFLOW-01: the hub overflows horizontally at 360px
// because the fixed 240px rail + the composer's fixed mic/attach/send controls +
// the .main-wrap 24px gutters exceed the content column. The fix is a narrow
// media query that lets the composer row wrap + the textarea shrink + reclaims
// the gutters — WITHOUT touching the covered-nub / full-view state machine.
import { assert } from "jsr:@std/assert@1";

Deno.test("hub 360 overflow: narrow media query wraps the composer row + shrinks the textarea + reclaims gutters", async () => {
  const root = new URL("..", import.meta.url);
  const html = await Deno.readTextFile(new URL("extension/ntp/ntp.html", root));
  const components = await Deno.readTextFile(new URL("extension/shared/components.js", root));

  // The composer row must be allowed to wrap at narrow widths.
  assert(
    /@media \(max-width:\s*600px\)[\s\S]*?agent-composer \.composer \.row\s*\{\s*flex-wrap:\s*wrap;\s*\}/.test(components),
    "the narrow media query must wrap the composer row",
  );
  assert(
    /agent-composer \.composer \.send\s*\{\s*margin-inline-start:\s*auto;\s*\}/.test(components),
    "the send button must align to the end of its wrapped line",
  );
  assert(
    /agent-composer \.composer textarea\s*\{\s*min-width:\s*0;\s*\}/.test(components),
    "the textarea must drop its intrinsic 20-col min-width",
  );

  // The .main-wrap must reclaim horizontal gutters at narrow widths.
  assert(
    /@media \(max-width:\s*600px\)[\s\S]*?\.main-wrap\s*\{\s*padding-inline:\s*12px;\s*\}/.test(html),
    "the narrow media query must reduce the .main-wrap inline padding",
  );
});

Deno.test("hub 360 overflow: covered-nub / full-view state machine is untouched", async () => {
  const root = new URL("..", import.meta.url);
  const html = await Deno.readTextFile(new URL("extension/ntp/ntp.html", root));

  // The covered-nub/full-view authority (sidebar + edge nub hidden under a full
  // in-context view) must remain intact — the fix must not auto-collapse or
  // re-show the rail.
  assert(
    /body\.full-view-open \.side,\s*body\.full-view-open \.side-toggle\s*\{\s*visibility:\s*hidden;\s*pointer-events:\s*none;\s*\}/.test(html),
    "the full-view-open covered-nub rule must remain intact",
  );
  // No media query may force the rail collapsed (that state is owner-toggled via the nub).
  assert(
    !/@media[^{]*\{[\s\S]*?\.side\s*\{\s*inline-size:\s*60px/.test(html),
    "no media query may auto-collapse the sidebar",
  );
});
