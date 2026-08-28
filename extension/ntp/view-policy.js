// Per-view side-panel nub policy. The hub and conversation reserve the sidebar,
// so the nub remains actionable there. Full iframe views cover the sidebar and
// therefore make the nub absent from layout, hit testing, focus, and the AX tree.
export function sidebarNubPolicy(view) {
  const covered = view === "full";
  return { hidden: covered, inert: covered, disabled: covered };
}

export function applySidebarNubPolicy(toggle, view) {
  if (!toggle) return sidebarNubPolicy(view);
  const policy = sidebarNubPolicy(view);
  toggle.hidden = policy.hidden;
  toggle.disabled = policy.disabled;
  toggle.inert = policy.inert;
  toggle.toggleAttribute?.("hidden", policy.hidden);
  toggle.toggleAttribute?.("inert", policy.inert);
  if (policy.hidden) toggle.setAttribute?.("aria-hidden", "true");
  else toggle.removeAttribute?.("aria-hidden");
  return policy;
}

// Narrow form factor: the expanded 240px rail overflows a 360px viewport
// (a measured 16px horizontal scroll on every hub surface — UX-AUDIT-2026-08-28
// UX-004), so below the 600px breakpoint the rail auto-collapses to its
// existing 60px icon rail. The auto state is form-factor-driven and is never
// persisted — leaving the narrow width restores the user's own last choice.
export const SIDEBAR_NARROW_QUERY = "(max-width: 599.98px)";

export function sidebarWidthPolicy({ narrow, persistedCollapsed }) {
  const collapsed = narrow === true ? true : persistedCollapsed === true;
  return { collapsed, persist: narrow !== true };
}
