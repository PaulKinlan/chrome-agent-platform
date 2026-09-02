// tests/options-permissions-groups.test.ts —
// CAP-FB-20260830-SETTINGS-HOOKS-PERMISSIONS-TABLES-01.
//
// Settings → Permissions renders CAPABILITIES as a grouped list (Browsing ·
// Content · System). A capability without a group would silently fall into
// whichever bucket the renderer defaults to, so the group is declared on every
// entry and checked here. Falsification: remove `group` from one capability →
// RED; restore → GREEN.

import { CAPABILITIES, CAPABILITY_GROUPS } from "../extension/lib/capabilities.js";

Deno.test("permissions: the three capability groups are declared once, in order", () => {
  const ids = (CAPABILITY_GROUPS ?? []).map((g: any) => g.id);
  if (ids.join(",") !== "browsing,content,system") {
    throw new Error(`expected groups browsing,content,system — got ${JSON.stringify(ids)}`);
  }
  for (const g of CAPABILITY_GROUPS as any[]) {
    if (typeof g.label !== "string" || !g.label.trim()) throw new Error(`group ${g.id} needs a label`);
    if (typeof g.hint !== "string" || !g.hint.trim()) throw new Error(`group ${g.id} needs a hint`);
  }
});

Deno.test("permissions: every capability declares a group from the allowed set", () => {
  const allowed = new Set((CAPABILITY_GROUPS ?? []).map((g: any) => g.id));
  const missing = (CAPABILITIES as any[]).filter((c) => !allowed.has(c.group)).map((c) => `${c.id}→${c.group}`);
  if (missing.length) {
    throw new Error(`capabilities without a valid group: ${missing.join(", ")}`);
  }
  // Every group has at least one capability — an empty heading is dead UI.
  for (const g of allowed) {
    if (!(CAPABILITIES as any[]).some((c) => c.group === g)) throw new Error(`group ${g} has no capabilities`);
  }
});
