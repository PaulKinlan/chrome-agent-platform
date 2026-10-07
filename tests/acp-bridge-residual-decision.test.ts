// 6hly: an adjudicated local-server-identity residual must not silently
// disappear when ACP auth or transport documentation is edited.
import { assert } from "jsr:@std/assert";

Deno.test("ACP local bind-race residual is named, reversible, and separate from web-origin auth", async () => {
  const register = await Deno.readTextFile(new URL("../docs/RISK-REGISTER.md", import.meta.url));
  const model = await Deno.readTextFile(new URL("../THREAT_MODEL.md", import.meta.url));
  const research = await Deno.readTextFile(new URL("../docs/ACP-INTEGRATION-RESEARCH.md", import.meta.url));
  const r24 = register.split(/^### R24 \(L\)/m)[1]?.split(/^### /m)[0];
  assert(r24, "R24 must own the ACP bind-race decision");
  for (const pin of [
    "- **Risk:**", "- **Lives at:**", "- **Mitigation:**", "- **Open question:**",
    "ADJUDICATED AND WITHHELD", "chrome-agent-platform-6hly", "REOPEN TRIGGER",
    "single-user development machine", "shared or multi-user",
    "per-run token", "pinned certificate", "native-messaging transport",
    "extension/lib/acp-runner.js:292", "scripts/acp-bridge.ts:778",
  ]) {
    assert(r24.includes(pin), `R24 must retain ${pin}`);
  }
  // All ACP entry points in the threat model must agree on the current bridge
  // controls, not retain pre-jsjy line numbers beside a corrected T15.
  for (const outdated of [
    "scripts/acp-bridge.ts:44", "scripts/acp-bridge.ts:49", "scripts/acp-bridge.ts:67-71",
    "scripts/acp-bridge.ts:136-141", "scripts/acp-bridge.ts:173-178",
    "scripts/acp-bridge.ts:636-646", "scripts/acp-bridge.ts:641-646",
    "scripts/acp-bridge.ts:723-743", "scripts/acp-bridge.ts:825-833",
  ]) {
    assert(!model.includes(outdated), `THREAT_MODEL.md must not retain stale ACP pin ${outdated}`);
  }
  for (const anchor of [
    "scripts/acp-bridge.ts:52", "scripts/acp-bridge.ts:196-201",
    "scripts/acp-bridge.ts:852-860",
  ]) {
    assert(model.includes(anchor), `THREAT_MODEL.md must retain current ACP pin ${anchor}`);
  }
  const t15 = model.split("### T15.")[1]?.split("### T16.")[0];
  assert(t15?.includes("**Register:** R24"), "T15 must point to the owning R24 decision");
  const exclusions = model.split("## 7. Explicit Exclusions")[1]?.split("## 8.")[0];
  assert(exclusions?.includes("10. **ACP loopback server-identity bind race"), "§7 must name the accepted exclusion");
  assert(exclusions?.includes("**Owning register entry: R24"), "§7 must cite R24");
  assert(research.includes("Accepted local-server-identity residual (R24 / 6hly)"), "ACP operator docs must disclose the residual");
  assert(r24.includes("voicebox `k74h`") && exclusions?.includes("not voicebox `k74h`"),
    "a local process bind race must not be conflated with voicebox's cross-origin threat");
});
