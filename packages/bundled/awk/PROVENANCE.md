# awk_filter_bounded provenance

- **Source repository:** `https://github.com/PaulKinlan/chrome-agent-platform`
- **Source commit:** `486005dbfb84bd8ae9f469ee1f83f3e91f9b038c`
- **Source file:** `docs/admissions/t3-trio/awk/source/main.c`
- **Source SHA-256:** `4460946b6bd9b684148974630ce62471cc16294134f9888259fe11c7ee7ec043`
- **Binary SHA-256:** `e415ab94548da2d14bef43457cb9a990e66c3d8a151ba16e067f61d685d32312`
- **Binary size:** 58,623 bytes
- **Build receipt:** `metadata/build-receipt.txt` (scrubbed, retained)
- **Toolchain:** wasi-sdk clang 18.1.2; wasm32-wasip1; wasi-libc from that SDK sysroot
- **SBOM:** `sbom.cdx.json`
- **Reproducibility:** `binaries/awk.wasm` and `metadata/rebuild-awk.wasm` are byte-identical; tests compare every byte and both digests.

The source is a clean-room bounded awk subset, not the canonical awk utility.
Its `/pattern/` condition is literal substring matching with optional leading `^`
and trailing `$` anchors; other regex metacharacters are literal. The CAP preview
projects no files and is stdin-only. The binary also accepts direct file operands
for build verification; missing files fail nonzero.
