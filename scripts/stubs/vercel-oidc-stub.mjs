// scripts/stubs/vercel-oidc-stub.mjs
// A minimal stub replacing @vercel/oidc in store builds
// (chrome-agent-platform-9epn.7).

export class AccessTokenMissingError extends Error {}
export class RefreshAccessTokenFailedError extends Error {}
export function getContext() { return {}; }
export async function getVercelOidcToken() { return ""; }
export function getVercelOidcTokenSync() { return ""; }
export async function getVercelToken() {
  throw new Error("@vercel/oidc is disabled in store builds");
}
