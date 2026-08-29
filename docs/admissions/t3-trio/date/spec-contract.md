# date_formatter_bounded — immutable Settings-preview contract

- toolId: `date_formatter_bounded`
- implementation: clean-room 0BSD bounded date formatter (`source/main.c`)
- request: up to four args (each ≤512 UTF-8 bytes, ≤1 KiB total); empty stdin
- flags: `+FORMAT`, `-u`/`--utc`/`--universal`, `-d SPEC`/`--date=SPEC`, `-I[FMT]`
- accepted date specs: signed numeric epoch, `@`-prefixed epoch, exact `YYYY-MM-DD`, exact `YYYY-MM-DDTHH:MM:SS` (or one space instead of `T`)
- response: UTF-8 stdout ≤1 MiB (utility output buffer is 4 KiB; Settings display additionally bounds text to 256 KiB)
- errors: missing `-d` operands, empty/invalid specs, and unknown options emit bounded stderr and exit nonzero; invalid input never silently becomes current time
- runtime: `wasi_snapshot_preview1` only (`clock_time_get`); one non-shared memory; 52,291 bytes; tiny tier (≤32 MiB declared max)
- route: exact Settings document → `tool.preview.run`; immutable manifest/CAS/spec revalidated on every run
