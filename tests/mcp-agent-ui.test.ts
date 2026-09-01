// tests/mcp-agent-ui.test.ts — CAP-FB-20260831-MCP-AGENT-UI-01.
//
// The agent create/edit dialog turns three UI inputs — the inherited global set,
// the ids the owner toggled OFF, and the servers the owner added — into the
// per-agent list persisted through `named-agent.set-mcp-servers`. That pure
// assembly is `buildAgentMcpList`; here we prove it composes with the resolver
// (`resolveEffectiveMcpServers`) to the effective set the run will actually see.
//
// Falsification: removing the disabled-inherited emission in `buildAgentMcpList`
// (the `for (const id of disabled)` loop) makes "a disabled inherited server is
// dropped from the effective set" go RED — the global would leak back in.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  buildAgentMcpList,
  resolveEffectiveMcpServers,
} from "../extension/lib/mcp-config.js";

const G1 = { id: "calc", name: "Calc", transport: "http", url: "https://calc.example/mcp", enabled: true };
const G2 = { id: "echo", name: "Echo", transport: "http", url: "https://echo.example/mcp", enabled: true };
const OWN = {
  name: "My tools",
  transport: "http",
  url: "https://mine.example/mcp",
  enabled: true,
  auth: { headerName: "Authorization", token: "s3cret" },
};
const ids = (list: Array<{ id: string }>) => list.map((s) => s.id).sort();

Deno.test("buildAgentMcpList: a disabled inherited server is dropped from the effective set", () => {
  const global = [G1, G2];
  const agentList = buildAgentMcpList({
    globalServers: global,
    disabledGlobalIds: ["calc"],
    ownServers: [],
  });
  // The per-agent list carries a same-id, disabled marker for the inherited one.
  const calc = agentList.find((s) => s.id === "calc");
  assert(calc, "expected a per-agent entry for the disabled inherited server");
  assertEquals(calc!.enabled, false);

  // The resolver drops it; the other global is still inherited.
  const effective = resolveEffectiveMcpServers(global, agentList);
  assertEquals(ids(effective), ["echo"], "calc must be gone; echo still inherited");
});

Deno.test("buildAgentMcpList: an own server joins the inherited enabled ones", () => {
  const global = [G1, G2];
  const agentList = buildAgentMcpList({
    globalServers: global,
    disabledGlobalIds: [],
    ownServers: [OWN],
  });
  const effective = resolveEffectiveMcpServers(global, agentList);
  assertEquals(ids(effective), ["calc", "echo", "my-tools"]);
  // The own server keeps its token through assembly (the SW connect path needs it).
  const own = effective.find((s) => s.id === "my-tools");
  assertEquals(own?.auth?.token, "s3cret");
});

Deno.test("buildAgentMcpList: disable one inherited AND add an own server", () => {
  const global = [G1, G2];
  const agentList = buildAgentMcpList({
    globalServers: global,
    disabledGlobalIds: ["calc"],
    ownServers: [OWN],
  });
  const effective = resolveEffectiveMcpServers(global, agentList);
  // calc disabled → gone; echo inherited; my-tools added.
  assertEquals(ids(effective), ["echo", "my-tools"]);
});

Deno.test("buildAgentMcpList: re-enabling means no per-agent entry (inherit again)", () => {
  const global = [G1, G2];
  // No disabled ids and no own servers → an empty per-agent list; both globals inherit.
  const agentList = buildAgentMcpList({ globalServers: global, disabledGlobalIds: [], ownServers: [] });
  assertEquals(agentList.length, 0);
  assertEquals(ids(resolveEffectiveMcpServers(global, agentList)), ["calc", "echo"]);
});

Deno.test("buildAgentMcpList: cannot disable a global that no longer exists (no phantom entry)", () => {
  const agentList = buildAgentMcpList({
    globalServers: [G1],
    disabledGlobalIds: ["ghost"],
    ownServers: [],
  });
  assertEquals(agentList.length, 0, "a disable marker for an unknown global id is dropped");
});
