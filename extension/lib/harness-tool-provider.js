// extension/lib/harness-tool-provider.js — CAP's tools, as a harness sees them.
//
// This is the piece that decides WHETHER a harness may run a CAP tool, and it
// exists in this shape for one reason: `browserToolset(false, …)` with its
// gates left unwired executes Destructive actions — closing a foreign tab,
// wiping data, setting a cookie — with NO owner approval. That is documented at
// the `browserToolset` call site as safe only because every live model run
// supplies the gates. A harness run is a new call site, so the gates have to be
// supplied here, and "has to be" is not good enough: an approval function is
// REQUIRED by the constructor, so an ungated harness toolset cannot be built at
// all. A default that grants is the bug this module is shaped to prevent.
//
// WHAT EVERY CALL GOES THROUGH, in this order, and the order is deliberate:
//   1. the tool must exist                     — an unknown name is refused BY NAME
//   2. the arguments must satisfy the tool's OWN validator (its zod `safeParse`)
//   3. the owner must approve                  — one card per call, fail closed
//   4. only then does the tool execute
// Validation runs BEFORE approval so the owner is never asked to approve a
// malformed call, and approval runs before execution so there is no path from a
// harness to a side effect that skips the card.
//
// SCHEMAS, AND WHY THEY ARE PERMISSIVE ON PURPOSE. MCP wants a JSON Schema per
// tool. This repository has no zod→JSON-Schema converter (zod is 3.25, which has
// no `toJSONSchema`), and adding one would be a new, bug-prone dependency in the
// one place where a schema mistake means a wrong tool call. So the advertised
// schema is permissive and the REAL validation is the tool's own `safeParse`,
// applied at step 2 above with the tool's own issue detail. The authoritative
// check stays in the product-owned schema; the MCP client's copy is a hint for
// the model, never the gate.

/**
 * @param {{
 *   toolset: Record<string, { description?: string, inputSchema?: any, execute?: Function }>,
 *   approve: (request: {tool: string, args: object}) => Promise<boolean>,
 *   describeSchema?: (name: string) => object | null,
 * }} config
 */
export function createHarnessToolProvider({ toolset, approve, describeSchema = null } = {}) {
  if (!toolset || typeof toolset !== "object" || Array.isArray(toolset)) {
    throw new TypeError("harness tool provider needs a toolset object");
  }
  // REQUIRED, not defaulted. A missing approval leg must be a construction
  // error, because the alternative is a toolset that runs Destructive actions
  // silently — see the module comment.
  if (typeof approve !== "function") {
    throw new TypeError("harness tool provider needs an approve() — an ungated harness toolset must not be constructible");
  }

  const names = Object.keys(toolset).filter((name) => toolset[name] && typeof toolset[name] === "object");

  /** The tool's own validator, when it has one. Absent is not a grant: a tool
   * with no validator is executed with the arguments as given, which is the same
   * contract the in-extension path has for that tool. */
  const validatorFor = (entry) => {
    const schema = entry?.inputSchema;
    const safeParse = schema && typeof schema.safeParse === "function" ? schema.safeParse.bind(schema) : null;
    return safeParse;
  };

  const issueDetail = (issues) => {
    const list = Array.isArray(issues) ? issues : [];
    return list.slice(0, 3).map((issue) => {
      const path = Array.isArray(issue?.path) ? issue.path.join(".") : "";
      const message = String(issue?.message ?? "invalid");
      return path ? `${path}: ${message}` : message;
    }).join("; ");
  };

  return {
    /** MCP `tools/list`. */
    async listTools() {
      return names.map((name) => {
        const entry = toolset[name];
        let schema = null;
        if (typeof describeSchema === "function") {
          try { schema = describeSchema(name); } catch { schema = null; }
        }
        return {
          name,
          description: String(entry?.description ?? ""),
          inputSchema: schema && typeof schema === "object" ? schema : { type: "object", properties: {} },
        };
      });
    },

    /**
     * MCP `tools/call`. Returns `{ok:true, result}` on success and
     * `{ok:false, error}` for every refusal, so the harness MCP server can
     * surface a refusal as a readable result rather than a transport error.
     */
    async callTool(name, args) {
      const toolName = typeof name === "string" ? name : "";
      const entry = Object.prototype.hasOwnProperty.call(toolset, toolName) ? toolset[toolName] : null;
      if (!entry || typeof entry !== "object") {
        return { ok: false, error: `unknown tool: ${toolName || "(none)"}` };
      }

      const provided = args && typeof args === "object" && !Array.isArray(args) ? args : {};
      let callArgs = provided;

      const safeParse = validatorFor(entry);
      if (safeParse) {
        let parsed;
        try {
          parsed = await safeParse(provided);
        } catch {
          return { ok: false, error: `the arguments for ${toolName} could not be checked` };
        }
        if (parsed?.success !== true) {
          const detail = issueDetail(parsed?.error?.issues);
          return { ok: false, error: detail ? `invalid arguments for ${toolName}: ${detail}` : `invalid arguments for ${toolName}` };
        }
        callArgs = parsed.data;
      }

      let approved = false;
      try {
        approved = (await approve({ tool: toolName, args: callArgs })) === true;
      } catch {
        approved = false;
      }
      if (!approved) {
        // A denial is a NAMED refusal. It is not an error thrown at the harness,
        // because a thrown error reads as a crash and the model retries; a
        // refusal has to be legible as a decision.
        return { ok: false, error: `Owner denied the requested capability. ${toolName} was not performed.` };
      }

      if (typeof entry.execute !== "function") {
        return { ok: false, error: `${toolName} has no executor` };
      }
      try {
        const result = await entry.execute(callArgs);
        // A tool that answers {ok:false} has already refused by name; pass it
        // through untouched rather than re-wrapping a decision as a failure.
        return { ok: true, result };
      } catch (err) {
        return { ok: false, error: `${toolName} failed: ${String(err?.message ?? err)}` };
      }
    },
  };
}
