// scripts/mcp-client-sw-inject.js — service-worker bundle inject.
// CAP-FB-20260831-MCP-GLOBAL-UI-01
//
// The remote-MCP client (lib/mcp-client.js) imports the @modelcontextprotocol/sdk
// browser-safe transport SUBPATHS (Streamable-HTTP / SSE; NEVER stdio). esbuild
// resolves and bundles those for the service worker, but Deno's type-checker
// cannot resolve the peer-qualified subpath in the combined unit-test graph, so
// the SW source must not statically import lib/mcp-client.js. build.mjs INJECTS
// this module into the SW bundle (esbuild `inject`, prepended before the entry
// body) so the mount is available WITHOUT a Deno-visible source import — exactly
// the mechanism the transport-spike dev probe uses. This ships in EVERY build
// (the mount is a real product path: Settings "Test connection" and, later, the
// per-run tool injection), unlike the dev-only probe.
//
// It registers the mount in lib/mcp-mount-registry.js (a shared module singleton
// in the bundle), which service-worker.js reads to power the mcp.servers.test
// route. It adds NO stdio surface and touches no network on its own — it only
// exposes the resilient per-server mount.
import { mountRemoteMcpServers } from "../extension/lib/mcp-client.js";
import { registerMcpMount } from "../extension/lib/mcp-mount-registry.js";

registerMcpMount(mountRemoteMcpServers);
