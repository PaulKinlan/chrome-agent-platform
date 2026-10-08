import { assert } from "jsr:@std/assert@1";

Deno.test("D2: both primary and recovery page-effect boundaries re-check live Chrome host grant", async () => {
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  const invoke = sw.slice(sw.indexOf("async function invokeSiteToolCore("),
    sw.indexOf("async function ", sw.indexOf("async function invokeSiteToolCore(") + 1));
  assert(invoke.includes("hasLiveSiteToolHostPermission(canonical)"));
  const primary = invoke.indexOf("const hostReady = await hasLiveSiteToolHostPermission(canonical)");
  const firstEffect = invoke.indexOf('type: "invoke-tool"', primary);
  const retry = invoke.indexOf("const recoveryHostReady = await hasLiveSiteToolHostPermission(canonical)", firstEffect);
  const secondEffect = invoke.indexOf('type: "invoke-tool"', retry);
  assert(primary >= 0 && firstEffect > primary && retry > firstEffect && secondEffect > retry);
  assert(invoke.includes('reason: !hostReady ? "host-permission-revoked"'));
  assert(invoke.includes('reason: !recoveryHostReady ? "host-permission-revoked"'));
  const proof = sw.slice(sw.indexOf("async function hasLiveSiteToolHostPermission("),
    sw.indexOf("async function invokeSiteTool(", sw.indexOf("async function hasLiveSiteToolHostPermission(")));
  assert(proof.includes('permissions: ["scripting"]'));
  assert(proof.includes("origins: [`${origin}/*`]"));
  assert(proof.includes(".catch(() => false)"));
});
