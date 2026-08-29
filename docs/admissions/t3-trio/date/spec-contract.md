# date_formatter_bounded — bounded immutable spec contract
- toolId: date_formatter_bounded
- upstream: clean-room 0BSD date utility (source/main.c)
- request: { format?: string (≤256 bytes, strftime format), date?: string (≤64 bytes, @epoch or ISO), utc?: boolean, iso?: string }
- flags: +FORMAT (custom strftime), -u/--utc (UTC time), -d/--date=SPEC (custom date/epoch), -I[FMT] (ISO 8601 format)
- response: { output: string (≤4KiB) }
- bounds: format ≤256B, output ≤4KiB, timeout 5s, memory default (32 MiB max)
- error contract: raw stderr never forwarded; bounded diagnostics
- imports: wasi_snapshot_preview1 only (clock_time_get), 1 memory, ~35KB → default tier
