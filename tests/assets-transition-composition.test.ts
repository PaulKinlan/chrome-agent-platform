import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { focusExplicitRouteTarget } from "../extension/ntp/route-focus.js";

const root = new URL("../", import.meta.url);
const read = (path: string) => Deno.readTextFile(new URL(path, root));

Deno.test("Assets composition preserves explicit-only focus ownership", () => {
  let focusCalls = 0;
  const focusAfter = { isConnected: true, focus: () => focusCalls++ };

  assertEquals(focusExplicitRouteTarget(), false);
  assertEquals(focusCalls, 0);
  assertEquals(focusExplicitRouteTarget({ focusAfter }), true);
  assertEquals(focusCalls, 1);
});

Deno.test("Assets dialog lifecycle composes with no-argument follow-up focus neutrality", async () => {
  const ntp = await read("extension/ntp/ntp.js");

  assertStringIncludes(
    ntp,
    "import {\n  createRouteUpdateRunner,\n  focusExplicitRouteTarget,",
  );
  assertStringIncludes(
    ntp,
    'const focusAfter = Object.hasOwn(options, "focusAfter")',
  );
  assertStringIncludes(
    ntp,
    "if (!threadView.hidden) {\n    focusExplicitRouteTarget(options);\n    return;",
  );
  assertStringIncludes(
    ntp,
    "async function runThreadTurn(text, attachments = [], mention = null) {\n  const owner = runSurfaceOwner.claim();",
  );
  assertStringIncludes(ntp, "surfaceRunLiveAt = Date.now();");
  assertStringIncludes(
    ntp,
    "  showThreadView();\n  setStatus(\"running…\", false);",
  );
  assertStringIncludes(ntp, "showThreadView({ focusAfter: threadComposer });");

  assertStringIncludes(ntp, "wireHtmlFrameContent,");
  assertStringIncludes(ntp, "const frameCleanups = [];");
  assertStringIncludes(ntp, "frameCleanups.push(wireHtmlFrameContent(frame));");
  assertStringIncludes(ntp, "for (const cleanup of frameCleanups.splice(0))");
});

Deno.test("Assets composition ships the stable nested sandbox without false navigation authority", async () => {
  const manifest = JSON.parse(await read("extension/manifest.json"));
  const host = await read("extension/sandbox/artifact-preview.js");
  const components = await read("extension/shared/components.js");
  const worker = await read("extension/background/service-worker.js");

  assert(manifest.sandbox.pages.includes("sandbox/artifact-preview.html"));
  assertStringIncludes(
    manifest.content_security_policy.extension_pages,
    "frame-src 'self' about: blob: data:",
  );
  assertStringIncludes(host, 'frame.setAttribute("sandbox", "allow-scripts")');
  assertStringIncludes(host, "frame.srcdoc = html");
  assertStringIncludes(
    host,
    "active && event.source === active.frame.contentWindow",
  );
  assertStringIncludes(components, "HTML_FRAME_CSP");
  assert(!components.includes("Object.defineProperty(window, 'location'"));
  assert(!components.includes('Object.defineProperty(window, "location"'));
  assert(!worker.includes("setupGenerativeUiNetworkGuard"));
});
