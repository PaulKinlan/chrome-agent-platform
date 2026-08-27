# rayon-wasi — serial fallback shim for `rayon` under wasi-preview1

`rayon`'s thread pool calls `std::thread::spawn`, which **panics** under
wasi-preview1 (no threads). This shim replaces `rayon` via `[patch.crates-io]`
and reimplements the SUBSET of the rayon API the CAP toolchain uses — parallel
slice sorts, parallel iteration, the thread-pool builder, and the top-level
`spawn`/`join`/`scope` helpers — by delegating to the **serial** std
equivalents. **No thread is ever spawned.**

## Semantics (honest)
- `par_sort_unstable_by` / `par_sort_by` → `sort_unstable_by` / `sort_by` (same
  comparator, same output, same stability of the unstable sort; runs serially).
- `par_iter().try_for_each` → `iter().try_for_each` (same order, same
  short-circuit-on-error; the rayon `par_iter` order was already unspecified, so
  this is strictly MORE deterministic).
- `ThreadPoolBuilder::build_global()` → `Ok(())` no-op. A tool's `--parallel`
  flag is **accepted but runs serially** (correct results, no speed-up).
- Only the exact traits/methods the tools use are provided — any other rayon API
  fails to COMPILE (loudly), never silently misbehaves.

## Licence
MIT OR Apache-2.0 (our shim; no new dependencies — std-only).

## Use
```toml
# tool's Cargo.toml
[patch.crates-io]
rayon = { path = "<abs path to this dir>" }
```
The build.sh for each admitted tool computes the absolute path from the worktree
root so the admission is reproducible across checkouts.
