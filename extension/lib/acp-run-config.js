import { DEFAULT_ACP_CWD, DEFAULT_ACP_ENDPOINT, acpEndpointWithHarness, acpEndpointWithToken } from "./acp-runner.js";

export async function acpRunConfig(harnessId, read) {
  if (!["claude-code", "codex", "pi"].includes(harnessId)) throw new Error("Unknown ACP harness");
  const transport = (await read("acp.transport")) || "";
  const endpoint = new URL((await read("acp.endpoint")) || DEFAULT_ACP_ENDPOINT);
  if (!["ws:", "wss:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error("ACP endpoint must be a ws or wss URL without embedded credentials");
  const base = new URL(endpoint);
  base.protocol = endpoint.protocol === "wss:" ? "https:" : "http:";
  base.search = ""; base.hash = "";
  return {
    url: acpEndpointWithHarness(acpEndpointWithToken(endpoint.href, await read("acp.token")), harnessId),
    cwd: (await read("acp.cwd")) || "",
    harnessId,
    transport: transport === "native" ? "native" : "ws",
    auto: await read("acp.permissions") === "auto",
    providerConfig: { provider: "acp", model: harnessId, baseURL: base.href },
  };
}
