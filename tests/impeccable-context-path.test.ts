// chrome-agent-platform-fnwt: the checked-in skill's documented fallback must
// launch from a worktree, not from an imagined scripts/impeccable binary.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { fromFileUrl, join } from "jsr:@std/path@1";

const root = fromFileUrl(new URL("../", import.meta.url));
const skill = join(root, ".agents/skills/impeccable/SKILL.md");
const launcher = ".agents/skills/impeccable/scripts/context.mjs";

Deno.test("fnwt: documented Impeccable fallback launches and loads the project context", async () => {
  const instructions = await Deno.readTextFile(skill);
  assertStringIncludes(instructions, launcher);
  const { code, stdout, stderr } = await new Deno.Command("node", {
    cwd: root,
    args: [launcher, "--target", "extension/options/options.html"],
    env: { IMPECCABLE_NO_UPDATE_CHECK: "1" },
  }).output();
  assertEquals(code, 0, new TextDecoder().decode(stderr));
  const context = new TextDecoder().decode(stdout);
  assertStringIncludes(context, "# PRODUCT.md");
  assertStringIncludes(context, "Chrome Agent Platform");
  assert(context.includes("DESIGN.md"), "the launcher must load design context, not just exist");
});
