#!/usr/bin/env bash
# wasm-tools/recipes/build-ffmpeg.sh — media transcoding build metadata
set -euo pipefail

echo "=== Packaging ffmpeg metadata ==="
echo "Note: ffmpeg is excluded from the bundled extension lane per CWS RHC policy; supported only in zero-privilege sandboxed iframes."
