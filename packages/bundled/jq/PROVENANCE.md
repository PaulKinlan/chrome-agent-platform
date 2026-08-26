# jq_filter_bounded — provenance & the five never-fabricate inputs

Tier-1 admission candidate (owner-approved via CAP-FB-20260823-EXTENDED-TOOL-FAMILIES-01,
option a). This file records the PROVENANCE ANCHOR the house admission pipeline
requires BEFORE any binary may ship. It is a plan/contract, NOT an admission
claim — the actual retained build + import/memory census cannot run in this
environment (see BLOCKERS below and the build.sh).

## Five never-fabricate inputs (every one must be real, independently
## re-verifiable, and hash-pinned before the package is admitted)

1. **source.repo** — upstream: `https://github.com/jqlang/jq` (public).
2. **source.commit** — PINNED revision (to be fixed at build time; the triage did
   NOT pin a commit — see blocker B2). The system `jq --version` is 1.8.2, but the
   house rule requires an exact immutable git SHA, not a distro version.
3. **binary.sha256** — the content-addressed `extension/wasm/cas/<sha256>.wasm`
   identity (does NOT exist yet — no build has run).
4. **build.log + toolchain** — the deterministic retained-build log proving the
   exact toolchain (`wasi-sdk 22.1.8`, as pinned by every existing a2/b2/c2 lane)
   + `SOURCE_DATE_EPOCH=0` + double-build byte-identity.
5. **sbom** — a CycloneDX/SPDX SBOM enumerating jq core + every bundled
   third-party component (oniguruma, decNumber, dtoa, Heimdal-derived code).

None of these five may be invented. They are documented here as REQUIRED and
UNSET, which is the honest pre-admission state.

## BLOCKERS (why this is a partial package, not an admission)

- **B1 — no wasi-sdk 22.1.8 toolchain in this environment.** `WASI_SDK` is unset;
  no `wasi-sysroot` exists; the system `clang` (22) has no wasm32-wasi sysroot.
  Every existing lane's build.sh hard-requires `WASI_SDK` (host path scrubbed on
  repo migration). The deterministic retained build is therefore IMPOSSIBLE here
  and must run in the pinned build environment.
- **B2 — jq source is not pinned/vendored.** The repo has no `packages/bundled/jq/source`
  and no pinned upstream commit. jq is a large C program (core + oniguruma regex
  engine + decNumber bignum + dtoa + a main() loop), NOT a single-file CAP-authored
  tool like the a2/b2 lanes — a clean-room/wasi port is a multi-hour native-build
  effort, not a "mirror a2/b2" task.
- **B3 — scripts/safe-build-env.sh does not exist in this repo** (referenced by the
  brief; the safe build environment lives elsewhere). The retained-build preflight
  cannot be reproduced from this checkout.

## Licence structure (for NOTICES, authoritative)

- **jq core** — MIT (copyright (C) 2012 Stephen Dolan). Confirmed against the
  system `COPYING` (verbatim MIT text, jq 1.8.2).
- **oniguruma** (bundled regex) — BSD-2-Clause (oniguruma 6.x).
- **decNumber** (ICU) — ICU / Unicode-DFS 2016 licence.
- **dtoa** (David Gay) — the permissive dtoa licence (MIT-compatible).
- **Heimdal-derived hex/base64** — BSD-3-Clause (Heimdal).

These are the components the triage flagged as needing NOTICES; the NOTICES file
(./NOTICES.md) documents each.
