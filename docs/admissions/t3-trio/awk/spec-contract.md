# awk_filter_bounded — bounded immutable spec contract
- toolId: awk_filter_bounded
- upstream: clean-room 0BSD awk engine (source/main.c)
- request: { script: string (≤2KiB, the awk program), input: string (≤64KiB, stdin), fs?: string (≤64 bytes, field separator) }
- flags: -F FS (field separator), -v var=val (variable assignment), -- (end of options)
- response: { output: string (≤64KiB) }
- bounds: script ≤2KiB, input ≤64KiB, output ≤64KiB, timeout 5s, memory default (32 MiB max)
- error contract: raw stderr never forwarded; bounded diagnostics
- imports: wasi_snapshot_preview1 only, 1 memory, ~35KB → default tier
