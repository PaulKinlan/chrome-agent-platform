#!/usr/bin/env bash
# gzip (zlib 1.3.1 Z_SOLO minigzip + CAP-authored freestanding runtime).
# The exact units/flags/two-build evidence is the retained receipt
# receipts/gzip-build.json inside the pinned evidence tree
# (packages/bundled/evidence/d3, inventory sha256 7ddeea056eec79eaa0c496522297d9f381293532816f2085611c027584482af9);
# toolchain clang 22.1.8 / wasm-ld 22.1.8, target wasm32-unknown-unknown,
# SOURCE_DATE_EPOCH=1716422400. Both trusted builds were byte-identical:
# sha256 d03a2558682ea04653d34753eae8df1fcd5cc8d92fc53de43106c3db0e1c57dc (56,938 B).
# This script intentionally does NOT re-run the build: reproduction requires
# the pinned source archive + overlay recorded in that receipt.
echo "see receipts/gzip-build.json in the frozen evidence tree" >&2; exit 0
