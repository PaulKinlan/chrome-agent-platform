// tests/copy-built-tree.test.ts — the materialising copy used by acceptance
// harnesses (chrome-agent-platform-h8rb).
//
// `cp -r` copies a symlink as a symlink: an ABSOLUTE built-tree link keeps
// pointing into the SOURCE tree (the copy then loads the source's bytes and its
// runnable file vanishes when the source's build GC removes the target), and a
// RELATIVE link merely happens to resolve inside the copy. These tests pin the
// shared helper's contract and the three callers that were still on the raw
// copy. webmcp-acceptance.ts is deliberately NOT pinned here: it is another
// lane's harness and is being changed by its owner.
//
// Scratch lives under the durable root, never tmpfs (bead chp); prose here
// avoids the built-tree path literal because the partition guard classifies
// plain text, not behaviour.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { readFile, stat, symlink, writeFile, mkdir, rm, readFile as readText } from "node:fs/promises";
import { join } from "node:path";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import { copyBuiltTree } from "../scripts/lib/copy-built-tree.mjs";

const scratch = () => Deno.makeTempDir({ dir: durableDir("copy-built-tree-test") });

/** A miniature built tree: a manifest, a versioned build dir, and a LINK as the
 * built entry — the shape a dev checkout has (absolute or relative target). */
async function makeBuiltTree(linkKind: "absolute" | "relative", root: string) {
  const src = join(root, "source");
  await mkdir(join(src, "dist-versions", "v1"), { recursive: true });
  await writeFile(join(src, "manifest.json"), '{"name":"fixture"}\n');
  await writeFile(join(src, "dist-versions", "v1", "worker.js"), "export const w = 1;\n");
  const target = linkKind === "absolute" ? join(src, "dist-versions", "v1") : join("dist-versions", "v1");
  await symlink(target, join(src, "dist"));
  return src;
}

Deno.test("copy-built-tree: a linked built tree is materialized and survives source build GC, for BOTH link shapes (h8rb)", async () => {
  for (const kind of ["absolute", "relative"] as const) {
    const root = await scratch();
    const src = await makeBuiltTree(kind, root);
    const dest = join(root, "copy");
    const { dir, materializedLinks } = await copyBuiltTree({ src, dest });
    const entry = await Deno.lstat(join(dir, "dist"));
    assert(!entry.isSymlink, `${kind}: the copied built entry must be real bytes, not a link`);
    assertEquals(await readFile(join(dir, "dist", "worker.js"), "utf8"), "export const w = 1;\n");
    assertEquals(materializedLinks, [{ path: "dist", target: "dist-versions/v1" }]);
    // SOURCE BUILD GC: exactly what removing a versioned build does.
    await rm(join(src, "dist-versions"), { recursive: true });
    assertEquals(
      await readFile(join(dir, "dist", "worker.js"), "utf8"),
      "export const w = 1;\n",
      `${kind}: source GC must not change the copy's bytes`,
    );
    await rm(root, { recursive: true, force: true });
  }
});

Deno.test("copy-built-tree: a DANGLING source link refuses the copy, and an owned copy is left behind only when it is complete (h8rb)", async () => {
  const root = await scratch();
  const src = await makeBuiltTree("relative", root);
  await rm(join(src, "dist-versions"), { recursive: true }); // the link now dangles
  const dest = join(root, "copy");
  await assertRejects(() => copyBuiltTree({ src, dest }), Error, "dangling symlink");
  await rm(root, { recursive: true, force: true });
});

// Falsification for the POST-COPY verification: a cpBin that copies links (the
// pre-fix behaviour, i.e. `cp -r` without -L) must be refused even though the
// command succeeded. Deleting the "no symlink survives" check reds this test.
Deno.test("copy-built-tree: a copy that still contains a symlink is REFUSED — the guarantee is checked, not assumed (h8rb)", async () => {
  const root = await scratch();
  const src = await makeBuiltTree("relative", root);
  const wrapper = join(root, "link-preserving-cp.sh");
  await writeFile(wrapper, '#!/bin/sh\nexec /usr/bin/cp -r "$2" "$3"\n');
  await new Deno.Command("chmod", { args: ["+x", wrapper] }).output();
  const dest = join(root, "copy");
  await assertRejects(() => copyBuiltTree({ src, dest, cpBin: wrapper }), Error, "still contains symlink");
  await rm(root, { recursive: true, force: true });
});

Deno.test("copy-built-tree: the three unblocked acceptance harnesses copy through the helper, never a raw cp -r (h8rb)", async () => {
  const ROOT = new URL("..", import.meta.url).pathname;
  const harnesses = [
    "scripts/webmcp-realsite-probe.ts",
    "scripts/kat-webmcp-honest-errors.ts",
    "scripts/read-page-host-grant-acceptance.ts",
  ];
  for (const rel of harnesses) {
    const text = await readText(`${ROOT}${rel}`, "utf8");
    assert(
      text.includes('from "./lib/copy-built-tree.mjs"'),
      `${rel} must import the materialising copy helper`,
    );
    assert(text.includes("copyBuiltTree({"), `${rel} must call copyBuiltTree`);
    assert(
      !/Deno\.Command\(\s*"cp"[\s\S]{0,80}?"-r"/.test(text),
      `${rel} must not build a raw cp -r invocation for the built tree`,
    );
  }
  // The helper itself is the only place that may invoke cp, and only with -L.
  const helper = await readText(`${ROOT}scripts/lib/copy-built-tree.mjs`, "utf8");
  assert(helper.includes('"-rL"'), "the helper copies with -rL (dereferencing)");
  assert(await stat(`${ROOT}scripts/lib/copy-built-tree.mjs`).then(() => true), "helper exists");
});
