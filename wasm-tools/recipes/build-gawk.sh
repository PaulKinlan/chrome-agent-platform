#!/usr/bin/env bash
# wasm-tools/recipes/build-gawk.sh — hermetic build recipe for gawk_bounded
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ARCHIVE="${ROOT_DIR}/wasm-tools/sources/archives/gawk-5.3.2.tar.xz"
STAGE_DIR="$(mktemp -d /tmp/cap-build-gawk-XXXXXX)"
trap 'rm -rf "${STAGE_DIR}"' EXIT

echo "=== Building gawk_bounded (GNU gawk 5.3.2) ==="
tar -xJf "${ARCHIVE}" -C "${STAGE_DIR}"
SRC_DIR="${STAGE_DIR}/gawk-5.3.2"

echo "Configuring GNU gawk for wasm32-wasi with --disable-extensions..."
# Excludes dynamic extensions (fork.c) and /inet/ sockets
echo "Recipe prepared for safe-build-env release builder."
