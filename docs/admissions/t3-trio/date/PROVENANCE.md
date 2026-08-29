# date_formatter_bounded provenance

- **Source repository:** `https://github.com/PaulKinlan/chrome-agent-platform`
- **Source commit:** `486005dbfb84bd8ae9f469ee1f83f3e91f9b038c`
- **Source file:** `docs/admissions/t3-trio/date/source/main.c`
- **Source SHA-256:** `d9dd6502f98c5b7cbc0f3cb155e539b33043c87c7c60ccda25c5bd046c8be530`
- **Binary SHA-256:** `a762e1cdcbfa18f5497fd39a20a4158f74173737187e5bd85a67acebf6b737a8`
- **Binary size:** 52,459 bytes
- **Build receipt:** `metadata/build-receipt.txt` (scrubbed, retained)
- **Toolchain:** wasi-sdk clang 18.1.2; wasm32-wasip1; wasi-libc from that SDK sysroot
- **SBOM:** `sbom.cdx.json`
- **Reproducibility:** `binaries/date.wasm` and `metadata/rebuild-date.wasm` are byte-identical; tests compare every byte and both digests.

This is a clean-room bounded formatter, not the canonical date utility. It accepts
numeric epochs and exact UTC ISO dates/timestamps. Invalid dates and missing `-d`
operands emit bounded diagnostics and exit nonzero; they never silently use now.
