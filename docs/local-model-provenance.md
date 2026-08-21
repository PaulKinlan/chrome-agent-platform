# Local-model catalog provenance (Gemma 4 QAT q4_0 pins)

Every catalog entry in `extension/lib/local-model-catalog.js` pins exact
publisher revisions, byte sizes and SHA-256 values. This file records the
INDEPENDENT provenance verification performed against the live publisher
(HuggingFace) on **2026-08-21**, so a reviewer can re-derive the pins without
trusting the module's own literals.

## Verification method

For each model:

1. `GET https://huggingface.co/api/models/<repo>` — confirms the official
   `google/` publisher namespace, the model identity, and the Apache-2.0
   license tag.
2. `GET https://huggingface.co/api/models/<repo>/tree/main` — the repo tree at
   the pinned revision; each file's `size` (bytes) and `lfs.oid` (the Git-LFS
   SHA-256 of the exact object, i.e. the file's SHA-256) are read from the
   publisher's own metadata.
3. The catalog's pinned `bytes` must equal the tree's `size` and the catalog's
   pinned `sha256` must equal the tree's `lfs.oid`.

The E4B pin was verified on 2026-08-21 via the same live-tree check (the
`google/gemma-4-E4B-it-qat-q4_0-gguf` tree exposes the 5,154,941,280-byte model
with SHA-256 `676c3507…` and the 991,552,256-byte mmproj with SHA-256
`7498a37c…`).

## 26B-A4B (verified live 2026-08-21)

- Repo: `google/gemma-4-26B-A4B-it-qat-q4_0-gguf`
  - API model id resolves; tags include `gguf`,
    `base_model:google/gemma-4-26B-A4B-it-qat-q4_0-unquantized`, `license:apache-2.0`.
- Pinned revision: `d1c082be9cf3c8a514acf63b8761f4b41935842e`
- Base repo: `google/gemma-4-26B-A4B-it` @ `4d7ae4984b7db7de8f8457170b3f1a419ee76d52`
- Tree (at `main`) file metadata:

| file | tree `size` (bytes) | tree `lfs.oid` (SHA-256) | catalog pin | match |
|---|---|---|---|---|
| `gemma-4-26B_q4_0-it.gguf` | 14,439,363,584 | `3eca3b8f6d7baf218a7dd6bba5fb59a56ee25fe2d567b6f5f589b4f697eca51d` | 14_439_363_584 + same SHA | ✓ |
| `gemma-4-26B-it-mmproj.gguf` | 1,194,828,160 | `a359953a076b877db30c31dbbb4c6d93b4a6e017ee5db5784247e4d4c0dd4f3b` | 1_194_828_160 + same SHA | ✓ |

Installed payload disclosure: `15_634_191_744` bytes / 14.56 GiB =
14,439,363,584 + 1,194,828,160 (exact).

## E4B (verified live 2026-08-21)

- Repo: `google/gemma-4-E4B-it-qat-q4_0-gguf`
- Pinned revision: `4b4a2c1d584be7264f87aac328a1bc739ce81b6c`
- Base repo: `google/gemma-4-E4B-it` @ `ee0ef6023621cff504d758262d4e04895a5af4a2`
- Files: `gemma-4-E4B_q4_0-it.gguf` (5,154,941,280 bytes, SHA-256
  `676c35070db6dbe52f93e9c864ee0fba4eddea94b9c875d9cb10daff453fbaee`) +
  `gemma-4-E4B-it-mmproj.gguf` (991,552,256 bytes, SHA-256
  `7498a37cb619e55f2fcf87eb931f56e99389ed6d432e4c5c66110694c0d65578`).

## Limitations

- The pins are immutable content addresses; a publisher-side revision rotation
  does not invalidate a pinned revision (the URL embeds the 40-hex commit).
- The live checks were performed over the public network on 2026-08-21; a
  re-verification at the browser gate is recommended but the pinned values are
  what the probe will assert against, regardless of what the publisher serves
  at `main`.
