# awk_filter_bounded — immutable Settings-preview contract

- toolId: `awk_filter_bounded`
- implementation: clean-room 0BSD bounded awk subset (`source/main.c`)
- CAP request: argv contains one program (≤512 UTF-8 bytes) plus optional `-F` separator; stdin ≤2 KiB; the immutable preview projects an empty per-job workspace
- direct-binary flags: `-F FS`, `-v var=val`, `--`; direct file operands are accepted for build verification, but CAP preview file operands fail closed because no files are projected
- pattern subset: `/literal/`, `/^literal/`, `/literal$/`, `/^literal$/`; only edge anchors are special, all other regex metacharacters are literal
- actions: bounded `print`, `BEGIN`, `END`; fields `$0`, `$1..$127`, `$NF`; variables `NR`, `NF`, `FS`, `OFS`
- response: UTF-8 stdout ≤1 MiB (Settings display additionally bounds text to 256 KiB)
- errors: invalid options and missing direct file operands emit bounded stderr and exit nonzero
- runtime: `wasi_snapshot_preview1` only; one non-shared memory; 58,623 bytes; tiny tier (≤32 MiB declared max)
- route: exact Settings document → `tool.preview.run`; immutable manifest/CAS/spec revalidated on every run
