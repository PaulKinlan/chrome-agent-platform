# Local Models — Architecture (removed, log for future rebuild)

> Removed 2026-08-26. The built-in "Local models" (OPFS GGUF download + on-device
> inference) support was removed because its download never worked within Chrome's
> storage constraints. The owner's replacement path is **Ollama** (a local,
> OpenAI-compatible endpoint — still fully supported as a provider). This doc
> captures how the removed feature worked so it can be rebuilt later (git history:
> `git log -- extension/lib/local-model-manager.js` etc.).

## What the feature did

A "Local models" Settings section let the owner download a publisher-signed GGUF
model into OPFS and run it on-device as a provider.

### Components (files that were removed)

- `extension/lib/local-model-catalog.js` — the product-owned, publisher-origin
  model catalogue. Two frozen catalog entries:
  - `gemma-4-e4b-it-qat-q4_0` (5.72 GiB installed) — `google/gemma-4-E4B-it-qat-q4_0-gguf`
  - `gemma-4-26b-a4b-it-qat-q4_0` (14.56 GiB) — `google/gemma-4-26B-A4B-it-qat-q4_0-gguf`
  Each entry pinned an exact repo + revision + per-file byte size + SHA-256, and a
  `files` list (the GGUF weights + an `mmproj` multimodal projector). Also exposed:
  - `getCatalogModel(modelId)` — lookup by id.
  - `localModelFeasibility({deviceMemory, memory64, opfs, availableStorageBytes})` —
    a preflight gate (OPFS available + enough storage + device-memory bound).
  - `preflightLocalModel(model)` — a `bytes=0-0` Range probe against the publisher
    URL, validating the FINAL `response.url` against a trusted delivery allowlist
    (`*.huggingface.co`, `*.hf.co`) before trusting anything (no manual redirect
    chain re-implemented).
- `extension/lib/local-model-manager.js` — the download/install/delete engine:
  - `StreamingSha256` — an O(1)-memory incremental SHA-256 (never buffers the
    full file).
  - `getModelsOpfsRoot()` / `listInstalledModels()` / `getInstalledModelRecord()` —
    OPFS-backed install registry (which models/files are present + their hashes).
  - `downloadLocalModel({modelId, signal, onProgress})` — the core: per-file
    download with `Range` resume (prefix-hash continuity; 200-fallback restart),
    chunked `.part` → final promotion (O(1) peak memory), SHA-256 verified
    fail-closed (`integrity_mismatch`), and a **storage quota preflight** (model
    total + largest `.part` spike vs `navigator.storage.estimate()`).
  - `deleteLocalModel({modelId})` — owner-only removal (no product cap/eviction).
  - `verifyModelIntegrity({modelId})` — re-hash installed files against catalog.
  - `LocalModelManager` — a facade class wrapping the above + inference lifecycle.
- `extension/lib/models/local-opfs-model.js` — the on-device `LanguageModelV2`
  adapter (`createLocalOpfsModel({modelId})`). Zero network; Gemma-4 chat-template
  formatting (`<start_of_turn>user/model<end_of_turn>`); honest lifecycle (checks
  installed-before-generate); and — critically — `doGenerate`/`doStream` **threw a
  typed `engine_not_bundled` error** because no on-device Wasm inference engine
  (e.g. wllama) was ever bundled. In other words: the download path was real, but
  the *run* path was a stub waiting on a Wasm GGUF runtime.

### UI wiring (removed)

- `extension/shared/components.js` — a `<local-model-catalog>` custom element
  (publisher metadata + on-demand install states: idle/probing/progress/installed/
  failed, with preflight/download/cancel/delete/verify/select events).
- `extension/options/options.js` — `renderLocalModels()` (storage estimate →
  feasibility → list installed → wire the component's event handlers to
  `preflightLocalModel` / `downloadLocalModel` / `deleteLocalModel` /
  `verifyModelIntegrity`). Called from the settings boot.
- `extension/options/options.html` — the `#local-models` `<section>` + nav link.
- `extension/lib/provider.js` — a `local-opfs` entry in `PROVIDER_CHOICES` and a
  `resolveModelFromConfig` branch that returned `createLocalOpfsModel({modelId})`.
- `extension/lib/provider-visibility.js` — `"local-opfs"` in `INTERNAL_PROVIDER_IDS`.
- `extension/lib/pure.js` — `"local-models"` in `SETTINGS_SECTIONS` +
  `#local-models` in `OPTIONS_PRODUCT_HASHES`.

## Why it failed (the constraint that killed it)

Chrome's built-in AI / OPFS storage cap. The owner hit: "insufficient storage
available — browser storage 10 GB is below the required payload and staging
capacity of 10.53 [GB]" — even though the advertised install was 5.72 GiB. The
catalogue's largest model (14.56 GiB) exceeded the quota outright, and the staging
model (payload + `.part` spike) exceeded the available quota even for the small one.
`localModelFeasibility` correctly failed-closed on this, so the download never
completed and the on-device path was dead in practice.

## How to rebuild

1. Restore the three files above from git history (the removal commit's parent).
2. Re-add the `local-opfs` provider branch in `provider.js` + the
   `provider-visibility` / `pure.js` / options wiring.
3. The **blocking missing piece was never the download — it was the inference
   engine**: `local-opfs-model.js` throws `engine_not_bundled` until a Wasm GGUF
   runtime (e.g. wllama, or the platform's WebNN/WebGPU path) is bundled. That's
   the real work to make on-device inference function.
4. Future direction (owner's steer): load a GGUF from the user's own drive via
   OPFS **with the File System Access API directory/file handles** (pick a local
   folder/file rather than downloading a pinned publisher copy), sidestepping the
   storage-quota wall. Or keep **Ollama** as the managed local path (already
   supported — a `http://localhost:11434/v1` OpenAI-compatible endpoint, no key).

## What remains supported (kept)

- **Ollama** and **LM Studio** local OpenAI-compatible endpoints — still normal
  providers through `createOpenAICompatibleModel` (no key, baseURL + model id).
- `extension/lib/model-prices.js` — bundled per-1M-token pricing for ALL
  providers (used by `agent.js` for usage cost + the options model picker). NOT
  local-model-specific; kept.
