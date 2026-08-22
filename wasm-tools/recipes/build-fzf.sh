#!/usr/bin/env bash
# wasm-tools/recipes/build-fzf.sh — hermetic build recipe for fzf_filter_bounded
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ARCHIVE="${ROOT_DIR}/wasm-tools/sources/archives/fzf-416aff86.tar.gz"
STAGE_DIR="$(mktemp -d /tmp/cap-build-fzf-XXXXXX)"
trap 'rm -rf "${STAGE_DIR}"' EXIT

echo "=== Building fzf_filter_bounded (junegunn/fzf v0.65.2) ==="
tar -xzf "${ARCHIVE}" -C "${STAGE_DIR}"
SRC_DIR="${STAGE_DIR}/$(ls "${STAGE_DIR}")"

if command -v go >/dev/null 2>&1; then
  echo "Compiling via Go wasip1..."
  (cd "${SRC_DIR}" && GOOS=wasip1 GOARCH=wasm go build -trimpath -ldflags="-s -w" -o "${STAGE_DIR}/fzf_raw.wasm" .)
  if command -v wasm-opt >/dev/null 2>&1; then
    wasm-opt --set-max-memory=33554432 "${STAGE_DIR}/fzf_raw.wasm" -o "${ROOT_DIR}/wasm-tools/dist/fzf_filter_bounded.wasm"
  else
    cp "${STAGE_DIR}/fzf_raw.wasm" "${ROOT_DIR}/wasm-tools/dist/fzf_filter_bounded.wasm"
  fi
  echo "Built fzf_filter_bounded.wasm successfully."
else
  echo "Go toolchain not available locally; recipe shipped for release-builder."
fi
