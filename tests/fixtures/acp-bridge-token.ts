// tests/fixtures/acp-bridge-token.ts — the ONE way an in-repo test authenticates to
// the ACP bridge (chrome-agent-platform-jsjy).
//
// WHY THIS EXISTS: the bridge now REQUIRES a shared secret on every upgrade, loopback
// included, because a local process sends no Origin and iadt's origin guard admits that
// by design. Every test that constructs a bridge (createAcpServer) or connects to one
// (AcpClient, raw WebSocket) therefore has to name a secret — the suites used to rely on
// the unauthenticated loopback default that this change removes. Threading the same
// literal through one exported constant keeps that mechanical, greppable and honest
// instead of scattering a magic string per file.
//
// It is deliberately NOT the operator's persisted token: tests must never read or write
// $XDG_CONFIG_HOME/cap-acp/bridge-token (the default-auth test in
// tests/acp-bridge-security.test.ts covers that path with its own scratch config dir).

/** The shared secret every in-repo bridge test uses. */
export const TEST_BRIDGE_TOKEN = "cap-test-bridge-token";

/** Args to give a spawned `deno run scripts/acp-bridge.ts …` so it requires this secret. */
export const TEST_BRIDGE_TOKEN_ARGS = ["--token", TEST_BRIDGE_TOKEN] as const;

/**
 * A loopback bridge URL carrying the test secret, and optionally a harness override.
 * Use this instead of hand-writing `ws://127.0.0.1:${port}/acp…` in a test: a URL
 * without the token is refused with 403 and reads as a broken suite.
 *
 * @param port the bound bridge port
 * @param harness optional `?harness=` value
 * @returns the authenticated WebSocket URL
 */
export function authedAcpUrl(port: number, harness?: string): string {
  const base = `ws://127.0.0.1:${port}/acp?token=${encodeURIComponent(TEST_BRIDGE_TOKEN)}`;
  return harness ? `${base}&harness=${encodeURIComponent(harness)}` : base;
}

/** The token as an HTTP header-free query suffix, for raw upgrade helpers. */
export function tokenQuery(): string {
  return `token=${encodeURIComponent(TEST_BRIDGE_TOKEN)}`;
}
