// extension/background/routes/auth.js — route authorization helpers.

import { isRouteWithinSettingsSession } from "../../lib/settings-session.js";

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

function throwSettingsSessionRequired() {
  const e = new Error("route is restricted to the Settings surface");
  e.name = "SettingsSurfaceRequiredError";
  throw e;
}

/**
 * IN-HUB SETTINGS SESSION authorization (chrome-agent-platform-8v5l.2):
 * Passes only when `context` carries a verified `settingsSession` that:
 *   1. belongs to an extension principal (`principal === "extension"`),
 *   2. is unexpired (`now < settingsSession.expiresAt`),
 *   3. matches the browser-attested `context.documentId`, and
 *   4. authorizes `route` within the session's scopes.
 *
 * Never widens `requireSettingsSender` or upgrades `context.principal`.
 */
export function requireSettingsSession(context, route, options = {}) {
  if (!context || typeof context !== "object") {
    throwSettingsSessionRequired();
  }
  if (context.principal != null && context.principal !== "extension") {
    throwSettingsSessionRequired();
  }
  const session = context.settingsSession;
  if (!session || typeof session !== "object") {
    throwSettingsSessionRequired();
  }
  if (typeof route !== "string" || route.length === 0) {
    throwSettingsSessionRequired();
  }

  // Document binding check (m1): session must match browser-attested context.documentId.
  const contextDocId = typeof context.documentId === "string" ? context.documentId : "";
  if (
    !contextDocId ||
    typeof session.documentId !== "string" ||
    session.documentId !== contextDocId
  ) {
    throwSettingsSessionRequired();
  }

  // Expiry check (m2): session must be strictly unexpired.
  const nowFn = typeof options?.now === "function" ? options.now : () => Date.now();
  const currentNow = nowFn();
  if (
    typeof session.expiresAt !== "number" ||
    !Number.isFinite(session.expiresAt) ||
    !(currentNow < session.expiresAt)
  ) {
    throwSettingsSessionRequired();
  }

  // Scope / route check (m3): route must be authorized by the session's scopes.
  if (!isRouteWithinSettingsSession(session, route, options?.allowedRoutes)) {
    throwSettingsSessionRequired();
  }
}

/**
 * Combined Settings surface guard for routes explicitly admitted to in-hub
 * Settings sessions: passes if `context.principal === "owner-options"` OR
 * `requireSettingsSession(context, route, options)` succeeds.
 */
export function requireSettingsSurface(context, route, options = {}) {
  if (context?.principal === "owner-options") return;
  requireSettingsSession(context, route, options);
}
