// tests/manifest-permissions.test.ts — CAP-FB-20260831-OPTIONAL-PERMISSION-OMITTED-01
//
// Chrome silently OMITS permissions that cannot be listed as optional at load
// ("Permission 'X' cannot be listed as optional. This permission will be
// omitted."). fontSettings / proxy / tts / declarativeNetRequest are only
// grantable at INSTALL. Before this fix the manifest listed them as optional,
// so the Settings rows backed by them could never actually grant — the UI lied.
// The fix moves them to install-time `permissions` (always-on, honest) and the
// Settings renderer already skips install-granted capabilities.
// @ts-nocheck — chrome stubs are intentionally dynamic.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { CAPABILITIES } from "../extension/lib/capabilities.js";

const INSTALL_ONLY = ["fontSettings", "proxy", "tts", "declarativeNetRequest"];

function readManifest() {
  return JSON.parse(Deno.readTextFileSync(new URL("../extension/manifest.json", import.meta.url)));
}

Deno.test("manifest lint: install-only permissions are never listed as optional (RED on the pre-fix manifest)", () => {
  const mf = readManifest();
  const optional = mf.optional_permissions ?? [];
  const overlap = INSTALL_ONLY.filter((p) => optional.includes(p));
  assertEquals(overlap, [], `Chrome omits these from optional_permissions — they must not be listed there: ${overlap.join(", ")}`);
});

Deno.test("manifest lint: install-only permissions are granted at install", () => {
  const mf = readManifest();
  const permissions = mf.permissions ?? [];
  for (const p of INSTALL_ONLY) {
    assert(permissions.includes(p), `${p} must be in install-time permissions (Chrome cannot grant it at runtime)`);
  }
});

Deno.test("manifest lint: install-granted capabilities render NO optional row in Settings", () => {
  // renderPermissions() skips any capability whose permissions are all in the
  // mandatory (install) set — a row would be a lie because Turn off / Enable
  // cannot work for an install-only permission. Every capability backed by an
  // install-only permission must therefore be fully install-covered.
  const mf = readManifest();
  const mandatory = new Set(mf.permissions ?? []);
  for (const cap of CAPABILITIES) {
    const perms = cap.permissions ?? [];
    if (perms.some((p) => INSTALL_ONLY.includes(p))) {
      assert(perms.every((p) => mandatory.has(p)),
        `${cap.id} mixes install-only and optional permissions (${perms.join(", ")}) — the Settings row would be dishonest`);
    }
  }
});
