// @ts-nocheck
// CAP-FB-20260829-INLINE-APPROVALS-01 — the agent-do post-tool seam must
// recognize a lazy tool's structured grant denial before the model continues.
import { assertEquals } from "jsr:@std/assert@1";
import { permissionDenialFromToolResult } from "../extension/lib/agent.js";

Deno.test("agent-do permission seam extracts the nested lazy denial and ignores plain failures", () => {
  const denial = {
    error: "browser control not granted",
    waitingForPermission: true,
    permissionRequirement: {
      reason: "control https://example.com",
      permissions: [],
      grantOrigins: ["https://example.com"],
      grantGlobal: false,
    },
  };
  const normalized = {
    modelContent: JSON.stringify({ ok: true, selectedTool: "group_tabs", result: denial }),
    userSummary: "blocked",
  };
  assertEquals(permissionDenialFromToolResult(normalized), denial);
  assertEquals(permissionDenialFromToolResult({ modelContent: '{"ok":false,"error":"ordinary"}', userSummary: "ordinary" }), null);
});

Deno.test("production wiring blocks agent-do on the run decision and exposes only the conversation resolver", async () => {
  const [agent, worker] = await Promise.all([
    Deno.readTextFile(new URL("../extension/lib/agent.js", import.meta.url)),
    Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url)),
  ]);
  assertEquals(agent.includes("const decision = await onPermissionRequest(permissionDenial)"), true,
    "agent-do's awaited post-tool hook is the pause point");
  assertEquals(worker.includes('async "run.resolve-inline-approval"'), true,
    "the originating conversation has a bounded decision route");
  assertEquals(worker.includes("INLINE_PERMISSION_TTL_MS = 60_000"), true,
    "permission waits have an explicit one-minute fail-closed bound");
});
