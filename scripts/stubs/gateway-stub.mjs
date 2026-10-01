// scripts/stubs/gateway-stub.mjs
// A minimal stub replacing @ai-sdk/gateway in store builds
// (chrome-agent-platform-9epn.7). Tree-shakes out ~100 KB of unused
// gateway/oidc code from the store service worker and agent worker.

export class GatewayError extends Error {
  constructor(message = "@ai-sdk/gateway is disabled in store builds") {
    super(message);
    this.name = "GatewayError";
  }
}

export class GatewayDisabledError extends GatewayError {
  constructor(message = "@ai-sdk/gateway is disabled in store builds") {
    super(message);
    this.name = "GatewayDisabledError";
    this.code = "gateway_disabled_in_extension";
  }
}

export class GatewayAuthenticationError extends GatewayError {
  constructor(message = "@ai-sdk/gateway is disabled in store builds") {
    super(message);
    this.name = "GatewayAuthenticationError";
  }
}

export class GatewayInvalidRequestError extends GatewayError {}
export class GatewayRateLimitError extends GatewayError {}
export class GatewayModelNotFoundError extends GatewayError {}
export class GatewayInternalServerError extends GatewayError {}
export class GatewayFailedDependencyError extends GatewayError {}
export class GatewayForbiddenError extends GatewayError {}
export class GatewayResponseError extends GatewayError {}

export function gateway() {
  throw new GatewayDisabledError();
}

export function createGateway() {
  throw new GatewayDisabledError();
}

export const createGatewayProvider = createGateway;

export const GATEWAY_AUTH_SUBPROTOCOL_PREFIX = "cap-stub";
export const GATEWAY_REALTIME_SUBPROTOCOL = "cap-stub";
export const GATEWAY_TEAM_SUBPROTOCOL_PREFIX = "cap-stub";
export const GATEWAY_TRANSCRIPTION_SUBPROTOCOL = "cap-stub";
export const VERSION = "0.0.0-stub";

export function getGatewayRealtimeAuthToken() {
  throw new GatewayDisabledError();
}
export function getGatewayRealtimeProtocols() {
  throw new GatewayDisabledError();
}
export function getGatewayRealtimeTeamIdOrSlug() {
  throw new GatewayDisabledError();
}
export function getGatewayTranscriptionProtocols() {
  throw new GatewayDisabledError();
}
