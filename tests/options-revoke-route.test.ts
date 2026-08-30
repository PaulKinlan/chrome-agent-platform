// CAP-FB-20260830-SETTINGS-REVOKE-VIA-SW-01 — the Settings "Turn off" button
// must go through the service worker's `capability.revoke` route (owner
// approval dialog + storage snapshot + scripting's enrollment tombstones), never
// the page-realm `revokeCapability`, which only removes the permission and
// leaves every enrolled origin's bridge script registered. A grep guard in the
// style of tests/settings-strings-audit.test.ts.
import { assert } from "jsr:@std/assert@1";

const source = await Deno.readTextFile(new URL("../extension/options/options.js", import.meta.url));

Deno.test("options.js: never imports the page-realm revokeCapability", () => {
  const importBlock = source.match(/import\s*\{[^}]*\}\s*from\s*["']\.\.\/lib\/capabilities\.js["']/)?.[0] ?? "";
  assert(importBlock.length > 0, "options.js imports from ../lib/capabilities.js (requestCapability stays in the page)");
  assert(!/\brevokeCapability\b/.test(importBlock), "options.js must not import revokeCapability — Turn off goes through the SW route");
  assert(!/\brevokeCapability\s*\(/.test(source), "options.js must not call revokeCapability() in the page realm");
});

Deno.test("options.js: Turn off sends capability.revoke to the service worker", () => {
  assert(/type:\s*"capability\.revoke"/.test(source), "options.js must send { type: \"capability.revoke\" }");
  assert(/action:\s*"capability\.revoke"/.test(source), "the revoke runs through runOwnerApprovedMutation with action \"capability.revoke\"");
});
