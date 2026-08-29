# date_formatter_bounded provenance

- **Source repository:** `https://github.com/PaulKinlan/chrome-agent-platform`
- **Source commit:** set by the admission commit after the corrected source is committed
- **Source file:** `docs/admissions/t3-trio/date/source/main.c`
- **Source SHA-256:** `fd9ffecdb44b8730c1214c5d38b65a0e76297f658dcb39ea7b2370ce6eb69790`
- **Binary SHA-256:** `ceb8b08f4b82f9eb4977f2d182ef6a3f3928e74ca2c8a9834f69a50ff10ffef0`
- **Binary size:** 52,024 bytes
- **Build receipt:** `metadata/build-receipt.txt` (scrubbed, retained)
- **Toolchain:** wasi-sdk clang 18.1.2; wasm32-wasip1; wasi-libc from that SDK sysroot
- **SBOM:** `sbom.cdx.json`
- **Reproducibility:** `binaries/date.wasm` and `metadata/rebuild-date.wasm` are byte-identical; tests compare every byte and both digests.

This is a clean-room bounded formatter, not the canonical date utility. It accepts
numeric epochs and exact UTC ISO dates/timestamps. Invalid dates and missing `-d`
operands emit bounded diagnostics and exit nonzero; they never silently use now.
