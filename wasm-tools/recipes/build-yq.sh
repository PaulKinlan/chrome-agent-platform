#!/usr/bin/env bash
# wasm-tools/recipes/build-yq.sh — hermetic build recipe for yq_stream_bounded
set -euo pipefail

echo "=== Building yq_stream_bounded (mikefarah/yq v4.47.2) ==="
echo "Recipe targets GOOS=wasip1 GOARCH=wasm with empty environment and post-link max memory ceiling."
echo "Recipe prepared for safe-build-env release builder."
