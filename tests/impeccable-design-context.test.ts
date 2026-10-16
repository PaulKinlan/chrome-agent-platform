// chrome-agent-platform-3f563: this repo's canonical docs/DESIGN.md must be
// available to the checked-in Impeccable context loader alongside PRODUCT.md.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { fromFileUrl, join } from "jsr:@std/path@1";

const root = fromFileUrl(new URL("../", import.meta.url));

Deno.test("3f563: Impeccable loads the canonical design document, not an absence notice", async () => {
  const doc = await Deno.readTextFile(join(root, "docs/DESIGN.md"));
  const { code, stdout, stderr } = await new Deno.Command("node", {
    cwd: root,
    args: [".agents/skills/impeccable/scripts/context.mjs", "--target", "extension/options/options.html"],
    env: { IMPECCABLE_NO_UPDATE_CHECK: "1" },
  }).output();
  assertEquals(code, 0, new TextDecoder().decode(stderr));
  const output = new TextDecoder().decode(stdout);
  assertStringIncludes(output, "# PRODUCT.md\n");
  assert(output.includes(`# DESIGN.md\n\n${doc.trim()}`),
    "the full canonical design body must load; mentioning DESIGN.md in a missing-context notice is not enough");
  assert(!output.includes("WORLD_DISCOVERY_REQUIRED") && !output.includes("INCUMBENT_WORLD_UNDOCUMENTED"),
    "loaded design context must not also claim DESIGN.md is missing");
  const link = join(root, "DESIGN.md");
  assertEquals((await Deno.lstat(link)).isSymlink, true, "do not duplicate the canonical design document");
  assertEquals(await Deno.realPath(link), await Deno.realPath(join(root, "docs/DESIGN.md")));
});
