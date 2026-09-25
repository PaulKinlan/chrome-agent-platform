# chrome-agent-platform-mx1g — Evaluation of MCP Zod Peer Unification

**Candidate:** branch `cap/gemini-mx1g-zod-peer` @ worktree `/home/paulkinlan/worktrees/cap-gemini-mx1g`.  
**Date:** 2026-09-25.  
**Authority:** Evaluation and schema parity audit only. No production source changes authorized by this issue.

---

## 1. Executive Summary & Recommendation

**RECOMMENDATION: RETAIN SEPARATE PEER CONTEXTS (DO NOT UNIFY).**

The `azlc` audit noted that `@modelcontextprotocol/sdk@1.30.0` peer contexts bind both `zod@3.25.76` and `zod@4.4.3`, and `zod-to-json-schema@3.25.2` binds both peers.

Our evaluation confirms the audit's findings and proves that attempting to unify or deduplicate these peers would be harmful:
1. **Negligible Byte Impact:** Despite `zod-to-json-schema` having 78 source files totaling 108,530 bytes of source input, tree-shaking in the production service worker bundle limits its emitted preminify output contribution to **exactly 2,460 bytes**.
2. **Schema Conversion Failure:** `zod-to-json-schema@3.25.2` is incompatible with Zod 4 AST (`_zod.def.type`). When passed a Zod 4 schema, it fails to match any property parser and emits an **empty schema** (`{ "$schema": "..." }`) with zero properties.
3. **Incompatible Error Issue Structures:** Zod 4 omits `issue.received` and `issue.type` on validation failures. Downstream CAP consumers such as `validationIssueDetail` in `extension/lib/lazy-tool-protocol.js` depend on `issue.received` and would degrade to emitting `"must be string; received undefined"`.
4. **Mixed Shape Rejection:** `@modelcontextprotocol/sdk` explicitly rejects mixed Zod version shapes in `objectFromShape`, throwing `"Mixed Zod versions detected in object shape."`.
5. **Constraint Drops in v4-mini:** Early `v4-mini` toJSONSchema in `zod@3.25.76` drops `minLength`, `maxLength`, `minimum`, `maximum`, and `description`, whereas Zod 3 via `zod-to-json-schema` preserves all boundaries.

---

## 2. Quantitative Measurements

### A. Emitted Converter Contribution in Production SW Bundle
Measured via `esbuild.metafile` output inputs on `extension/background/service-worker.js`:
- Unminified source files in `zod-to-json-schema`: 78 files, 108,530 bytes.
- Actual bytes emitted in output bundle: **2,460 bytes**.
- Ratio of emitted bytes to source inputs: **2.27%**.

### B. Compatibility Matrix Across Zod Peer Contexts

| Property / Feature | Zod 3.25.76 | Zod 4.4.3 | Compatibility / Parity Status |
| :--- | :--- | :--- | :--- |
| Internal AST Identifier | `_def.typeName` (`"ZodString"`, etc.) | `_zod.def.type` (`"string"`, etc.) | **Incompatible** (`isZ4Schema` uses `!!s._zod`) |
| `objectFromShape` with mixed peers | N/A | N/A | **Refused** (`throw "Mixed Zod versions detected..."`) |
| `zod-to-json-schema@3.25.2` output | Complete JSON Schema (properties, constraints) | `{ "$schema": "..." }` (empty, 0 properties) | **Fails silently on Zod 4** |
| `issue.expected` on type error | `"string"` | `"string"` | Matches |
| `issue.received` on type error | `"number"` | `undefined` | **Missing in Zod 4** |
| `issue.type` on min/max error | `"string"` / `"array"` | `undefined` (uses `origin`) | **Missing in Zod 4** |
| Enum error code | `code: "invalid_enum_value"` | `code: "invalid_value"` | **Divergent code and structure** |
| Enum options field | `options: ["a", "b"]`, `received: "c"` | `values: ["a", "b"]`, no `received` | **Divergent** |

---

## 3. Impact on Chrome Agent Platform (CAP)

1. **Lazy Tool Protocol (`extension/lib/lazy-tool-protocol.js`):**
   `validationIssueDetail` formats argument validation errors for the model:
   ```js
   if (issue?.code === "invalid_type") {
     return `${field} must be ${issue.expected}; received ${issue.received}`;
   }
   ```
   If Zod 4 were unified here without parser updates, `issue.received` being `undefined` would cause CAP to report:
   `"arg must be string; received undefined"` instead of `"arg must be string; received number"`.
   Similarly, bounds checking relies on `issue.type === "array" ? "items" : "characters"` which defaults to `"values"` when `issue.type` is missing.

2. **JSON Schema Compilation (`extension/lib/pure.js`):**
   `compileSchemaToZod` compiles incoming tool schemas from remote MCP servers into Zod 3 schemas (`import { z } from "zod"`). This cleanly matches the root peer context and preserves all supported schema constraints without tripping Zod 4 parser gaps.

3. **Remote MCP Transports:**
   `extension/lib/mcp-client.js` imports `@modelcontextprotocol/sdk/client/index.js`, which handles incoming tool declarations as JSON Schema over SSE / Streamable-HTTP. Keeping the SDK's peer contexts intact avoids breaking transport-level schema negotiations.

---

## 4. Verification & Regression Protection

A dedicated test suite has been added at `tests/mcp-zod-peer-parity.test.ts`:
- `mcp-zod-peer-parity: runtime detection correctly identifies Zod 3 vs Zod 4 schemas`
- `mcp-zod-peer-parity: objectFromShape enforces version homogeneity and refuses mixed shapes`
- `mcp-zod-peer-parity: validation issue shape disparity breaks downstream error consumers`
- `mcp-zod-peer-parity: zod-to-json-schema fails silently on Zod 4 schemas`
- `mcp-zod-peer-parity: toJsonSchemaCompat routes correctly but reveals Zod 4 mini constraint drops`
- `mcp-zod-peer-parity: MCP Server tool registration wire schema preserves Zod 3 constraints`
- `mcp-zod-peer-parity: preminify converter contribution is exactly 2460 bytes in SW bundle`

All 7 tests pass in 263 ms via `npm run test:file -- tests/mcp-zod-peer-parity.test.ts`.
The test file adheres to partition guard rules and runs safely in the parallel test phase.
