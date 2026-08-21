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
