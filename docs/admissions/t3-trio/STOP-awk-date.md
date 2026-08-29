# Bounded awk/date — tranche 2 admission checkpoint

## awk_filter_bounded: ADMITTED

The clean-room 0BSD subset is bundled through CAP's immutable package authority
as `cap.bundled.awk.filter.bounded@1.0.0`. Its 58,623-byte preview-1 binary is
content-addressed at SHA-256
`e415ab94548da2d14bef43457cb9a990e66c3d8a151ba16e067f61d685d32312`.
The Settings-only `tool.preview.run` route executes field extraction, `-F`,
`BEGIN`/`END`, and literal patterns with optional `^`/`$` edge anchors. It does
not claim general regular-expression compatibility. CAP projects an empty
workspace, so this admission is stdin-only; direct file operands remain a
supplementary build check and missing files fail nonzero.

## date_formatter_bounded: ADMITTED

The clean-room 0BSD formatter is bundled through the same authority as
`cap.bundled.date.formatter.bounded@1.0.0`. Its 52,459-byte preview-1 binary is
content-addressed at SHA-256
`a762e1cdcbfa18f5497fd39a20a4158f74173737187e5bd85a67acebf6b737a8`.
The Settings-only route executes UTC, ISO, numeric epoch, and exact ISO date
formatting. Invalid dates and missing `-d` operands fail nonzero with bounded
diagnostics rather than silently using the current time.

Both binaries have retained byte-identical rebuilds, relative hash records,
scrubbed receipts, wasi-libc component inventory, CycloneDX SBOMs, notices,
immutable preview specs, manifest/CAS identities, direct runtime KATs, and a
loaded-extension browser KAT through the production route.

The adjacent sed artifact is only a supplementary direct-WASI build proof in
this tranche; this checkpoint does not claim that sed is bundled or admitted.
Tokei is outside this tranche and is not claimed here.
