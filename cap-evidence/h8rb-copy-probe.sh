#!/bin/bash
# cap-evidence/h8rb-copy-probe.sh — reproduce the acceptance-harness copy defect
# (chrome-agent-platform-h8rb) and show the materialising helper's behaviour on
# the SAME shapes. Prints a before/after table; run from the repo root:
#   bash cap-evidence/h8rb-copy-probe.sh
set -u
ROOT=/home/paulkinlan/cap-evidence/h8rb-probe-$(date +%s)
mkdir -p "$ROOT"

make_source() { # $1 = kind, $2 = dir
  local kind="$1" src="$2"
  mkdir -p "$src/dist-versions/v1"
  printf '{"name":"fixture"}\n' > "$src/manifest.json"
  echo "export const w = 1;" > "$src/dist-versions/v1/worker.js"
  if [ "$kind" = absolute ]; then
    ln -s "$src/dist-versions/v1" "$src/dist"
  else
    ln -s dist-versions/v1 "$src/dist"
  fi
}

for kind in relative absolute; do
  # BEFORE: the exact call the three harnesses made (cp -r SRC/. OUT)
  SRC="$ROOT/raw-src-$kind"; OUT="$ROOT/raw-out-$kind"
  mkdir -p "$OUT"; make_source "$kind" "$SRC"
  cp -r "$SRC/." "$OUT"
  LINK=$(readlink "$OUT/dist" 2>/dev/null || echo "(not a link)")
  BEFORE=$(test -f "$OUT/dist/worker.js" && echo yes || echo no)
  rm -rf "$SRC/dist-versions"
  AFTER=$(test -f "$OUT/dist/worker.js" && echo yes || echo no)
  echo "BEFORE [cp -r, $kind] link='$LINK' worker-before-GC=$BEFORE worker-after-GC=$AFTER"
done

# AFTER: the shared helper on the same two shapes.
deno run -A - <<'EOF'
import { copyBuiltTree } from "./scripts/lib/copy-built-tree.mjs";
import { durableDir } from "./scripts/lib/durable-root.mjs";
import { mkdir, rm, symlink, writeFile, lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
const base = durableDir(`h8rb-helper-${Date.now()}`);
for (const kind of ["relative", "absolute"]) {
  const src = join(base, `src-${kind}`);
  await mkdir(join(src, "dist-versions", "v1"), { recursive: true });
  await writeFile(join(src, "manifest.json"), "{}\n");
  await writeFile(join(src, "dist-versions", "v1", "worker.js"), "export const w = 1;\n");
  await symlink(kind === "absolute" ? join(src, "dist-versions", "v1") : join("dist-versions", "v1"), join(src, "dist"));
  const dest = join(base, `out-${kind}`);
  const { materializedLinks } = await copyBuiltTree({ src, dest });
  const entry = await lstat(join(dest, "dist"));
  const isLink = typeof entry.isSymbolicLink === "function" ? entry.isSymbolicLink() : Boolean(entry.isSymlink);
  const before = await readFile(join(dest, "dist", "worker.js"), "utf8").then(() => "yes", () => "no");
  await rm(join(src, "dist-versions"), { recursive: true });
  const after = await readFile(join(dest, "dist", "worker.js"), "utf8").then(() => "yes", () => "no");
  console.log(`AFTER  [copyBuiltTree, ${kind}] isLink=${isLink} materialized=${JSON.stringify(materializedLinks)} worker-before-GC=${before} worker-after-GC=${after}`);
}
EOF
echo "root: $ROOT"
