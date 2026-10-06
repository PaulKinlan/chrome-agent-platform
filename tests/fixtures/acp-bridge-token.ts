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

// NOTE (delta review, finding 3): this file used to also export authedAcpUrl, TEST_BRIDGE_TOKEN_ARGS
// and tokenQuery — all three had ZERO call sites, because each suite that needed a URL builder defined
// a small local authedEndpoint() with the harness parameter it actually wanted. Dead exports inside a
// "single source of truth" are worse than none: they invite a reader to believe the shapes are
// centralised when they are not. What IS centralised and used by every suite is the token, above.
