// CAP-FB-20260830-NOTIFY-ICON-PATH-01 — every packaged-resource path the
// browser tools hand to Chrome (chrome.runtime.getURL("icons/…")) must exist
// on disk under extension/. The `notify` tool referenced "icons/icon-128.png"
// while the shipped file is "icons/icon128.png", so every notification failed
// with "Unable to download all specified images." A missing file here is a
// tool that can never work, so this is a hard assertion, not a warning.
import { assert } from "jsr:@std/assert@1";

Deno.test("browser tools: every getURL(\"icons/…\") path exists under extension/", async () => {
  const source = await Deno.readTextFile(new URL("../extension/lib/browser-tools.js", import.meta.url));
  const paths = [...source.matchAll(/getURL\(\s*["'](icons\/[^"']+)["']\s*\)/g)].map((m) => m[1]);
  assert(paths.length > 0, "expected at least one getURL(\"icons/…\") reference (the notify default icon)");
  for (const p of paths) {
    let isFile = false;
    try {
      isFile = Deno.statSync(new URL("../extension/" + p, import.meta.url)).isFile;
    } catch {
      isFile = false;
    }
    assert(isFile, `browser-tools.js references "${p}" but extension/${p} does not exist`);
  }
});
