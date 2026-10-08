import { assert } from "jsr:@std/assert@1";

Deno.test("ckebt Q2: only the live hub-run context receives fenced declared descriptors, not passive UI", async () => {
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  const start = sw.indexOf("// Q2 permits disclosure of *fenced declared descriptors*");
  const end = sw.indexOf("// Include any /skill:<id>", start);
  const context = sw.slice(start, end);
  assert(start > 0 && end > start, "run-scoped Q2 context reaches the provider path");
  assert(context.includes("await formatAttachedDeclaredContext({") &&
    context.includes("readAttachedDeclaredWebmcpTools(candidate") &&
    context.includes('mode === "read" ? "MAIN" : "ISOLATED"') &&
    context.includes("readDeclaredWebmcpFromPage") &&
    context.includes("activeExecutions.has(executionId)") &&
    context.includes("siteToolProfileEpoch === ephemeralAttachedRunEpoch"));
  assert(context.includes("const context = attachedDeclaredText") &&
    sw.indexOf("orch.run(", end) > end, "the fenced text must be used before model dispatch");
  const passive = sw.slice(sw.indexOf('async "agent.tool-offers"('), sw.indexOf('async "agent.enroll-origin"('));
  assert(!passive.includes("readAttachedDeclaredWebmcpTools(") &&
    !passive.includes("formatAttachedDeclaredContext("), "the passive chip and registry remain count-only");
  assert(!context.includes('type: "invoke-tool"') && !context.includes("ephemeralSiteToolAuditPrincipal.append("),
    "disclosure does not open a callable page tool before D1/D3");
});
