// tests/cap-logo.test.ts — verifies line-art Cap logo and manifest icons (chrome-agent-platform-04de)
import { assertEquals, assert, assertStringIncludes } from "jsr:@std/assert@1";

const root = new URL("..", import.meta.url);

function getPngDimensions(bytes: Uint8Array): { width: number; height: number } {
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  assertEquals(bytes[0], 0x89);
  assertEquals(bytes[1], 0x50);
  assertEquals(bytes[2], 0x4e);
  assertEquals(bytes[3], 0x47);
  assertEquals(bytes[4], 0x0d);
  assertEquals(bytes[5], 0x0a);
  assertEquals(bytes[6], 0x1a);
  assertEquals(bytes[7], 0x0a);

  // IHDR starts at byte 12 (chunk type at 12-15 is 'IHDR', width at 16-19, height at 20-23)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  return { width, height };
}

Deno.test("manifest: all icon resolutions (16, 32, 48, 128) are declared and valid PNGs", async () => {
  const manifestRaw = await Deno.readTextFile(new URL("extension/manifest.json", root));
  const manifest = JSON.parse(manifestRaw);

  const expectedSizes = ["16", "32", "48", "128"];
  assert(manifest.action?.default_icon, "manifest action.default_icon must be defined");
  assert(manifest.icons, "manifest icons must be defined");

  for (const size of expectedSizes) {
    const actionPath = manifest.action.default_icon[size];
    const iconPath = manifest.icons[size];
    assertEquals(actionPath, `icons/icon${size}.png`);
    assertEquals(iconPath, `icons/icon${size}.png`);

    const fileBytes = await Deno.readFile(new URL(`extension/${iconPath}`, root));
    assert(fileBytes.length > 0, `icon${size}.png must not be empty`);
    const { width, height } = getPngDimensions(fileBytes);
    assertEquals(width, Number(size), `icon${size}.png width mismatch`);
    assertEquals(height, Number(size), `icon${size}.png height mismatch`);
  }

  // docs/favicon.png
  const faviconBytes = await Deno.readFile(new URL("docs/favicon.png", root));
  assert(faviconBytes.length > 0, "docs/favicon.png must not be empty");
  const faviconDim = getPngDimensions(faviconBytes);
  assertEquals(faviconDim.width, 48);
  assertEquals(faviconDim.height, 48);

  // Vector app icon
  const appIconSvg = await Deno.readTextFile(new URL("extension/icons/app-icon.svg", root));
  assertStringIncludes(appIconSvg, "<svg");
  assertStringIncludes(appIconSvg, 'viewBox="0 0 128 128"');
});

Deno.test("components: ICONS.cap and <cap-logo> web component are defined and exported", async () => {
  const componentsSource = await Deno.readTextFile(new URL("extension/shared/components-core.js", root));

  assertStringIncludes(componentsSource, "cap: '<svg viewBox=\"0 0 24 24\"");
  assertStringIncludes(componentsSource, 'aria-hidden="true"');
  assertStringIncludes(componentsSource, 'class CapLogo extends Component');
  assertStringIncludes(componentsSource, 'customElements.define("cap-logo", CapLogo)');

  // Ensure docs/components-core.js contains cap-logo as well
  const docsComponents = await Deno.readTextFile(new URL("docs/components-core.js", root));
  assertStringIncludes(docsComponents, "cap: '<svg viewBox=\"0 0 24 24\"");
  assertStringIncludes(docsComponents, 'customElements.define("cap-logo", CapLogo)');
});

Deno.test("headers: top-left product name across all pages includes Cap logo line art", async () => {
  const ntp = await Deno.readTextFile(new URL("extension/ntp/ntp.html", root));
  assertStringIncludes(ntp, 'class="brand-logo"');
  assertStringIncludes(ntp, '<span class="brand-text">Chrome <span class="brand-accent">Agent</span> Platform</span>');
  assertStringIncludes(ntp, '.side.collapsed .brand { opacity: 0; visibility: hidden; display: block; pointer-events: none; }');

  const options = await Deno.readTextFile(new URL("extension/options/options.html", root));
  assertStringIncludes(options, 'class="brand-logo"');
  assertStringIncludes(options, '<span class="brand-text">Chrome <span data-i18n="options_agent">Agent</span> Platform</span>');
  assertStringIncludes(options, 'class="about-brand-logo"');
  // 716s.2: the catalogue key sits on the TEXT span, never on the logo
  // container — hydrating the container had replaced the SVG with text.
  assertStringIncludes(options, '<span class="about-brand-text" data-i18n="options_chrome_agent_platform">Chrome Agent Platform</span>');

  const privacy = await Deno.readTextFile(new URL("extension/privacy/privacy.html", root));
  assertStringIncludes(privacy, 'class="brand-logo"');
  assertStringIncludes(privacy, '<span>Chrome <span>Agent</span> Platform</span>');

  const gallery = await Deno.readTextFile(new URL("docs/components.html", root));
  assertStringIncludes(gallery, 'class="masthead-logo"');
  assertStringIncludes(gallery, "<cap-logo");
});

Deno.test("falsification: missing icon or corrupted path fails assertions", () => {
  const testBytes = new Uint8Array([0, 1, 2, 3]);
  let failed = false;
  try {
    getPngDimensions(testBytes);
  } catch {
    failed = true;
  }
  assert(failed, "invalid PNG bytes must throw an assertion error");
});
