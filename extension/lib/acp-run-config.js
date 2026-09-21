import { DEFAULT_ACP_ENDPOINT, acpEndpointWithHarness, acpEndpointWithToken } from "./acp-runner.js";

export async function acpRunConfig(harnessId, read, { discovery = false } = {}) {
  if (!["claude-code", "codex", "pi"].includes(harnessId)) throw new Error("Unknown ACP harness");
  if (harnessId === "pi" && !discovery) throw new Error("pi-acp 0.0.33 does not mount CAP tools. Use Claude Code or Codex until Pi tool registration is available.");
  if (await read("acp.transport") === "native") throw new Error("CAP tools currently require the WebSocket bridge. Set acp.transport to ws and start the bridge; native-host tool plumbing is not available yet.");
  const endpoint = new URL((await read("acp.endpoint")) || DEFAULT_ACP_ENDPOINT);
  if (!["ws:", "wss:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error("ACP endpoint must be a ws or wss URL without embedded credentials");
  const base = new URL(endpoint);
  base.protocol = endpoint.protocol === "wss:" ? "https:" : "http:";
  base.search = ""; base.hash = "";
  return {
    url: acpEndpointWithHarness(acpEndpointWithToken(endpoint.href, await read("acp.token")), harnessId),
    cwd: (await read("acp.cwd")) || "",
    harnessId,
    auto: await read("acp.permissions") === "auto",
    providerConfig: { provider: "acp", model: harnessId, baseURL: base.href },
  };
}
