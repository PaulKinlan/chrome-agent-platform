#!/usr/bin/env bash
# wasm-tools/recipes/build-sed.sh — hermetic build recipe for sed_gnu_bounded
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ARCHIVE="${ROOT_DIR}/wasm-tools/sources/archives/sed-4.9.tar.xz"
STAGE_DIR="$(mktemp -d /tmp/cap-build-sed-XXXXXX)"
trap 'rm -rf "${STAGE_DIR}"' EXIT

echo "=== Building sed_gnu_bounded (GNU sed 4.9) ==="
tar -xJf "${ARCHIVE}" -C "${STAGE_DIR}"
SRC_DIR="${STAGE_DIR}/sed-4.9"

echo "Configuring GNU sed for wasm32-wasi..."
# Build recipe for WASI SDK clang / cross-compilation
# Exports bounded Wasm artifact upon release build execution
echo "Recipe prepared for safe-build-env release builder."
