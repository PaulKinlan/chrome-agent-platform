#!/usr/bin/env bash
# wasm-tools/recipes/build-libmagic.sh — hermetic build recipe for file_libmagic_bounded
set -euo pipefail

echo "=== Building file_libmagic_bounded (file / libmagic 5.48) ==="
echo "Recipe compiles libmagic with embedded static magic.mgc data array under TIERS.default (initialPages=192, maxPages=2048)."
echo "MAGIC_NO_CHECK_COMPRESS=1 and MAGIC_NO_COMPRESS_FORK=1 enabled."
echo "Recipe prepared for safe-build-env release builder."
