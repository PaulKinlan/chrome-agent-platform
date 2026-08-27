# xan lane — BLOCKED (build feasibility)

STOP-and-report, mirroring the tokei precedent. See BLOCKED.md for the exact
blocker: `pager@0.16.1 → errno@0.2.8`'s nightly `#![feature(thread_local)]` gate
on `target_os="wasi"`, the last 0.2.x before errno's 0.3 line. Licence-clean
(MIT OR Unlicense). Unblock paths are listed (one-line errno patch, or pager
fork, or drop the pager dep — all irrelevant to a WASI tool). Deferred pending a
patch decision.
