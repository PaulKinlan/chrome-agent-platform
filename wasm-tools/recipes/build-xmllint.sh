#!/usr/bin/env bash
# wasm-tools/recipes/build-xmllint.sh — hermetic build recipe for xmllint_libxml2_bounded
set -euo pipefail

echo "=== Building xmllint_libxml2_bounded (libxml2 2.13.8) ==="
echo "Recipe compiles libxml2 for wasm32-wasi with network features disabled."
echo "Recipe prepared for safe-build-env release builder."
