# date_formatter_bounded provenance

- **Source repository:** `https://github.com/PaulKinlan/chrome-agent-platform`
- **Source commit:** `d748876ae51dd6b1def64fd206916adf9d33cc62`
- **Source file:** `docs/admissions/t3-trio/date/source/main.c`
- **Source SHA-256:** `8018b93306115905b8e149debb9ed25b2c47d946a9c6a6bd89e86154221baa23`
- **Binary SHA-256:** `cb8b4e72f1ea3ab9f5134c8e789f0f5343f4d6043218cca0a3253ff56eacfd66`
- **Binary size:** 52,291 bytes
- **Build receipt:** `metadata/build-receipt.txt` (scrubbed, retained)
- **Toolchain:** wasi-sdk clang 18.1.2; wasm32-wasip1; wasi-libc from that SDK sysroot
- **SBOM:** `sbom.cdx.json`
- **Reproducibility:** `binaries/date.wasm` and `metadata/rebuild-date.wasm` are byte-identical; tests compare every byte and both digests.

This is a clean-room bounded formatter, not the canonical date utility. It accepts
numeric epochs and exact UTC ISO dates/timestamps. Invalid dates and missing `-d`
operands emit bounded diagnostics and exit nonzero; they never silently use now.
