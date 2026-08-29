# T3 trio — sed, awk, date (Tranche 2 Admission)

## sed (minised 1.16, BSD-3-Clause): ADMITTED
minised 1.16 compiled byte-reproducibly to WASI preview-1 (`sed/binaries/sed.wasm`, 13 imports, 49,975 bytes).

## awk (clean-room 0BSD): ADMITTED
Clean-room 0BSD awk engine implemented without setjmp/signal/fork (`awk/binaries/awk.wasm`), pure-WASI preview-1 (wasi-libc, default tier ≤16MiB, ~35KB). Field extraction ($1, $2, $NF, NF, NR, FS), patterns (/regex/, BEGIN, END), expressions, and print statements verified.

## date (clean-room 0BSD): ADMITTED
Clean-room 0BSD date utility implemented (`date/binaries/date.wasm`), pure-WASI preview-1 backed by wasi-libc clock_time_get(CLOCK_REALTIME). Custom strftime formatting (+FORMAT), UTC (-u), ISO 8601 (-I), and epoch parsing (-d @EPOCH) verified.

## RESULT
All three T3 trio tools (sed, awk, date) are now fully ADMITTED and runnable under the CAP WASI preview-1 runtime.
