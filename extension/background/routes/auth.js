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
  // Named so the route error classifier can say what this IS (a surface
  // authorization refusal) instead of letting its text trip the provider-AUTH
  // heuristics and blame the API key (P0 2026-09-02, pek9).
  const e = new Error("provider credential routes are restricted to the Settings surface");
  e.name = "SettingsSurfaceRequiredError";
  throw e;
}
