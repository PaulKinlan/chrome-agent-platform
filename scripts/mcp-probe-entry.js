// mcp-probe-entry.js — DEVELOPER-BUILD-ONLY MCP spike probe (harness input).
// CAP-FB-20260831-MCP-TRANSPORT-SPIKE-01
//
// esbuild entry point, bundled ONLY in developer builds (build.mjs skips it
// for the store target) to `extension/dist/dev/mcp-probe.bundle.js`. It lives
// under scripts/ — NOT under extension/ — because it is a test harness input,
// not shipped source: it installs `globalThis.__capMcpProbe`, which the
// shipped-source oracle scan (rightly) forbids in the extension tree.
//
// The KAT dynamically imports the built bundle inside the loaded extension's
// real service-worker context and calls `globalThis.__capMcpProbe(...)`,
// proving the remote-MCP client connects → lists → calls → tears down from a
// genuine MV3 SW, with per-server resilience. It ships in no production build.

import { mountRemoteMcpServers } from "../extension/lib/mcp-client.js";

/**
 * Drive a full mount → list → call → teardown against the given servers and
 * return a JSON-serialisable summary (safe to return over CDP Runtime.evaluate).
 *
 * @param {{ servers: Array<{name, transport, allowedTools?}>, call?: {tool:string, args:object} }} opts
 */
globalThis.__capMcpProbe = async (opts) => {
  const servers = opts?.servers ?? [];
  const summary = { servers: [], tools: [], call: null, closedOk: false, error: null };
  let mount;
  try {
    mount = await mountRemoteMcpServers(servers);
    summary.servers = mount.servers;
    summary.tools = Object.keys(mount.tools).sort();

    if (opts?.call) {
      const tool = mount.tools[opts.call.tool];
      if (!tool) {
        summary.call = { tool: opts.call.tool, ok: false, result: "tool not found in mounted set" };
      } else {
        const result = await tool.call(opts.call.args ?? {});
        summary.call = { tool: opts.call.tool, ok: true, result };
      }
    }
  } catch (e) {
    summary.error = e instanceof Error ? e.message : String(e);
  } finally {
    try {
      await mount?.close();
      summary.closedOk = true;
    } catch (e) {
      summary.closeError = e instanceof Error ? e.message : String(e);
    }
  }
  return summary;
};
