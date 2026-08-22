#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "$0")/.." && pwd)
mkdir -p "$root/tests/generated"
"$root/build-tools/node_modules/@esbuild/linux-x64/bin/esbuild" "$root/tests/output-overflow-worker.js" --bundle --platform=browser --format=iife --target=es2022 --minify --legal-comments=none --log-level=warning --outfile="$root/tests/generated/output-overflow.worker.js"
