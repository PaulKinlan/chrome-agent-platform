# SYSTEM-PROMPTS.md — the layered, versioned system-prompt architecture

How every system prompt the platform sends is composed, versioned, customized,
attested, and previewed. The single composition authority is
**extension/lib/system-prompts.js** — every run type and the Settings →
Advanced surface resolve prompts through it, so the previewed prompt IS the
platform composition a run is built with. The exact provider-bound wire
message (the composition + the agent runtime's fixed loop instructions + the
run context) is proven per run by the **run-bound attestation** (below).

## The layers (composition order — fixed, tested)

1. **owner-prepend** — the owner's custom instructions (mode `prepend`).
2. **product-base** — the versioned built-in prompt for the scope (the hub
   operating manual / the site-worker base). Omitted under mode `replace`
   (recorded as an `omitted` layer so the UI can show it).
3. **owner-append** — the owner's custom instructions (mode `append`); for
   mode `replace` the owner's text sits here in the base's position.
4. **agent-role** — a named agent's role (`agent:<slug>` scopes only).
5. **skills** — the per-run installed/included skills.
6. **protected** — the immutable runtime policy, GENERATED from
   **extension/lib/runtime-policy.js** (the single authoritative source of
   every runtime security/origin/secret/permission constraint; registry id
   `cap.constraints.core`). ALWAYS present, NEVER editable or replaceable,
   and ALWAYS the FINAL layer — it composes after every editable layer AND
   the skills layer, so no owner text, role, or site-origin skill can
   override it with a later instruction. A mechanical drift test proves the
   rendered layer contains every policy rule verbatim and that the editable
   base carries none of them.

## The registry (versioned built-ins)

Every built-in prompt is a `PROMPT_REGISTRY` entry with a stable id, a
semantic version, the extension release it last changed in, and a
collision-resistant content hash (SHA-256 over the UTF-8 bytes). There are no
scattered duplicate prompt strings: the hub manual lives in
lib/master-skill.js, the worker base lives in lib/system-prompts.js, the
protected policy lives in lib/runtime-policy.js, and the registry references
those single sources.

| id | title | protected |
|---|---|---|
| `cap.hub.master` | Hub agent operating manual | no |
| `cap.worker.base` | Site sub-agent base prompt | no |
| `cap.constraints.core` | Protected safety constraints (the runtime policy) | yes |

## Scopes

- `hub` — the hub agent; also the scope for background, scheduled, hook
  (scoped), and recipe runs.
- `worker` — every enrolled site's sub-agent (per-origin skills compose at
  run time — see the context-aware preview note below).
- `agent:<slug>` — a named agent. The scope chain is `[agent:<slug>, hub]`:
  a named agent inherits the hub customization until it has its own; its role
  rides as the agent-role layer.

Scope strings are normalized fail-closed (`normalizeScope`): an unrecognized
scope can never read or write an override, and composing one yields the
protected constraints ONLY — never an unprotected empty prompt.

## Owner customization (persisted, strict, concurrent-safe)

Overrides live in `cap:promptOverrides` (chrome.storage via lib/kv.js) as a
versioned store `{ version: 1, revision: N, scopes: { scope: record } }`
(a legacy plain scope→record map migrates on read/write). A record stores the
mode (`append`/`prepend`/`replace`), the text, and the base
id/version/hash/snapshot it was written against:

- **No override** → the CURRENT built-in always applies (product updates take
  effect automatically — the safe/expected path).
- **Override + unchanged built-in** → the override composes normally.
- **Override + CHANGED built-in** (a product release updated the prompt) →
  the override KEEPS APPLYING (deterministic: the owner's customization is
  never silently lost and run behavior never silently changes), and Settings →
  Advanced surfaces the update with an old-vs-new line diff + explicit
  choices: **Keep** (re-stamp onto the new base), edit + **Save** (manual
  merge), or **Reset** to the new default. No silent overwrite, ever. Upgrade
  actions target the EFFECTIVE override: on an inheriting `agent:<slug>`
  scope, Keep/Reset act on the inherited hub record (never a no-op).

Durability + concurrency + corruption:

- **Revision CAS.** The store carries a monotonic `revision`; the Settings
  editor echoes the revision it read as `expectedRevision`, and a stale
  writer (a second Settings window) gets a conflict + reload instead of a
  silent last-write-wins. All read-modify-writes serialize behind a mutex.
- **Strict schema + quarantine.** Persisted records are validated on every
  read (mode, text, base stamps, byte bounds, well-formed Unicode); malformed
  records are moved to `cap:promptOverrides:quarantine` (visible,
  recoverable) and never composed. Unknown extra fields are stripped.
- **Key-specific authority.** The generic `kv.set`/`kv.remove` message routes
  REFUSE the prompt-owned keys (the override store, the quarantine, the
  attestation key) — only the `prompt.*` routes write them.
- **Agent lifecycle.** `agent:<slug>` writes require the named agent to
  exist; deleting an agent clears its override (no orphan state a recreated
  same-slug agent would silently inherit).
- **Durability.** chrome.storage needs the optional `storage` permission: the
  Settings Save gesture requests it, and `prompt.describe` reports
  `durable: false` while it is absent — the UI shows a Session-only badge
  instead of claiming "saved".

Bounds (Constitution §4) are **UTF-8 byte bounds**: override text ≤ 16 KiB;
the stored base snapshot ≤ 32 KiB (truncated without splitting a code point);
the store ≤ 64 scopes; the release diff ≤ 600 lines. Malformed Unicode (lone
surrogates) is REJECTED — it can never round-trip through UTF-8. Validation
is fail-closed throughout.

## One composition authority for every run type

The service worker resolves the system prompt through `resolveSystemPrompt()`
for every run type:

- **Hub tasks** (`run-task`, chat/threads) — the `hub` scope.
- **Named agents** (`named-agent.run`) — the `agent:<slug>` scope + the
  agent's role layer, with a fresh orchestrator build (a cached hub
  orchestrator would carry the hub's composition, not the agent's).
- **Background / scheduled agents** (alarm path) — the `hub` scope with the
  agent's own OPFS memory.
- **System-hook (scoped) runs** — the `hub` scope (read-only memory/tools as
  before; scoping is orthogonal to the prompt composition).
- **Site sub-agents (delegated runs)** — the `worker` scope, composed per
  origin WITH that origin's skills baked into the composition (before the
  protected layer), so the composition covers exactly the platform text the
  model receives.

`prompt.set` / `prompt.reset` / `prompt.keep` invalidate the cached
orchestrator so the NEXT run picks up the new composition immediately.

## Preview, attestation, and the run-bound proof

Settings → Advanced renders the `prompt.describe` payload: the read-only
built-in viewer, the override editor, and the effective composed preview with
every layer labelled (source + version + hash) plus the SHA-256 digest and
UTF-8 byte count of the composition.

Honesty about what the preview is: the preview is the exact **platform
composition**. The agent runtime (agent-do) appends its own fixed
loop-instruction sections and the run context AFTER that composition, and the
`worker` scope's real runs compose that origin's skills at run time — the
worker preview says so (the context-aware note) instead of claiming blind
parity.

Two attestations, both content-free:

- **Preview attestation** (`prompt.attest`) — the composition's public
  SHA-256 (the same digest the owner's own Settings surface displays) plus
  KEYED receipts (HMAC-SHA-256 with a per-install key that never leaves
  storage) of the whole composition and each layer.
- **Run-bound attestation** (`prompt.attestRun`, journaled per run) — lib/agent.js
  wraps the LanguageModel and captures the EXACT system message observed at
  the provider/model boundary for a real run (hub, named, background,
  scheduled, hook, and delegated site-worker runs alike). The captured public
  digests are RE-KEYED in the service worker (HMAC with the per-install key)
  before anything is recorded: the journaled/routed record carries the keyed
  receipt of the exact wire message digest + the keyed receipt of the
  composition digest, the UTF-8 byte counts, whether the wire message embeds
  the composition byte-for-byte (`prefixMatch`), the provider/model identity,
  and the runId. No prompt content and no public stable fingerprint of owner
  text is ever journaled. A run proves it sent the previewed composition when
  its `composedReceipt` equals `prompt.attest`'s `digestReceipt`.

## Secrets + hidden reasoning

The override is owner-authored free text. It is never logged (the journal and
the attestations carry keyed receipts/byte counts only) and never sent
anywhere except as part of the system prompt to the configured provider; the
UI warns against pasting credentials. Only product-authored prompt content is
ever shown in the UI — there is no hidden chain-of-thought in the
composition.

## Tests

- `tests/system-prompts.test.ts` — the runtime-policy drift guard (policy ⊆
  protected layer; the editable base carries none of it), the registry, the
  composition order (protected LAST, after skills), the modes, persistence
  (versioned store, legacy migration, strict-schema quarantine, corruption),
  the revision CAS + concurrent-writer serialization, agent existence +
  deletion cleanup, per-agent/global precedence, built-in upgrades (incl. the
  INHERITED upgrade keep/reset path), UTF-8 byte bounds + malformed-Unicode
  rejection, the keyed-receipt attestation, and the RUN-BOUND attestation
  through the real agent core (hub + delegated site-worker + scoped/hook
  shapes).
- `scripts/system-prompts-integration.ts` — the real-extension journey: the
  built extension in headless Chrome, driving the Settings → Advanced UI with
  REAL pointer/keyboard input (CDP mouse clicks + trusted text insertion), the
  dirty-scope-switch confirmation, the SW `prompt.*` routes (fail-closed, key
  authority, CAS), the preview attestation parity, and a REAL `run-task` run
  whose run-bound attestation matches the previewed composition — with
  screenshot evidence.
- `docs/components.html` — the `<system-prompt-editor>` component in the
  gallery with seeded data exercising every visual state (default /
  customized / built-in-updated + diff).
