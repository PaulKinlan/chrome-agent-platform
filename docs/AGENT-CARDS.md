# Agent Cards Specification & Sharing Contract

Agent cards (ROADMAP Phase ③, `AGENT-PRODUCT-GAPS.md` G7) provide a portable, shareable JSON format for exporting and importing Chrome Agent Platform (CAP) named agents.

---

## 1. Overview & Principles

An **Agent Card** is a portable, declarative blueprint of an agent. It captures identity, persona, behavioral instructions, skill dependencies, schedule metadata, and attached core reference documents.

### Core Principles
1. **Pure Data, Never Code (Constitution §2):** Agent cards are plain JSON data structures. They contain declarative prompt text, identifiers, and configuration—never executable JavaScript, scripts, or runtime expressions.
2. **Fail Closed (Constitution §4):** Malformed JSON, non-object roots, invalid field types, or unsupported schema versions fail closed with an explicit error.
3. **Explicit Dependency Auditing:** Skill dependencies are validated against the extension's authoritative recipe registry (`RECIPES`). Unrecognized skills are dropped cleanly with an explicit report (`droppedSkills`).
4. **Finite Resource Bounds:** Every text field, array length, and file payload is strictly bounded to prevent storage exhaustion or DOM overflow.
5. **Strict Credential & State Isolation:** Sensitive runtime data (API keys, provider URLs, session cookies, instance IDs, private filesystem paths) are **never** exported into card JSON.

---

## 2. Card JSON Schema (Version 1)

An agent card is a UTF-8 JSON document with the following schema:

```json
{
  "version": 1,
  "exportedAt": "2026-08-28T22:30:00.000Z",
  "name": "Research Specialist",
  "role": "# Research Specialist Persona\n\n## Identity\n- **Role**: research analyst...",
  "persona": "# Research Specialist Persona\n\n## Identity\n- **Role**: research analyst...",
  "skills": [
    "multi-tab-researcher",
    "link-collector",
    "page-summary"
  ],
  "coreAssets": [
    {
      "name": "style-guide.md",
      "type": "text/markdown",
      "content": "# Research Style Guide\nAlways verify cross-tab claims."
    }
  ],
  "createdFrom": "research-analyst",
  "schedule": {
    "periodInMinutes": 120,
    "task": "Review open research tabs and produce a digest."
  },
  "avatar": "data:image/svg+xml,<svg>...</svg>"
}
```

### Field-by-Field Specification

| Field | Type | Required | Bounds / Constraints | Description |
|---|---|---|---|---|
| `version` | `integer` | Yes | `1` (positive integer) | Schema version. Future versions increment this integer. Unknown future versions fail closed. |
| `exportedAt` | `string` | Yes | ISO 8601 string or timestamp | Timestamp when the card was exported. |
| `name` | `string` | Yes | 1 to 120 chars (`MAX_CARD_NAME_LEN`) | The display name of the agent. Missing or empty names are rejected. |
| `role` | `string` | Optional | Max 32,000 chars (`MAX_CARD_ROLE_LEN`) | The agent's persona, instructions, and output contract markdown. Bounded on import. |
| `persona` | `string` | Optional | Max 32,000 chars | Alias for `role`. Export sets both `role` and `persona`; import accepts either. |
| `skills` | `string[]` | Optional | Max 128 items (`MAX_CARD_SKILLS`) | List of recipe/skill IDs attached to this agent. Verified against `RECIPES`. |
| `coreAssets` | `object[]` | Optional | Max 8 assets (`MAX_CARD_CORE_ASSETS`), max 128 KiB/file | Core context documents (`{ name, type, content }`) attached to the agent. |
| `schedule` | `object` | Optional | Valid schedule object | Optional background schedule (`periodInMinutes`, `task`, `at`). |
| `createdFrom`| `string` | Optional | Max 64 chars (`MAX_CREATED_FROM_LEN`) | Template ID (e.g. `chief-of-staff`) if originated from a built-in template. |
| `avatar` | `string` | Optional | Max 32,768 chars (`MAX_AVATAR_LEN`) | Data URL, SVG, emoji, or icon string. |

---

## 3. What Is Stripped and Why

When exporting an agent via `exportAgentCard(agent)`:

1. **Provider Credentials & API Keys (`apiKey`, `baseURL`, `provider`):**
   - **Why:** Agent cards are designed to be shared publicly across machines and users. Credentials must never leave the local browser's encrypted settings store.
2. **Runtime Instance IDs (`instanceId`):**
   - **Why:** `instanceId` is a unique UUID generated per local agent installation to prevent ABA races during owner approvals. An imported agent receives a fresh local `instanceId`.
3. **Internal Storage Revisions (`revision`, `createdAt`, `updatedAt`):**
   - **Why:** Monotonic revision numbers belong to the local Chrome storage registry.
4. **Internal OPFS Sandbox State (`agents.md` internal storage paths, memory logs, journal history):**
   - **Why:** Memory and conversation journals contain personal browsing history and local state. A shared agent card shares the *agent definition*, not personal user data.

### Residual Risk Notice (Content vs. Structure)
Exporting an agent card strips **structured runtime credentials** (API keys, provider URLs, instance IDs, storage revision counters). However, **free-text prompt fields** (`role`, `summary`, or attached `coreAssets`) are preserved verbatim. Card export is **not** a content-level DLP (Data Loss Prevention) scanner for user-authored text. Owners sharing cards publicly should ensure their role prompts and attached documents do not contain hardcoded private secrets or API keys.

---

## 4. Import & Validation Contract

Importing an agent card via `importAgentCard(cardInput, options)` performs strict multi-stage validation:

```
[Raw JSON String / Object]
          │
          ▼
 [1. UTF-8 Byte Bound Check] ── (Fail if payload > 2 MiB)
          │
          ▼
    [2. JSON.parse] ─────────── (Fail if syntax error or malformed)
          │
          ▼
[3. Plain Object Check] ─────── (Fail if null, array, primitive, or prototype inheritance)
          │
          ▼
[4. Strict Integer Version] ─── (Fail if non-integer, boolean, array, or version > 1)
          │
          ▼
 [5. Own Name Property] ─────── (Fail if missing, non-string, or whitespace-only)
          │
          ▼
 [6. Persona & Role] ────────── (Extract role/persona, bound to 32,000 chars)
          │
          ▼
[7. Skill ID Filtering] ─────── (Validate against RECIPES; bounded droppedSkills report)
          │
          ▼
[8. Core Assets Normalization] ─ (Cap at 8 assets, truncate content > 128 KiB)
          │
          ▼
[9. Schedule Validation] ────── (Validate periodInMinutes > 0, task text, bounded at timestamp)
          │
          ▼
[10. Result Construction] ─────► { ok: true, agent, droppedSkills, version, exportedAt }
```

### Dropped Skills Reporting
If an imported card requests skills that do not exist in the local extension build (for example, experimental skills or third-party extensions), import **does not crash or reject the whole card**. Instead:
- Valid skills are retained in `agent.skills`.
- Unrecognized skills are stripped and explicitly listed in `result.droppedSkills`.
- The user interface can inform the owner: *"Agent imported successfully. 2 unknown skills were omitted: custom-scraper, beta-tool."*

---

## 5. Sharing an Agent (Usage Flow)

### 5.1 Exporting an Agent
An owner can export any named agent from CAP:

```javascript
import { exportAgentCard, exportAgentCardJson } from "./lib/agent-cards.js";
import { getNamedAgent } from "./lib/named-agents.js";

// Fetch the existing agent
const agent = await getNamedAgent("research-specialist");

// Generate card JSON
const cardJson = exportAgentCardJson(agent);

// Download as .agent.json file or copy to clipboard
const blob = new Blob([cardJson], { type: "application/json" });
const url = URL.createObjectURL(blob);
```

### 5.2 Importing an Agent
When an owner imports a card file or pastes card JSON:

```javascript
import { importAgentCard } from "./lib/agent-cards.js";
import { createNamedAgent } from "./lib/named-agents.js";

const result = importAgentCard(rawJsonString);

if (!result.ok) {
  console.error("Failed to import agent card:", result.error);
  return;
}

// Result agent is ready for authoritative named agent creation
const { agent, droppedSkills } = result;

const created = await createNamedAgent({
  name: agent.name,
  role: agent.role,
  skills: agent.skills,
  coreAssets: agent.coreAssets,
  avatar: agent.avatar,
});

if (created.ok) {
  console.log(`Agent "${created.agent.name}" created with id ${created.agent.id}.`);
  if (droppedSkills.length > 0) {
    console.warn(`Note: Omitted unknown skills: ${droppedSkills.join(", ")}`);
  }
}
```

### 5.3 Post-Import Sandbox Provisioning
When `createNamedAgent` runs after import:
- A new persistent entry is written to `cap:namedAgents`.
- A fresh private OPFS sandbox directory is allocated (`memory/agents/<slug>/`).
- A default operating instructions file (`agents.md`) is generated with the agent's role and name.
- The agent appears immediately in the Hub sidebar and composer mention picker.
