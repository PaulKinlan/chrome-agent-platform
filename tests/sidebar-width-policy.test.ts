// UX-AUDIT-2026-08-28 UX-004 + UX-005: the narrow-width sidebar auto-collapse
// policy and the honest gated first-run CTA. The policy is pure (unit-tested);
// the surface wiring is pinned by source contracts so a regression in the
// listener or the persist-skip cannot land silently.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { readFileSync } from "node:fs";
import {
  SIDEBAR_NARROW_QUERY,
  sidebarWidthPolicy,
} from "../extension/ntp/view-policy.js";

Deno.test("sidebar width policy: a narrow viewport forces the icon rail and never persists the auto state", () => {
  assertEquals(sidebarWidthPolicy({ narrow: true, persistedCollapsed: false }), {
    collapsed: true,
    persist: false,
  });
  // Even a saved "expanded" choice is overridden while narrow — the expanded
  // rail is what overflows a 360px viewport.
  assertEquals(sidebarWidthPolicy({ narrow: true, persistedCollapsed: true }), {
    collapsed: true,
    persist: false,
  });
});

Deno.test("sidebar width policy: leaving the narrow width restores the user's own last choice", () => {
  // Wide restores are not form-factor overrides, so persist stays true (the
  // write is a no-op restatement of the saved choice, never a silent override).
  assertEquals(sidebarWidthPolicy({ narrow: false, persistedCollapsed: true }), {
    collapsed: true,
    persist: true,
  });
  assertEquals(sidebarWidthPolicy({ narrow: false, persistedCollapsed: false }), {
    collapsed: false,
    persist: true,
  });
});

Deno.test("sidebar width policy: the breakpoint matches the audited overflow band (below 600px)", () => {
  assertEquals(SIDEBAR_NARROW_QUERY, "(max-width: 599.98px)");
});

Deno.test("ntp wiring: the width policy drives the rail without persisting auto changes", () => {
  const ntp = readFileSync(new URL("../extension/ntp/ntp.js", import.meta.url), "utf8");
  assertStringIncludes(ntp, "SIDEBAR_NARROW_QUERY");
  assertStringIncludes(ntp, 'addEventListener?.("change", applySidebarForWidth)');
  assertStringIncludes(ntp, "if (auto) return; // form-factor state");
  // The restore path goes THROUGH the policy so a narrow viewport collapses
  // even when the saved choice was expanded.
  assertStringIncludes(ntp, "applySidebarForWidth();");
  assertStringIncludes(ntp, "persistedSidebarCollapsed = s?.[SIDEBAR_KEY] === true;");
});

Deno.test("ntp wiring: the narrow TOGGLE routes through the policy — the manual expansion is the off-canvas overlay, never the inline rail", () => {
  const ntp = readFileSync(new URL("../extension/ntp/ntp.js", import.meta.url), "utf8");
  // The click handler branches on the breakpoint BEFORE touching state.
  assertStringIncludes(ntp, "if (narrowSidebarMq?.matches === true) {");
  assertStringIncludes(ntp, "runRouteUpdate(() => setSidebarOverlay(!sidebarOverlayOpen))");
  // The overlay is narrow-only, transient, and closable (scrim + Escape +
  // leaving the breakpoint all close it).
  assertStringIncludes(ntp, "function setSidebarOverlay(open)");
  assertStringIncludes(ntp, "const next = open === true && (narrowSidebarMq?.matches === true);");
  assertStringIncludes(ntp, "sidebarOverlayOpen = next;");
  // REVISE 2: the drawer shows the FULL nav — the collapsed class comes OFF
  // while the overlay is open and the captured rail state is restored on
  // close (transient: the collapsed setter must NOT fight the open drawer).
  assertStringIncludes(ntp, "next ? false : ((narrowSidebarMq?.matches === true) ? sidebarOverlayWasCollapsed : sidebarCollapsed)");
  assertStringIncludes(ntp, "sidebarOverlayWasCollapsed = sidebarCollapsed;");
  assertStringIncludes(ntp, "if (!sidebarOverlayOpen) side.classList.toggle(\"collapsed\", collapsed);");
  assertStringIncludes(ntp, 'sideScrim.addEventListener("click"');
  assertStringIncludes(ntp, 'event.key === "Escape" && sidebarOverlayOpen');
  assertStringIncludes(ntp, "if (!narrow && sidebarOverlayOpen) setSidebarOverlay(false);");
  // The scrim is a real element in the light DOM after the rail.
  assertStringIncludes(ntp, 'sideScrim.className = "side-scrim";');
  assertStringIncludes(ntp, "side.after(sideScrim);");
});

Deno.test("ntp surface: the overlay layout is policy-sanctioned at narrow width (off-canvas, zero overflow)", () => {
  const html = readFileSync(new URL("../extension/ntp/ntp.html", import.meta.url), "utf8");
  // The overlay rules live INSIDE the same breakpoint as the policy.
  const overlayBlock = html.slice(html.indexOf("@media (max-width: 599.98px)"));
  assert(overlayBlock.includes(".side.overlay"));
  assert(overlayBlock.includes("position: fixed;"));
  assert(overlayBlock.includes("inline-size: min(240px, 78vw);"));
  assert(overlayBlock.includes(".side-scrim"));
});

Deno.test("first-run banner: one real action, no aria-disabled gate, dismiss last", () => {
  const components = readFileSync(
    new URL("../extension/shared/components.js", import.meta.url),
    "utf8",
  );
  const guideStart = components.indexOf("class FirstRunGuide extends Component");
  const guideEnd = components.indexOf('customElements.define("first-run-guide"', guideStart);
  const guide = components.slice(guideStart, guideEnd);
  // The single action is a plain enabled button (no gate to describe).
  assertStringIncludes(guide, '<button class="primary connect-model" type="button">Connect a model</button>');
  assert(!guide.includes("aria-disabled"), "no gated CTA remains in the banner");
  assert(!guide.includes("seed-status"), "no gate status line remains in the banner");
  // The dismiss control comes AFTER the action in the template (tab order).
  assert(guide.indexOf('class="dismiss"') > guide.indexOf('class="primary connect-model"'));
  // focusNextAction lands on the one action.
  assertStringIncludes(guide, 'this._root.querySelector(".connect-model")?.focus();');
});
