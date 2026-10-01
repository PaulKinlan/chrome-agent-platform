// scripts/stubs/vercel-oidc-stub.mjs
// A minimal stub replacing @vercel/oidc in store builds
// (chrome-agent-platform-9epn.7).

export class VercelOidcDisabledError extends Error {
  constructor(message = "@vercel/oidc is disabled in store builds") {
    super(message);
    this.name = "VercelOidcDisabledError";
    this.code = "vercel_oidc_disabled_in_extension";
  }
}

export class AccessTokenMissingError extends Error {}
export class RefreshAccessTokenFailedError extends Error {}
export function getContext() {
  throw new VercelOidcDisabledError();
}
export async function getVercelOidcToken() {
  throw new VercelOidcDisabledError();
}
export function getVercelOidcTokenSync() {
  throw new VercelOidcDisabledError();
}
export async function getVercelToken() {
  throw new VercelOidcDisabledError();
}
