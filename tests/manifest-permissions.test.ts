// tests/manifest-permissions.test.ts — CAP-FB-20260831-BOOT-PERMS-OPTIONAL-01
//
// REVERSES CAP-FB-20260831-OPTIONAL-PERMISSION-OMITTED-01's lint.
//
// Owner feedback (2026-08-31): an enterprise policy that blocks fontSettings /
// proxy / tts / declarativeNetRequest breaks a FRESH INSTALL when those four are
// in the REQUIRED `permissions` array (Chrome refuses the install / disables the
// extension), and some are ChromeOS-only. The boot set must be the minimum an
// install needs; every capability permission is optional + JIT (the established
// model). So the four move to `optional_permissions`: install no longer demands
// them, and each backing tool group already fails closed with the structured
// permission-denial card when its permission is absent (see chrome-tools-t9 for
// proxy/fontSettings/tts and chrome-tools-t10 for declarativeNetRequest).
//
// An enterprise-blocked grant then simply fails closed with a clear message
// instead of blocking install. (Chrome may still emit a load-time "cannot be
// listed as optional" notice for a given permission on a given platform; that is
// harmless noise — the extension still loads, and the tool degrades gracefully.
// The install is the load-bearing fix.)
// @ts-nocheck — chrome stubs are intentionally dynamic.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { CAPABILITIES } from "../extension/lib/capabilities.js";

// The four permissions the owner's managed profile blocks / that are ChromeOS-
// only: they must NEVER be install-required.
const ENTERPRISE_BLOCKABLE = ["fontSettings", "proxy", "tts", "declarativeNetRequest"];
// The minimal boot set an install genuinely needs (the scheduler, the OPFS
// store, the side panel, the offscreen host). Everything else is optional + JIT.
const BOOT_SET = ["alarms", "offscreen", "sidePanel", "storage"];

function readManifest() {
  return JSON.parse(Deno.readTextFileSync(new URL("../extension/manifest.json", import.meta.url)));
}

Deno.test("manifest lint: enterprise-blockable permissions are NOT install-required (RED on the pre-reversal manifest)", () => {
  const mf = readManifest();
  const permissions = mf.permissions ?? [];
  const stillRequired = ENTERPRISE_BLOCKABLE.filter((p) => permissions.includes(p));
  assertEquals(stillRequired, [], `these break a managed install when required — move them to optional_permissions: ${stillRequired.join(", ")}`);
});

Deno.test("manifest lint: enterprise-blockable permissions ARE optional (JIT-requested when their tool group is used)", () => {
  const mf = readManifest();
  const optional = mf.optional_permissions ?? [];
  for (const p of ENTERPRISE_BLOCKABLE) {
    assert(optional.includes(p), `${p} must be in optional_permissions so install no longer demands it`);
  }
});

Deno.test("manifest lint: the install-required boot set stays minimal (only the boot-critical permissions)", () => {
  const mf = readManifest();
  const permissions = mf.permissions ?? [];
  // Every required permission is boot-critical (no capability permission leaks
  // into the install prompt).
  for (const p of permissions) {
    assert(BOOT_SET.includes(p), `${p} is required at install but is not boot-critical — capability permissions must be optional + JIT`);
  }
  // The boot set itself is present.
  for (const p of BOOT_SET) {
    assert(permissions.includes(p), `${p} is boot-critical and must stay in install-time permissions`);
  }
});

Deno.test("manifest lint: no permission is both required and optional (Chrome would reject the overlap)", () => {
  const mf = readManifest();
  const required = new Set(mf.permissions ?? []);
  const overlap = (mf.optional_permissions ?? []).filter((p) => required.has(p));
  assertEquals(overlap, [], `permissions listed as both required and optional: ${overlap.join(", ")}`);
});

Deno.test("capability lint: each enterprise-blockable capability is runtime-requestable, not install-required", () => {
  // The inverse of the pre-reversal check: a capability backed by one of the
  // four must NOT have all its permissions in the install set — it is granted
  // JIT from the owner's gesture and its Settings row shows Enable, not "Granted
  // at install". (isRequiredCapability reads the manifest dynamically, so this
  // is the manifest-level guarantee that keeps that path honest.)
  const mf = readManifest();
  const required = new Set(mf.permissions ?? []);
  for (const cap of CAPABILITIES) {
    const perms = cap.permissions ?? [];
    if (perms.some((p) => ENTERPRISE_BLOCKABLE.includes(p))) {
      assert(!perms.every((p) => required.has(p)),
        `${cap.id} is backed by an enterprise-blockable permission but is still fully install-covered — it must be optional + JIT`);
    }
  }
});
