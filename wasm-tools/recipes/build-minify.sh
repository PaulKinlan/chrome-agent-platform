#!/usr/bin/env bash
# wasm-tools/recipes/build-minify.sh — hermetic build recipe for minify_tdewolff_bounded
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ARCHIVE="${ROOT_DIR}/wasm-tools/sources/archives/minify-8985643f.tar.gz"
STAGE_DIR="$(mktemp -d /tmp/cap-build-minify-XXXXXX)"
trap 'rm -rf "${STAGE_DIR}"' EXIT

echo "=== Building minify_tdewolff_bounded (tdewolff/minify v2.24.2) ==="
tar -xzf "${ARCHIVE}" -C "${STAGE_DIR}"
SRC_DIR="${STAGE_DIR}/$(ls "${STAGE_DIR}")"

if command -v go >/dev/null 2>&1; then
  echo "Compiling via Go wasip1..."
  (cd "${SRC_DIR}" && GOOS=wasip1 GOARCH=wasm go build -trimpath -ldflags="-s -w" -o "${STAGE_DIR}/minify_raw.wasm" ./cmd/minify)
  if command -v wasm-opt >/dev/null 2>&1; then
    wasm-opt --set-max-memory=33554432 "${STAGE_DIR}/minify_raw.wasm" -o "${ROOT_DIR}/wasm-tools/dist/minify_tdewolff_bounded.wasm"
  else
    cp "${STAGE_DIR}/minify_raw.wasm" "${ROOT_DIR}/wasm-tools/dist/minify_tdewolff_bounded.wasm"
  fi
  echo "Built minify_tdewolff_bounded.wasm successfully."
else
  echo "Go toolchain not available locally; recipe shipped for release-builder."
fi
