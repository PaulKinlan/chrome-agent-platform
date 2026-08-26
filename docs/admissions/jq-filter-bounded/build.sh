#!/usr/bin/env bash
# jq_filter_bounded retained-build script — PLAN/SKELETON (NOT yet runnable).
# Mirrors packages/bundled/a2/build.sh + b2/build.sh. This is the contract the
# real retained build must satisfy; it has NOT been executed because the pinned
# toolchain + source are absent in this environment (see PROVENANCE.md B1/B2).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"

# toolchain: wasi-sdk clang 22.1.8 (host path scrubbed on repo migration) — the
# SAME pin every existing a2/b2/c2 lane uses. Blocked on B1 (not installed here).
SDK="${WASI_SDK:?set WASI_SDK to a wasi-sdk 22.1.8 install}"
CC="$SDK/bin/clang"
SYSROOT="$SDK/share/wasi-sysroot"

# The clean-room/wasi port must provide a bounded single-shot main() that reads
# one <=2KiB request and writes one <=64KiB response (see spec-contract.md).
# jq core is NOT single-file: it requires vendoring jqlang/jq at a PINNED commit
# plus oniguruma + decNumber + dtoa (see PROVENANCE.md B2). SOURCES are the
# placeholder the real build fills in.
SOURCES=("$ROOT/source/jq/main.c")   # BLOCKED: source not pinned/vendored yet

export SOURCE_DATE_EPOCH=0 TZ=UTC LC_ALL=C
FLAGS=(--target=wasm32-wasi --sysroot="$SYSROOT" -I"$ROOT/source" -O2 -DNDEBUG \
  -Wall -Wextra -Werror -ffile-prefix-map="$ROOT"=/src \
  -Wl,--strip-all -Wl,--initial-memory=131072 -Wl,--max-memory=33554432)

mkdir -p "$ROOT/binaries" "$ROOT/rebuild-check" "$ROOT/logs" "$ROOT/metadata"
echo "toolchain=$($CC --version | head -1)" > "$ROOT/logs/build.log"
# Deterministic double-build + byte-identity, exactly the a2/b2 discipline:
"$CC" "${FLAGS[@]}" "${SOURCES[@]}" -o "$ROOT/binaries/jq_filter_bounded.wasm"
"$CC" "${FLAGS[@]}" "${SOURCES[@]}" -o "$ROOT/rebuild-check/jq_filter_bounded.wasm"
cmp "$ROOT/binaries/jq_filter_bounded.wasm" "$ROOT/rebuild-check/jq_filter_bounded.wasm"
(cd "$ROOT" && sha256sum binaries/*.wasm) > "$ROOT/metadata/binary-sha256.txt"
echo "deterministic double-build byte-identical (NOT YET RUN — see BLOCKERS)"
