import { DEFAULT_ACP_CWD, DEFAULT_ACP_ENDPOINT, acpEndpointWithHarness, acpEndpointWithToken } from "./acp-runner.js";

export async function acpRunConfig(harnessId, read, { discovery = false } = {}) {
  if (!["claude-code", "codex", "pi"].includes(harnessId)) throw new Error("Unknown ACP harness");
  if (harnessId === "pi" && !discovery) throw new Error("pi-acp 0.0.33 does not mount CAP tools. Use Claude Code or Codex until Pi tool registration is available.");
  const transport = (await read("acp.transport")) || "";
  const endpointSetting = (await read("acp.endpoint")) || DEFAULT_ACP_ENDPOINT;
  let endpoint;
  try {
    endpoint = new URL(endpointSetting);
  } catch {
    // Fail closed: acp.endpoint is not owner-gated, so any extension-principal
    // surface can write a bad value. Refuse with a named diagnostic rather than
    // silently sending harness traffic to the default endpoint, and rather than
    // leaking a raw "Invalid URL" TypeError into every ACP harness turn.
    throw new Error(`acp.endpoint setting is invalid: ${JSON.stringify(String(endpointSetting))} is not a valid URL. Correct or clear the setting to restore ACP harness turns.`);
  }
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
