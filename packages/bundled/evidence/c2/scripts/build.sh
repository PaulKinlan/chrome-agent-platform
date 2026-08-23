#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C TZ=UTC SOURCE_DATE_EPOCH=0
# toolchain: wasi-sdk clang 22.1.8; original build-host root path
# scrubbed on repo migration (owner directive) — receipt is documentary
ROOT="${CAP_C2_BUILD_ROOT:-$(mktemp -d)}"
SDK="${WASI_SDK:?set WASI_SDK to a wasi-sdk 22.1.8 install}"
SYSROOT="$SDK/share/wasi-sysroot"
CC="$SDK/bin/clang"
TOOLS=(file du stat tree touch truncate)
FLAGS=(--target=wasm32-wasi --sysroot="$SYSROOT" -std=c99 -O2 -Werror -Wall -Wextra -Wl,--strip-all -Wl,--max-memory=33554432)
mkdir -p "$ROOT/binaries" "$ROOT/rebuild" "$ROOT/logs"
: > "$ROOT/logs/build.log"
printf 'toolchain: ' >> "$ROOT/logs/build.log"; "$CC" --version | head -1 >> "$ROOT/logs/build.log"
printf 'environment: SOURCE_DATE_EPOCH=%s LC_ALL=%s TZ=%s\n' "$SOURCE_DATE_EPOCH" "$LC_ALL" "$TZ" >> "$ROOT/logs/build.log"
for tool in "${TOOLS[@]}"; do
  for outdir in binaries rebuild; do
    "$CC" "${FLAGS[@]}" -I"$ROOT/sources" -o "$ROOT/$outdir/$tool.wasm" "$ROOT/sources/$tool/main.c" >> "$ROOT/logs/build.log" 2>&1
  done
  h1=$(sha256sum "$ROOT/binaries/$tool.wasm" | cut -d' ' -f1); h2=$(sha256sum "$ROOT/rebuild/$tool.wasm" | cut -d' ' -f1)
  [[ "$h1" == "$h2" ]] || { echo "NONDETERMINISTIC $tool $h1 $h2" | tee -a "$ROOT/logs/build.log"; exit 1; }
  printf 'OK %s sha256=%s size=%s two-build-match=true\n' "$tool" "$h1" "$(stat -c%s "$ROOT/binaries/$tool.wasm")" | tee -a "$ROOT/logs/build.log"
done
SRC="$ROOT/sources/markdown/cmark-0.31.1/src"; GEN="$ROOT/sources/markdown/generated"
CMARK_SOURCES=(blocks.c buffer.c cmark.c cmark_ctype.c commonmark.c houdini_href_e.c houdini_html_e.c houdini_html_u.c html.c inlines.c iterator.c latex.c man.c node.c references.c render.c scanners.c utf8.c xml.c main.c)
CMARK_ARGS=(); for s in "${CMARK_SOURCES[@]}"; do CMARK_ARGS+=("$SRC/$s"); done
for outdir in binaries rebuild; do
  "$CC" "${FLAGS[@]}" -DCMARK_STATIC_DEFINE -I"$SRC" -I"$GEN" -o "$ROOT/$outdir/markdown.wasm" "${CMARK_ARGS[@]}" >> "$ROOT/logs/build.log" 2>&1
done
h1=$(sha256sum "$ROOT/binaries/markdown.wasm" | cut -d' ' -f1); h2=$(sha256sum "$ROOT/rebuild/markdown.wasm" | cut -d' ' -f1)
[[ "$h1" == "$h2" ]] || { echo "NONDETERMINISTIC markdown $h1 $h2" | tee -a "$ROOT/logs/build.log"; exit 1; }
printf 'OK markdown sha256=%s size=%s two-build-match=true\n' "$h1" "$(stat -c%s "$ROOT/binaries/markdown.wasm")" | tee -a "$ROOT/logs/build.log"
