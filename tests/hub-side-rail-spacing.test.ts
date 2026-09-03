// chrome-agent-platform-suw3 (owner report 2026-09-03): the hub's left rail
// (#side) is a flex column whose children are bare <section class="side-section">
// elements; the global `section { margin-bottom: 32px; }` (which spaces the main
// column's grid sections) stacked 32px gaps on top of the rail's own flex gap.
// FIX: a rail-scoped override `#side section { margin-bottom: 0; }` — flex-gap is
// the only rail spacing. The bare rule must NOT be deleted (the main column's
// grid sections rely on it for vertical rhythm).
// RED if reintroduced: deleting the override puts the 32px rail gaps back;
// deleting the bare rule silently squashes the main-column sections together.
import { assert } from "jsr:@std/assert@1";

Deno.test("hub side rail spacing: #side sections carry no margin-bottom (flex-gap only)", async () => {
  const root = new URL("..", import.meta.url);
  const html = await Deno.readTextFile(new URL("extension/ntp/ntp.html", root));

  assert(
    /#side section\s*\{\s*margin-bottom:\s*0;\s*\}/.test(html),
    "#side section must be overridden to margin-bottom: 0 so the rail's flex gap is the only spacing between its sections",
  );
});

Deno.test("hub side rail spacing: the main-column section rhythm is untouched", async () => {
  const root = new URL("..", import.meta.url);
  const html = await Deno.readTextFile(new URL("extension/ntp/ntp.html", root));

  assert(
    /section\s*\{\s*margin-bottom:\s*32px;\s*\}/.test(html),
    "the bare section rule must remain — the hub main column's grid sections rely on it for vertical rhythm",
  );
});
