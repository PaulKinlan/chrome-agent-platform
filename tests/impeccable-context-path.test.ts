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
  // chrome-agent-platform-pfyiy: the launcher's ABSENCE notice also contains the
  // bare string "DESIGN.md" ("PRODUCT.md exists but no DESIGN.md or incumbent
  // visual implementation was found"), so a substring check was satisfied while
  // no design context had loaded - it could not tell "loaded" from "missing".
  // Pin the section heading the launcher emits only when it really loads the
  // document, and fail on the absence notice.
  assertStringIncludes(context, "\n# DESIGN.md\n", "the launcher must load design context, not just exist");
  assert(
    !context.includes("WORLD_DISCOVERY_REQUIRED"),
    "a missing-design notice must fail this assertion, not satisfy it",
  );
});
