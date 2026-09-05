# Changelog integrity repair — 2026-09-05 (chrome-agent-platform-xk2u)

Owner-flagged: the 0.3 series had **93 placeholder entries** ("Maintenance and
fixes.") and **8 gap versions** (0.3.104–107, 0.3.174, 0.3.177, 0.3.235,
0.3.237, 0.3.238). This document is the audit ledger for the repair: every
reconstructed entry cites its source commits; every dropped version is
accounted for.

## Root causes (all three now gated)

1. **Placeholder fallback in `scripts/bump-version.mjs`**: when the commit
   message sanitized to empty (merge subjects, bare branch names), the script
   wrote "Maintenance and fixes." — 93 times.
2. **Machine-local post-commit hook** bumped the version on EVERY commit,
   including bookkeeping-only merge commits, and silenced all output
   (`>/dev/null 2>&1`).
3. **Parallel-lane version race**: lanes branched off the same base each bumped
   from it, so numbers were consumed twice (e.g. two lanes took 0.3.229→235) or
   backwards (0.3.232→0.3.217). Gap versions were never created by any commit.

## Repair decisions

- **Reconstructed** (6): placeholder versions whose release window carried real
  user-visible content not covered by a neighbouring entry.
- **Rewritten to user language** (9): entries that were raw commit subjects.
- **Dropped** (109): placeholder versions whose windows carried only
  bookkeeping (version churn, lane re-merges with no tree change), entries
  whose content is covered by a neighbouring entry, and exact duplicate text.
- **Renumbered**: the 0.3 series is now contiguous 0.3.147–0.3.241 (top =
  package.json). The 0.2 series is frozen as-is (ordered; historical gaps
  documented, not rewritten).
- Citations live here, not in the user-facing file (bare SHAs fail the shipped
  language filter by design).

## Reconstructed entries → source commits

| New entry (final position varies after renumber) | Source commits |
|---|---|
| Agent Directory + per-site enrollment policy (was 0.3.190) | 2f80bdb6 (feat), merged 7b155e34; + 63c34dd5 (table-preview XSS test) |
| Settings model-field save reliability (was 0.3.179) | 24295efc, 3bf15b88, merged 2759278d |
| Provider server-tools toggle survives reload (was 0.3.119) | 3671fe66 + 03661a03 (browser proof), merged 1f65ee0d |
| Semantic tool search (was 0.3.101) | 84d6716b + 96c591a6 (review fix), merged 7c502923 |
| Provider install-grant verification (was 0.3.66) | fa5a4699, merged a66f0dbb |
| Backup/restore export-import (was 0.3.57) | 8a15e836, merged add1bb06 |

## Rewritten entries → source commits

| Entry | Source |
|---|---|
| Wasm catalogue v1 (was 0.3.229) | 14e2a817 |
| Changelog sync + recovery-merge notes (was 0.3.227) | the 60em reland lane |
| 9tg milestone 3, tabular contracts (was 0.3.165) | 8ddfc203 |
| Build-scanner stray-copy fix (was 0.3.131) | its commit |
| Pyodide runtime restored (was 0.3.130) | 449836db |
| Real Pyodide 0.26.4 bundled (was 0.3.127) | its commit |
| Python via Pyodide landing (was 0.3.96) | brv lane |
| Build lock file fix (was 0.3.84) | 6d96eff9-era |
| Release-notes voice + hook sanitize (was 0.3.52) | 8ab84f8a |

## Coverage verification (the bead's named landings were NOT lost)

- 9tg pillars → entries at (old) 0.3.160–165 ✓ (kept)
- xzp2 nine uncapped Unix tools → (old) 0.3.173 ✓ (kept)
- 86oj genuine-runs migration → (old) 0.3.230 ✓ (kept)
- def integration → (old) 0.3.212–216 ✓ (kept)
- hdbi journeys repair → 7ff2f479 = (old) 0.3.175 ✓ (kept)
- cs0x suite consistency → internal test-health; covered by (old) 0.3.131 rewrite

## Dropped versions ledger

Each dropped version's bump commit (proof the window carried no unique
user-visible content) — "—" means the version number never existed (race):
| 0.3.222 | fd0c9e74 |
| 0.3.221 | c38e0838 |
| 0.3.220 | 5c615237 |
| 0.3.219 | 473c4bb4 |
| 0.3.218 | eef08786 |
| 0.3.217 | fd0fa066 |
| 0.3.211 | 5a3eface |
| 0.3.210 | 53c48b39 |
| 0.3.209 | 01c6aade |
| 0.3.208 | b1ab641a |
| 0.3.207 | 93b49dd4 |
| 0.3.206 | 6ed55d21 |
| 0.3.205 | 436d3475 |
| 0.3.204 | 03e0fc95 |
| 0.3.203 | 951662fa |
| 0.3.202 | 86f64c68 |
| 0.3.201 | be9d475c |
| 0.3.200 | 19d40d72 |
| 0.3.199 | 062516c5 |
| 0.3.198 | 202e6663 |
| 0.3.197 | b8e8a60e |
| 0.3.196 | 3e85294e |
| 0.3.195 | bd1d8116 |
| 0.3.194 | d5af89c2 |
| 0.3.193 | 39a795f6 |
| 0.3.192 | b5c13526 |
| 0.3.191 | 78e4ecf6 |
| 0.3.188 | fb67bd92 |
| 0.3.187 | 1e1d03f7 |
| 0.3.186 | 44b30fa3 |
| 0.3.185 | 49d04df5 |
| 0.3.184 | 64ddc2dc |
| 0.3.183 | d2ce360b |
| 0.3.182 | ec7d80ed |
| 0.3.181 | 4f9cfadc |
| 0.3.180 | 5771eb20 |
| 0.3.174 | — (version never existed; parallel-lane race) |
| 0.3.162 | 96e5406c |
| 0.3.154 | 6398d8c5 |
| 0.3.148 | — (version never existed; parallel-lane race) |
| 0.3.140 | 75364f28 |
| 0.3.136 | ea3cafb0 |
| 0.3.135 | e85753de |
| 0.3.134 | 46368f49 |
| 0.3.129 | 39fe4fdb |
| 0.3.126 | be3bef2e |
| 0.3.125 | 365a6556 |
| 0.3.124 | 60629a2a |
| 0.3.123 | 34531007 |
| 0.3.122 | a71535f9 |
| 0.3.121 | 60681d86 |
| 0.3.120 | 4522951d |
| 0.3.118 | c3651b53 |
| 0.3.117 | 4ad908af |
| 0.3.116 | 2018abb9 |
| 0.3.115 | 18b020d9 |
| 0.3.114 | b9d60a2d |
| 0.3.113 | b7d222ce |
| 0.3.112 | d5c768d5 |
| 0.3.110 | 43a30074 |
| 0.3.108 | 8a079fe3 |
| 0.3.103 | 1143e8fd |
| 0.3.102 | 82269dd5 |
| 0.3.99 | 8dbccce1 |
| 0.3.98 | e53d8125 |
| 0.3.97 | ce2438bd |
| 0.3.95 | 148c4fcb |
| 0.3.94 | 3821f9e9 |
| 0.3.93 | b82629d5 |
| 0.3.92 | 281b9313 |
| 0.3.91 | c086cb79 |
| 0.3.90 | e3f41fd1 |
| 0.3.89 | 991793c5 |
| 0.3.88 | 51c68971 |
| 0.3.87 | 5c1c2ad4 |
| 0.3.86 | a00cd659 |
| 0.3.85 | 0a11c145 |
| 0.3.83 | b997ca4a |
| 0.3.82 | 24e750d9 |
| 0.3.81 | ecfef669 |
| 0.3.80 | f7753625 |
| 0.3.79 | fb3cc072 |
| 0.3.78 | f6ebe7f5 |
| 0.3.77 | 77acda58 |
| 0.3.76 | 4421ada5 |
| 0.3.75 | 4050a3d6 |
| 0.3.74 | f758c6e1 |
| 0.3.73 | 7939473b |
| 0.3.72 | aac7f51e |
| 0.3.71 | 8d0b0380 |
| 0.3.70 | 1bab9615 |
| 0.3.69 | 597a9e01 |
| 0.3.68 | ae099676 |
| 0.3.67 | 113301b3 |
| 0.3.64 | — (version never existed; parallel-lane race) |
| 0.3.63 | — (version never existed; parallel-lane race) |
| 0.3.62 | — (version never existed; parallel-lane race) |
| 0.3.61 | 1932b6b0 |
| 0.3.60 | — (version never existed; parallel-lane race) |
| 0.3.59 | 0a093d9c |
| 0.3.58 | c396e9b2 |
| 0.3.54 | a8008736 |
| 0.3.37 | e3594314 |
