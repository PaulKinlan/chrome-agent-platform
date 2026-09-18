// scripts/lib/copy-built-tree.mjs — copy a built tree into an owned directory
// with every symlink MATERIALIZED (chrome-agent-platform-h8rb).
//
// `cp -r` copies a symlink AS a symlink. A dev checkout's built entry is often
// a link into a versioned sibling directory, so the copy either loads the
// SOURCE's bytes (an absolute link — which also dies the moment the source's
// build GC removes the target) or works only by luck (a relative link that
// happens to resolve inside the copy). Acceptance evidence collected from a
// tree that does not own its bytes is evidence about some other tree.
//
// Contract, in order:
//   1. refuse before copying if the SOURCE contains a dangling link (an
//      incomplete tree, never a silently dist-less copy);
//   2. copy ONCE with `-rL`, dereferencing every link;
//   3. CHECK that no symlink survives anywhere in the copy, and refuse if one
//      does — the guarantee is verified, not assumed.
// This is the same shape as the permission-variant fix (54k5), shared here so
// the acceptance harnesses cannot drift apart again.

import { lstat, mkdir, readdir, readlink, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

/** Every symlink under `dir`, with its raw link text. */
async function* linksUnder(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      yield { path, target: await readlink(path) };
    } else if (entry.isDirectory()) {
      yield* linksUnder(path);
    }
  }
}

/**
 * @param {{ src: string, dest: string, cpBin?: string }} options
 * `src` is the built tree (copied as `src/.`), `dest` the owned directory.
 * Throws when the copy cannot be proven self-contained.
 */
export async function copyBuiltTree({ src, dest, cpBin = "cp" } = {}) {
  if (!src || !dest) throw new Error("copyBuiltTree: src and dest are required");
  const source = resolve(src);
  const target = resolve(dest);
  const sourceInfo = await lstat(source).catch(() => null);
  if (!sourceInfo?.isDirectory()) {
    throw new Error(`copyBuiltTree: source is not a directory: ${source}`);
  }
  if (target === source || target.startsWith(source + sep)) {
    throw new Error("copyBuiltTree: dest must not be the source tree or inside it");
  }
  if (source.startsWith(target + sep)) {
    throw new Error(
      "copyBuiltTree: dest must not be an ancestor of the source tree (the copy would delete the source)",
    );
  }

  // 1. A dangling link means the source is incomplete: refuse rather than
  //    produce a variant that is silently missing its runnable path.
  const materializedLinks = [];
  for await (const link of linksUnder(source)) {
    const resolved = resolve(dirname(link.path), link.target);
    const info = await stat(resolved).catch(() => null);
    if (!info) {
      throw new Error(
        `copyBuiltTree: the source contains a dangling symlink (${relative(source, link.path)} -> ${link.target}) — refusing to copy an incomplete tree`,
      );
    }
    materializedLinks.push({
      path: relative(source, link.path),
      target: relative(source, resolved),
    });
  }

  // 2. One dereferencing copy.
  await mkdir(target, { recursive: true });
  const copy = await new Deno.Command(cpBin, {
    args: ["-rL", `${source}/.`, target],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (copy.code !== 0) {
    const detail = new TextDecoder().decode(copy.stderr).trim().slice(0, 300);
    throw new Error(`copyBuiltTree: ${cpBin} -rL failed with exit ${copy.code}${detail ? `: ${detail}` : ""}`);
  }

  // 3. Verify the guarantee instead of trusting the flag.
  const survivors = [];
  for await (const link of linksUnder(target)) {
    survivors.push(`${relative(target, link.path)} -> ${link.target}`);
  }
  if (survivors.length > 0) {
    throw new Error(
      `copyBuiltTree: the copy still contains symlink(s): ${survivors.join(", ")} — refusing a tree that does not own its bytes`,
    );
  }
  return { dir: target, materializedLinks };
}
