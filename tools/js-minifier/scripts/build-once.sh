#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "$0")/.." && pwd)
[[ $# -eq 1 && $1 =~ ^build-[ab]$ ]] || { echo "usage: $0 build-a|build-b" >&2; exit 64; }
out="$root/$1"
rm -rf -- "$out"
mkdir -p "$out/packages" "$out/engine" "$out/dist"
for name in terser-5.44.0 csso-5.0.5 html-minifier-terser-7.2.0; do
  mkdir "$out/packages/$name"
  /usr/bin/tar --extract --gzip --file "$root/sources/archives/$name.tgz" --directory "$out/packages/$name" --strip-components=1 --no-same-owner --no-same-permissions
done
/usr/bin/python3 -S "$root/scripts/prepare-terser-no-source-map.py" "$out/packages/terser-5.44.0" "$out/engine/terser-5.44.0"
/usr/bin/python3 -S "$root/scripts/prepare-html-bounded.py" "$out/packages/html-minifier-terser-7.2.0/dist/htmlminifier.esm.bundle.js" "$out/engine/html-minifier-terser-7.2.0.mjs"
mkdir -p "$out/engine/terser-5.44.0/node_modules"
cp -a "$root/vendor-runtime/node_modules/acorn" "$out/engine/terser-5.44.0/node_modules/acorn"
esbuild="$root/build-tools/node_modules/@esbuild/linux-x64/bin/esbuild"
common=(--bundle --platform=browser --format=iife --target=es2022 --minify --charset=utf8 --legal-comments=external --log-level=warning)
"$esbuild" "$root/src/terser-worker.js" "${common[@]}" --alias:terser-bounded-engine="$out/engine/terser-5.44.0/main.js" --metafile="$out/terser.metafile.json" --outfile="$out/dist/terser-bounded.worker.js"
"$esbuild" "$root/src/csso-worker.js" "${common[@]}" --alias:csso-bounded-engine="$out/packages/csso-5.0.5/dist/csso.esm.js" --metafile="$out/csso.metafile.json" --outfile="$out/dist/csso-bounded.worker.js"
"$esbuild" "$root/src/html-minifier-terser-worker.js" "${common[@]}" --alias:html-minifier-terser-bounded-engine="$out/engine/html-minifier-terser-7.2.0.mjs" --metafile="$out/html-minifier-terser.metafile.json" --outfile="$out/dist/html-minifier-terser-bounded.worker.js"
cp "$root/src/client.mjs" "$root/src/lifecycle.mjs" "$out/dist/"
/usr/bin/python3 -S "$root/scripts/postprocess-shipped.py" "$out/dist/"*.worker.js
find "$out" -type l -print -quit | grep -q . && { echo "symlink in build output" >&2; exit 1; } || true
