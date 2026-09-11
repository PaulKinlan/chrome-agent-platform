# Streaming Credential Filter & Reserved Member (__proto__) Parity Contract

- **Bead:** `chrome-agent-platform-66t3`
- **Topic:** 11rm streaming credential filter rule vs. frozen `__proto__` serialization parity
- **Status:** Owner disposition documented & executable parity test suite delivered
- **Contract Test:** `tests/streaming-credential-filter-parity.test.ts`
- **Related Authority:**
  - `v1-converter-bom-claims-sanitizer-adjudication-r6.md` §6.1, §6.2, §6.3
  - `extension/lib/archive-target-registry.js` (`copyConfigData`, `sanitizeProviderConfig`, `sanitizeNamedAgents`, `sanitizeMcpServer`)
  - `extension/lib/logical-site-agent-config.js` (`sanitizeLogicalSiteAgentConfig`)

---

## 1. Problem Statement

In the early design for the unbounded streaming archive converter (`11rm` / `dec7eb6f...`), a proposed streaming credential-filter rule stated:
> *"Omit only `apiKey`, `authToken`, `clientSecret` and stream every other member."*

This proposed 3-key rule created a direct semantic divergence with the frozen registry (`1ce24493`) and its landed successor (`C 4981dda9` @ `b5c65f0c`):
- When an archive contains JSON-parsed objects such as `JSON.parse('{"nested":{"__proto__":{"benign":1},"ok":2}}')`, V8 creates an **own enumerable property** named `"__proto__"` (`Object.hasOwn(nested, "__proto__") === true`).
- In the frozen `1ce` helper, `stripCredentialFields` constructed `{}` and assigned `out[k] = val`, which invoked the `Object.prototype.__proto__` setter in Node and Chrome, causing the key to vanish from the serialized JSON output (though Deno's hardened setter preserved it as an own property).
- A naive 3-key streaming filter would copy or emit `"__proto__"` verbatim, preserving it in the serialized output.
- Therefore, a 3-key filter is **demonstrably not equivalent** to the canonical sanitizer, representing a silent semantic change.

---

## 2. Definitive Owner Disposition

The owner disposition was formally adjudicated in `v1-converter-bom-claims-sanitizer-adjudication-r6.md` §6.1 and implemented in `extension/lib/archive-target-registry.js` (`C 4981dda9`) and `extension/lib/logical-site-agent-config.js` (`8wbb`):

### A. The 4-Key Recursive Redaction Rule
In all recursive redacted contexts:
1. `providerConfig` (flat and legacy nested providers)
2. `namedAgents` (agent descriptors, embedded provider overrides, and nested `mcpServers`)
3. `logicalSiteAgentConfig` (`memory/origins/<origin>/agentConfig.json`)

The filter **MUST explicitly omit `__proto__` alongside the three credential keys**:
```javascript
const CREDENTIAL_KEYS = new Set(["apiKey", "authToken", "clientSecret"]);
if (redact && (CREDENTIAL_KEYS.has(key) || key === "__proto__")) continue;
```
This rule guarantees:
- **Security**: Potential prototype pollution vectors embedded in imported archive payloads are stripped.
- **Cross-Runtime Determinism**: Node, Deno, and browser engines behave identically without relying on engine-dependent `Object.prototype.__proto__` setter side effects.
- **Streaming Equivalence**: Any future streaming serializer/converter must explicitly omit `__proto__` in these contexts. A 3-key filter is rejected.

### B. The Global MCP Server Rest/Spread Exception
Under `sanitizeMcpServer(server)` for global MCP servers (`cap:mcpServers`):
- `auth` headers and tokens are stripped, and `url` is normalized.
- Rest/spread parity (`const { auth: _auth, ...rest } = server; return { ...rest, url };`) **intentionally preserves own data properties, including own `__proto__` as data**, until owning schema validation runs.
- **However**, when an MCP server is nested under `namedAgents.mcpServers`, the enclosing named-agent recursive filter (`copyConfigData(sanitized, true)`) strips `__proto__`.

### C. Preservation of Benign Sibling Properties
- Sibling properties such as `constructor`, `prototype`, `tokenLimit`, `name`, `model`, `baseURL`, and nested arbitrary user keys are strictly preserved.
- Substring regex matching (e.g. `/key|token/`) is strictly forbidden.

---

## 3. Test Fixture Methodology

To guarantee valid verification:
- Tests **must never use JavaScript object literals** like `{ __proto__: { evil: 1 } }`, because object literal syntax invokes the prototype setter at evaluation time, producing `{}` with modified prototype rather than an own property.
- Tests **must construct test payloads using `JSON.parse(...)`** or `Object.defineProperty(...)`, which creates genuine own enumerable `"__proto__"` properties that survive into `Object.entries()`, `Object.keys()`, and `Object.getOwnPropertyDescriptors()`.

---

## 4. Parity Test Suite (`tests/streaming-credential-filter-parity.test.ts`)

The accompanying test suite validates:
1. **Flat Provider Config**: Drops `apiKey` and JSON-parsed own `__proto__`; preserves `provider`, `model`, `baseURL`, `tokenLimit`, and benign siblings.
2. **Nested Legacy Providers**: Drops credentials and own `__proto__` at both outer and array-element levels.
3. **Named Agents Map**: Drops agent ID `"__proto__"`, agent-level `"__proto__"`, embedded provider secrets/`__proto__`, and nested MCP server secrets/`__proto__`.
4. **Logical Site Agent Config**: Drops secrets and own `__proto__`; preserves `name`.
5. **Global MCP vs. Nested MCP Parity**: Proves global MCP preserves own `__proto__` under rest/spread parity, while nested MCP under named agents drops it.
6. **Array Element Traversal**: Array elements with own `__proto__` sanitize each element with `__proto__` removed while preserving array ordering.
7. **Benign Prototype Preservation**: Proves `constructor` and `prototype` data properties are preserved and `Object.prototype` remains unpolluted.
8. **Falsification Counter-Proof**: Proves that a naive 3-key filter preserves `__proto__`, demonstrating that a 3-key filter fails equivalence with the canonical sanitizer.
