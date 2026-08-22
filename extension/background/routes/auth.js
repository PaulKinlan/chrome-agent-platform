// extension/background/routes/auth.js — route authorization helpers.

/**
 * OWNER-SURFACE authorization: credential-privileged routes (provider.set,
 * provider.clear-key, provider.test, provider.get, etc.) are restricted to the
 * Settings page (principal="owner-options").
 *
 * Throws if the caller is not the Settings surface.
 */
export function requireSettingsSender(context) {
  if (context?.principal === "owner-options") return;
  throw new Error("provider credential routes are restricted to the Settings surface");
}
