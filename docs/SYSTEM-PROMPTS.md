# SYSTEM-PROMPTS.md — the layered, versioned system-prompt architecture

How every system prompt the platform sends is composed, versioned, customized,
and previewed. The single authority is **extension/lib/system-prompts.js** —
every run type and the Settings → Advanced surface resolve prompts through it,
so the previewed prompt is byte-identical to the prompt the model receives.

## The layers (composition order — fixed, tested)

1. **owner-prepend** — the owner's custom instructions (mode `prepend`).
2. **product-base** — the versioned built-in prompt for the scope (the hub
   operating manual / the site-worker base). Omitted under mode `replace`
   (recorded as an `omitted` layer so the UI can show it).
3. **owner-append** — the owner's custom instructions (mode `append`); for
   mode `replace` the owner's text sits here in the base's position.
4. **agent-role** — a named agent's role (`agent:<slug>` scopes only).
5. **protected** — the immutable safety constraints from
   docs/CONSTITUTION.md (`PROTECTED_CONSTRAINTS`, registry id
   `cap.constraints.core`). ALWAYS present, NEVER editable or replaceable by
   owner customization, applied to every scope.
6. **skills** — the per-run installed/included skills, appended by the agent
   core (lib/agent.js) via `buildSkillsPrompt()`.

## The registry (versioned built-ins)

Every built-in prompt is a `PROMPT_REGISTRY` entry with a stable id, a
semantic version, the extension release it last changed in, and a
deterministic content hash (fnv1a64). There are no scattered duplicate prompt
strings: the hub manual lives in lib/master-skill.js, the worker base + the
protected constraints live in lib/system-prompts.js, and the registry
references those single sources.

| id | title | protected |
|---|---|---|
| `cap.hub.master` | Hub agent operating manual | no |
| `cap.worker.base` | Site sub-agent base prompt | no |
| `cap.constraints.core` | Protected safety constraints | yes |

## Scopes

- `hub` — the hub agent; also the scope for background, scheduled, hook
  (scoped), and recipe runs.
- `worker` — every enrolled site's sub-agent (per-origin skills append at run
  time).
- `agent:<slug>` — a named agent. The scope chain is `[agent:<slug>, hub]`:
  a named agent inherits the hub customization until it has its own; its role
  rides as the agent-role layer.

Scope strings are normalized fail-closed (`normalizeScope`): an unrecognized
scope can never read or write an override, and composing one yields the
protected constraints ONLY — never an unprotected empty prompt.

## Owner customization (persisted, migration-safe)

Overrides live in `cap:promptOverrides` (chrome.storage via lib/kv.js), keyed
by scope. A record stores the mode (`append`/`prepend`/`replace`), the text,
and the base id/version/hash/snapshot it was written against:

- **No override** → the CURRENT built-in always applies (product updates take
  effect automatically — the safe/expected path).
- **Override + unchanged built-in** → the override composes normally.
- **Override + CHANGED built-in** (a product release updated the prompt) →
  the override KEEPS APPLYING (deterministic: the owner's customization is
  never silently lost and run behavior never silently changes), and Settings →
  Advanced surfaces the update with an old-vs-new line diff + explicit
  choices: **Keep** (re-stamp onto the new base), edit + **Save** (manual
  merge), or **Reset** to the new default. No silent overwrite, ever.

Bounds (Constitution §4): override text ≤ 16 000 chars; the stored base
snapshot ≤ 32 000 chars; the map ≤ 64 scopes; the release diff ≤ 600 lines.
Validation is fail-closed — an unknown scope, a bad mode, or an oversize/empty
text is rejected with an error, never silently coerced. Override
read-modify-writes are serialized behind a mutex (the same discipline as the
named-agent registry).

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
  origin WITH that origin's skills baked into the composition, so the
  attestation hash covers exactly what the model receives (no double-append).

`prompt.set` / `prompt.reset` / `prompt.keep` invalidate the cached
orchestrator so the NEXT run picks up the new composition immediately.

## Preview == sent (attestation)

Settings → Advanced renders the `prompt.describe` payload: the read-only
built-in viewer, the override editor, and the effective composed preview with
every layer labelled (source + version + hash). The same composition runs in
the service worker's run path, so the preview IS the sent prompt.

For proof without leaking content, `attestComposition()` produces a hash-only
attestation (the composed hash + per-layer hashes/bytes, NO text). It is
journaled (in summary form) at run start, and the `prompt.attest` debug route
returns it for tests — a caller can prove the preview and the sent prompt are
identical without the prompt text ever crossing the wire.

## Secrets + hidden reasoning

The override is owner-authored free text. It is never logged (the journal and
the attestation carry hashes/bytes only) and never sent anywhere except as
part of the system prompt to the configured provider; the UI warns against
pasting credentials. Only product-authored prompt content is ever shown in
the UI — there is no hidden chain-of-thought in the composition.

## Tests

- `tests/system-prompts.test.ts` — the registry, the composition order, the
  protected invariant, the modes, persistence, per-agent/global precedence,
  built-in upgrades (with/without an override), keep/reset/merge conflict
  resolution, bounds + fail-closed validation, Unicode, migration, the diff,
  the hash-only attestation, and the REAL orchestrator integration (what
  agent-do actually sends the model).
- `scripts/system-prompts-integration.ts` — the real-extension journey: the
  built extension in headless Chrome, driving the Settings → Advanced UI
  (scope selector, tabs, save/reset via genuine clicks) + the SW `prompt.*`
  routes + the preview/attestation parity, with screenshot evidence.
- `docs/components.html` — the `<system-prompt-editor>` component in the
  gallery with seeded data exercising every visual state (default /
  customized / built-in-updated + diff).
