# T3 trio — awk + date: STOP-and-report (honest blockers)

## awk (onetrueawk, Lucent permissive — NOT GPL): BLOCKED
onetrueawk's core control flow is WASI-incompatible:
- run.c: setjmp()/longjmp() (lines 184, 202) for break/next/exit control flow — requires the WebAssembly Exception-Handling proposal (`-mllvm -wasm-enable-sjlj`) + a runtime that implements EH. The house WASI runtime does not.
- main.c:158 `signal(SIGFPE, fpecatch)` — signal emulation (`-D_WASI_EMULATED_SIGNAL` + `-lwasi-emulated-signal`) is NOT present in wasi-sysroot-22.0 (only getpid/mman/process-clocks emulation ships).
- run.c:2110 `system()` — process spawn is impossible on WASI preview1.
Porting requires rewriting awk's setjmp-based flow + stubbing signal/system — beyond a clean single-tool admission. RECOMMENDATION: a clean-room 0BSD awk-subset (the a2/b2 C-house precedent), not a port.

## date (toybox, 0BSD): BLOCKED (scope, not licence)
toybox date is one applet of a large multi-applet project; a single-tool build requires the FULL toybox build system (config-generated toys.h + GLOBALS macro + the lib/*.c tree: lib.c, xwrap.c, args.c, portability.c, env.c, ...). No clean cherry-pick. RECOMMENDATION: a clean-room 0BSD date-subset (epoch/ISO/strftime via wasi-libc clock) — trivial vs porting toybox.

## RESULT
sed = ADMITTED (built, reproducible, runs: "hello world" | sed 's/world/there/' → "hello there").
awk + date = STOP, honest blockers above, with the clean-room recommendation.
