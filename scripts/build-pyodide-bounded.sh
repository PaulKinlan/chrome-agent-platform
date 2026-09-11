#!/usr/bin/env bash
# build-pyodide-bounded.sh — the EXACT command to produce the bounded-memory
# Pyodide runtime for CAP-FB-20260823-PYODIDE-PYTHON-01 (owner OPTION A).
#
# This is the ONE remaining step the feature-authoring session cannot perform:
# a multi-hour, Emscripten-toolchain build. Run it in a dedicated build lane
# with network + disk. It clones a PINNED Pyodide tag, applies the memory bound
# (MAXIMUM_MEMORY ≤ 2048 pages, ALLOW_MEMORY_GROWTH=0) via Makefile.envs (no
# source fork), builds, and emits the SHA-pinned artifacts for the
# default-tier runtime admission (docs/PYODIDE-BOUNDED-BUILD.md).
set -euo pipefail

PIN="0.26.4"                        # pinned Pyodide release tag (frozen provenance)
MAX_MEMORY_BYTES=$((2048 * 65536))  # 2048 pages = 128 MiB (default-tier ceiling)
# disk-backed default: the build takes hours and /tmp is RAM-backed tmpfs
OUT_DIR="${PYODIDE_OUT_DIR:-$HOME/cap-pyodide-bounded}"

echo "==> installing Emscripten SDK (this is the multi-hour step)"
git clone --depth 1 https://github.com/emscripten-core/emsdk.git "$OUT_DIR/emsdk"
"$OUT_DIR/emsdk/emsdk" install latest
"$OUT_DIR/emsdk/emsdk" activate latest
source "$OUT_DIR/emsdk/emsdk_env.sh"

echo "==> cloning Pyodide at pinned tag $PIN"
git clone --depth 1 --branch "$PIN" https://github.com/pyodide/pyodide.git "$OUT_DIR/pyodide"
cd "$OUT_DIR/pyodide"

echo "==> bounding memory: MAXIMUM_MEMORY=${MAX_MEMORY_BYTES} (2048 pages), ALLOW_MEMORY_GROWTH=0"
# Makefile.envs is the sanctioned lever — append, never fork.
printf '\n# CAP-FB-20260823-PYODIDE-PYTHON-01: bounded default-tier runtime\nexport EMSCRIPTEN_SETTINGS += -s MAXIMUM_MEMORY=%d -s ALLOW_MEMORY_GROWTH=0\n' \
  "$MAX_MEMORY_BYTES" >> Makefile.envs

echo "==> building (core + stdlib)"
make -C "$OUT_DIR/pyodide"

echo "==> emitting SHA-pinned artifacts"
sha256sum "$OUT_DIR/pyodide/dist/pyodide.asm.wasm" > "$OUT_DIR/SHA256SUMS"
sha256sum "$OUT_DIR/pyodide/dist/pyodide.js" >> "$OUT_DIR/SHA256SUMS"
ls -la "$OUT_DIR/pyodide/dist/pyodide.asm.wasm" "$OUT_DIR/pyodide/dist/pyodide.js"

cat <<EOF
DONE. Artifacts at $OUT_DIR/SHA256SUMS.
Admission record (default-tier runtime):
  pkg: pyodide.runtime, type: runtime, tier: default,
  license: { spdx: "MPL-2.0 AND PSF-2.0" },
  files: pyodide.asm.wasm (SHA-pinned) + pyodide.js (glue).
Next: feed the SHA into the wasm-package-authority admission (memory-evidence
gate: measured maxPages ≤ 2048 AND binary ≤ 16 MiB), then wire setPythonRuntimeProvider
to load the OPFS-cached artifacts (NO CDN). See docs/PYODIDE-BOUNDED-BUILD.md.
EOF
