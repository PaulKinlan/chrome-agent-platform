# sed_filter_bounded — bounded immutable spec contract
- toolId: sed_filter_bounded
- upstream: minised 1.16 (BSD-3-Clause), source tag 1.16
- request: { script: string (≤2KiB, the sed program), input: string (≤64KiB, stdin) }
- flags: -n (suppress auto-print), -e SCRIPT (append program)
- response: { output: string (≤64KiB) }
- bounds: script ≤2KiB, input ≤64KiB, output ≤64KiB, timeout 5s, memory default (no growth flag)
- error contract: raw sed stderr NEVER forwarded (bounded "sed failed" only)
- imports: 13 WASI-preview1 (no JS), 1 memory, ~60KB → default tier
