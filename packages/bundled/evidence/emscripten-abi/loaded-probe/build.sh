#!/usr/bin/env bash
# Rebuild the intentionally unsafe loaded-proof control under pinned emcc 6.0.0.
set -euo pipefail
cd "$(dirname "$0")"
: "${EMSDK_ROOT:?set EMSDK_ROOT to the pinned Emscripten 6.0.0 emsdk root}"
EMCC="$EMSDK_ROOT/upstream/emscripten/emcc"
"$EMCC" --version | head -1 | grep -F "emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) 6.0.0" >/dev/null
[[ "$(git -C "$EMSDK_ROOT" rev-parse HEAD)" == d223ae73c6998296e3ab27cf81dc2c2c9fd383de ]]
rm -f assets/unsafe-authority.mjs assets/unsafe-authority.wasm
"$EMCC" source/native_authority_attempt.c -O2 --no-entry \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=worker \
  -sDYNAMIC_EXECUTION=0 -sFILESYSTEM=0 -sALLOW_MEMORY_GROWTH=0 \
  -sINITIAL_MEMORY=16777216 \
  '-sEXPORTED_FUNCTIONS=["_cap_run_authority_attempt"]' \
  -o assets/unsafe-authority.mjs
