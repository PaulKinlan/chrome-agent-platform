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
   override it with a later instruction. `/skill:<id>` references contribute
   their full prompt bodies here (not trailing run context). The agent boundary
   also appends the policy to foreign/uncomposed system prompts, so every caller
   is protected structurally. A mechanical drift test proves the rendered layer
   contains every policy rule verbatim and that the editable base carries none
   of the policy's permission/origin/security semantics.

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

The hub and worker defaults share one execution-environment grounding block.
It states that the agent runs inside a Chrome MV3 extension: loops run in the
service worker or offscreen-hosted per-agent SharedWorkers, privileged built-in
tools execute through the service worker, bundled compute uses fresh dedicated
Workers, and reusable JavaScript runs in an opaque sandboxed iframe hosted by
the offscreen document (with the open hub as fallback). Only page-side WebMCP
or inferred tools expose page DOM/window APIs. It also pins one-shot Response
body handling, `open_tab` / `create_window` rather than `window.open`, and the
one-search rule: call `search_tools` exactly once for a missing capability,
invoke the best match immediately, and report a first failure without searching
again.

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

- **Mandatory revision CAS.** The store carries a monotonic `revision`; every
  mutation (`set`, `reset`, and `keep`) must echo the revision it read as
  `expectedRevision`. A missing revision is rejected, and a stale window gets
  a conflict + reload instead of a silent last-write-wins. All prompt-store
  read-modify-writes serialize behind a mutex.
- **Strict store + record schema with quarantine.** Persisted records are
  validated on every read (mode, text, base stamps, byte bounds, well-formed
  Unicode). A future/foreign store version or malformed envelope is never
  misread as a legacy map: the complete object is quarantined intact. Invalid
  records move to `cap:promptOverrides:quarantine` (visible, recoverable) and
  are never composed; unknown record fields are stripped.
- **Key-specific authority.** The generic `kv.set`/`kv.remove` message routes
  REFUSE the prompt-owned keys. Generic `kv.get` also refuses an explicit
  attestation-key read and strips key material from read-all — only `prompt.*`
  operations can use it, and no route returns the bytes.
- **Agent lifecycle.** `agent:<slug>` writes require the named agent to exist.
  The named-agent registry lock is held across existence-check + prompt write,
  in the same lock order used by deletion; deletion propagates prompt-cleanup
  failure and preserves the agent for retry. A delete can therefore never
  race a write into an orphan override that a recreated same-slug agent would
  silently inherit.
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

The Chrome Prompt API adapter binds at its true final boundary too: each call
creates a session whose immutable `systemPrompt` is the exact AI-SDK system
message, while the non-system transcript preserves message roles for both
`doGenerate` and `doStream`. The demo model's streaming (`doStream`) boundary
is covered explicitly, not inferred from the non-streaming method.

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

- **Preview attestation** (`prompt.attest`) — KEYED receipts only
  (HMAC-SHA-256). The route deliberately returns no unkeyed composition hash:
  the Settings digest remains available through the owner-facing describe UI,
  while the attestation cannot become a public dictionary oracle for custom
  text.
- **Run-bound attestation** (`prompt.attestRun`, journaled per run) — lib/agent.js
  wraps the LanguageModel and captures the EXACT system message observed at
  the provider/model boundary for a real run (hub, named, background,
  scheduled, hook, and delegated site-worker runs alike). The captured digests
  are RE-KEYED in the service worker before anything is recorded: the record
  carries the keyed receipt of the exact wire-message digest + the keyed
  receipt of the composition digest, UTF-8 byte counts, `prefixMatch`, and the
  provider/model identity. Every attempt gets a unique immutable execution id;
  reusable logical task/schedule ids remain separate, slots finalize at run
  end, callbacks unbind in `finally`, and direct delegation binds its own
  execution. Periodic ticks can therefore never mix attestations.

The key is a versioned, deliberately rotatable envelope with bounded previous
key history. Every receipt names its `keyVersion`; when optional `storage` is
absent the service-worker-session key is honestly labelled `ephemeral: true`
instead of being described as per-install durable. No prompt content, key
bytes, or unkeyed stable fingerprint of owner text is ever routed/journaled. A
run proves it sent the previewed composition when its layered boundary
receipts match the preview's per layer: static layers compare by exact
receipt, and the dynamic `runtime-context` layer (date/time, roster, memory
index — legitimately per-assembly) compares by its TEMPLATE receipt (the
preview renders that layer as its clearly-marked placeholder, so the
preview's rendered receipt IS its template receipt). The comparator is
`layerReceiptsMatch` in `extension/lib/system-prompts.js`; whole-composition
receipts (`composedReceipt` vs `digestReceipt`) intentionally differ whenever
the dynamic layer renders real values.

## Secrets + hidden reasoning

The override is owner-authored free text. It is never logged (the journal and
the attestations carry keyed receipts/byte counts only) and never sent
anywhere except as part of the system prompt to the configured provider; the
UI warns against pasting credentials. Only product-authored prompt content is
ever shown in the UI — there is no hidden chain-of-thought in the
composition.

The dynamic `runtime-context` layer follows the same trust class: the memory
index it carries is the agent's OWN store content, already fully reachable by
the model via `memory_grep`/`memory_list` in the same prompts, and the roster
is hub-only and already reachable via `list_agents`. The layer changes WHEN
this content appears (every composition), never WHO sees it or WHERE it goes —
all prompt content flows to the configured provider by platform design (page
content, journals, grep results already do), so PII in prompts is accepted.
The contract is CREDENTIAL-redaction: every agent-written field in the layer
passes through `redactSecretText` before any truncation or encoding, so a
credential-shape string in a store reaches the prompt only as `[REDACTED]`.

## Tests

- `tests/system-prompts.test.ts` — the runtime-policy drift guard (policy ⊆
  protected layer; the editable base carries none of it), the registry, the
  composition order (protected LAST, after skills), the modes, persistence
  (versioned store, legacy migration, strict-schema quarantine, corruption),
  mandatory mutation CAS + concurrent-writer serialization, coordinated agent
  lifecycle, per-agent/global precedence, built-in upgrades (incl. inherited
  keep/reset), UTF-8 byte bounds + malformed-Unicode sanitize/reject contracts,
  FIPS/RFC SHA-256/HMAC known-answer vectors, versioned key rotation, and the
  run-bound attestation through the real agent core (streaming demo, hub,
  delegated site-worker, and scoped/hook shapes). `tests/prompt-api.test.ts`
  covers exact final-boundary session/transcript binding for generation and
  streaming.
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
