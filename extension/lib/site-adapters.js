// site-adapters.js — owner-authored site adapters
// (CAP-FB-20260828-AMBIENT-SITE-TOOLS-01).
//
// WHY THIS EXISTS
// The product's thesis is that any website can be a tool. Today a site only
// offers tools if its AUTHOR opted in — `document.modelContext` (declared) or
// `window.webmcpExpose` (the conservative positive opt-in that replaced blind
// `window.*` enumeration after the round-28 review). Almost no site in the wild
// does either, so the thesis stays aspirational while we wait on the web.
//
// An adapter closes that gap from the owner's side: a declarative document that
// says "on this origin, these are the tools, and here is exactly what each one
// does to the page". The owner authors it (an agent may PROPOSE one, but a
// proposal is inert until the owner approves it — see `approve()`), so nothing
// is inferred blindly and the round-28 property is preserved: no capability
// exists on a page unless a human said it does.
//
// WHY IT IS DECLARATIVE, NOT CODE
// Two hard constraints make an interpreted, bounded operation set the only
// honest design:
//   1. MV3 CSP — the bundle contains no `eval` / `new Function`, so we cannot
//      execute an adapter authored as JavaScript, and shipping a mechanism that
//      could would break the extension's central security claim.
//   2. Prompt injection — a model that can author executable page script has
//      escalated from "calls approved tools" to "runs arbitrary code in the
//      page". A closed operation vocabulary means the WORST a malicious
//      proposal can express is an operation the owner can read and refuse.
// So an adapter names one of a fixed set of operations. This module never
// interprets a string as code; the executor (a separate, reviewed module) maps
// these records onto the existing bridge. Adding an operation is a deliberate
// edit here plus its own review, which is the point.
//
// This module is PURE: no storage, no messaging, no DOM, no Chrome API. It
// validates and canonicalises. It cannot grant, approve, enroll or execute.

import { TOOL_BOUNDS } from "./tools.js";

export const ADAPTER_BOUNDS = Object.freeze({
  maxToolsPerAdapter: 50,
  maxSelectorLength: 256,
  maxGlobalNameLength: 128,
  maxArgsPerOp: 16,
  maxParamNameLength: 64,
  maxLabelLength: 200,
  maxTotalBytes: 128 * 1024,
  maxOriginLength: 253 + 8, // hostname cap plus scheme
});

/** The CLOSED operation vocabulary. Adding one is a deliberate, reviewed edit.
 *  `mutating` drives the approval copy and the grant class the executor asks
 *  for: a read is not the same ask as a click that submits a form. */
export const ADAPTER_OPS = Object.freeze({
  callGlobal: { mutating: true, required: ["fn"], optional: ["args"] },
  readText: { mutating: false, required: ["selector"], optional: ["all"] },
  readAttribute: { mutating: false, required: ["selector", "attribute"], optional: ["all"] },
  click: { mutating: true, required: ["selector"], optional: [] },
  fill: { mutating: true, required: ["selector", "value"], optional: [] },
});

const TOOL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const PARAM_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const ATTRIBUTE_RE = /^[a-zA-Z_:][a-zA-Z0-9_.:-]*$/;
// A selector may not smuggle a URL or markup. `<`, `{` and `}` are never valid
// in a CSS selector, so banning them costs nothing. `>` is NOT banned — it is
// the child combinator, and an earlier draft that banned it rejected ordinary
// selectors like `#buy > .cta`.
const SELECTOR_BANNED_RE = /[<{}]|javascript:|data:/i;

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function boundedString(v, max) {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : null;
}

/** An adapter origin is an exact https (or http, for localhost dev) origin.
 *  Wildcards, paths, credentials and ports-on-wildcards are all refused: an
 *  adapter binds to ONE origin so its tools can never leak to another. */
export function canonicalAdapterOrigin(raw) {
  if (typeof raw !== "string" || raw.length > ADAPTER_BOUNDS.maxOriginLength) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.protocol === "http:" && u.hostname !== "localhost" && u.hostname !== "127.0.0.1") return null;
  if (u.username || u.password) return null;
  if (u.hostname.includes("*")) return null;
  if (u.pathname !== "/" && u.pathname !== "") return null;
  if (u.search || u.hash) return null;
  return u.origin;
}

function validateSelector(sel) {
  const s = boundedString(sel, ADAPTER_BOUNDS.maxSelectorLength);
  if (!s) return null;
  if (SELECTOR_BANNED_RE.test(s)) return null;
  return s;
}

/** Validate one operation against the CLOSED vocabulary. Unknown kinds, unknown
 *  fields and missing required fields all fail closed — an operation we do not
 *  fully understand is never stored. `paramNames` is the tool's declared input
 *  set: an op may only reference a parameter the tool actually declares, which
 *  is what stops an adapter reading a value the owner never saw in the schema. */
function validateOp(raw, paramNames) {
  if (!isPlainObject(raw)) return { ok: false, error: "op must be an object" };
  const kind = boundedString(raw.kind, 32);
  if (!kind || !Object.hasOwn(ADAPTER_OPS, kind)) {
    return { ok: false, error: `unknown op kind: ${String(raw.kind).slice(0, 32)}` };
  }
  const spec = ADAPTER_OPS[kind];
  const allowed = new Set(["kind", ...spec.required, ...spec.optional]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) return { ok: false, error: `unknown field for ${kind}: ${key.slice(0, 32)}` };
  }
  for (const key of spec.required) {
    if (!Object.hasOwn(raw, key)) return { ok: false, error: `${kind} requires ${key}` };
  }

  const op = { kind };

  if (kind === "callGlobal") {
    const fn = boundedString(raw.fn, ADAPTER_BOUNDS.maxGlobalNameLength);
    // A global is addressed by a single identifier. No dotted paths: `a.b.c`
    // would let an adapter walk into objects the owner never named, and no
    // bracket access, which is how you would reach a computed property.
    if (!fn || !TOOL_NAME_RE.test(fn)) return { ok: false, error: "callGlobal.fn must be a bare identifier" };
    op.fn = fn;
    const args = raw.args ?? [];
    if (!Array.isArray(args) || args.length > ADAPTER_BOUNDS.maxArgsPerOp) {
      return { ok: false, error: "callGlobal.args must be an array within bounds" };
    }
    for (const a of args) {
      const n = boundedString(a, ADAPTER_BOUNDS.maxParamNameLength);
      if (!n || !PARAM_NAME_RE.test(n)) return { ok: false, error: "callGlobal.args entries must be parameter names" };
      if (!paramNames.has(n)) return { ok: false, error: `callGlobal.args references undeclared parameter: ${n}` };
    }
    op.args = [...args];
    return { ok: true, op };
  }

  if (kind === "readText" || kind === "readAttribute" || kind === "click" || kind === "fill") {
    const sel = validateSelector(raw.selector);
    if (!sel) return { ok: false, error: `${kind}.selector is missing, too long, or contains a banned token` };
    op.selector = sel;
  }
  if (kind === "readAttribute") {
    const attr = boundedString(raw.attribute, ADAPTER_BOUNDS.maxParamNameLength);
    if (!attr || !ATTRIBUTE_RE.test(attr)) return { ok: false, error: "readAttribute.attribute is not a valid attribute name" };
    op.attribute = attr;
  }
  if (kind === "readText" || kind === "readAttribute") {
    if (Object.hasOwn(raw, "all")) {
      if (typeof raw.all !== "boolean") return { ok: false, error: `${kind}.all must be a boolean` };
      op.all = raw.all;
    }
  }
  if (kind === "fill") {
    const val = boundedString(raw.value, ADAPTER_BOUNDS.maxParamNameLength);
    if (!val || !PARAM_NAME_RE.test(val)) return { ok: false, error: "fill.value must be a parameter name" };
    if (!paramNames.has(val)) return { ok: false, error: `fill.value references undeclared parameter: ${val}` };
    op.value = val;
  }
  return { ok: true, op };
}

/** The input schema is a bounded, flat object schema. Flat on purpose: a nested
 *  schema would let an op reference a path rather than a name, and the whole
 *  safety argument here rests on ops referencing DECLARED parameters by name. */
function validateInputSchema(raw) {
  if (raw === undefined) return { ok: true, schema: { type: "object", properties: {}, required: [] }, names: new Set() };
  if (!isPlainObject(raw)) return { ok: false, error: "inputSchema must be an object" };
  if (raw.type !== "object") return { ok: false, error: "inputSchema.type must be 'object'" };
  const props = raw.properties ?? {};
  if (!isPlainObject(props)) return { ok: false, error: "inputSchema.properties must be an object" };
  const names = new Set();
  const outProps = {};
  for (const [name, def] of Object.entries(props)) {
    if (!PARAM_NAME_RE.test(name) || name.length > ADAPTER_BOUNDS.maxParamNameLength) {
      return { ok: false, error: `invalid parameter name: ${name.slice(0, 32)}` };
    }
    if (!isPlainObject(def)) return { ok: false, error: `parameter ${name} must have an object definition` };
    const type = boundedString(def.type, 16);
    if (!type || !["string", "number", "boolean"].includes(type)) {
      return { ok: false, error: `parameter ${name} must be string, number or boolean` };
    }
    const desc = def.description === undefined
      ? undefined
      : boundedString(def.description, TOOL_BOUNDS.maxDescriptionLength);
    if (def.description !== undefined && desc === null) {
      return { ok: false, error: `parameter ${name} description is out of bounds` };
    }
    names.add(name);
    outProps[name] = desc === undefined ? { type } : { type, description: desc };
  }
  const required = raw.required ?? [];
  if (!Array.isArray(required)) return { ok: false, error: "inputSchema.required must be an array" };
  for (const r of required) {
    if (typeof r !== "string" || !names.has(r)) return { ok: false, error: `required references undeclared parameter: ${String(r).slice(0, 32)}` };
  }
  return { ok: true, schema: { type: "object", properties: outProps, required: [...required] }, names };
}

function validateTool(raw) {
  if (!isPlainObject(raw)) return { ok: false, error: "tool must be an object" };
  const name = boundedString(raw.name, TOOL_BOUNDS.maxNameLength);
  if (!name || !TOOL_NAME_RE.test(name)) return { ok: false, error: "tool.name must be a bare identifier" };
  // Absent and empty are the same thing, and this must accept its own output:
  // canonicalisation writes `description:""`, and `approveAdapter` re-validates
  // the stored document, so the round-trip has to hold. (An earlier draft used
  // boundedString here, which rejects "" — that made every adapter containing a
  // description-less tool impossible to approve.)
  let description = "";
  if (raw.description !== undefined && raw.description !== "") {
    description = boundedString(raw.description, TOOL_BOUNDS.maxDescriptionLength);
    if (description === null) return { ok: false, error: `tool ${name}: description is out of bounds` };
  }
  const schemaResult = validateInputSchema(raw.inputSchema);
  if (!schemaResult.ok) return { ok: false, error: `tool ${name}: ${schemaResult.error}` };
  const opResult = validateOp(raw.op, schemaResult.names);
  if (!opResult.ok) return { ok: false, error: `tool ${name}: ${opResult.error}` };
  return {
    ok: true,
    tool: {
      name,
      description,
      inputSchema: schemaResult.schema,
      op: opResult.op,
      mutating: ADAPTER_OPS[opResult.op.kind].mutating,
    },
  };
}

/**
 * Validate and canonicalise an owner-authored adapter document.
 *
 * Returns `{ ok:true, adapter }` or `{ ok:false, error }`. Fails closed on
 * anything it does not fully understand — an adapter that is 90% valid is
 * refused whole, because a partially-applied adapter would give the owner a
 * site that behaves differently from the document they approved.
 *
 * The returned adapter is NOT approved. `status` is always "proposed" here;
 * only `approveAdapter` can move it, and only with an explicit owner act.
 */
export function validateAdapter(raw) {
  if (!isPlainObject(raw)) return { ok: false, error: "adapter must be an object" };

  const origin = canonicalAdapterOrigin(raw.origin);
  if (!origin) return { ok: false, error: "adapter.origin must be an exact http(s) origin with no path, query or credentials" };

  // An absent label and an empty label are the same thing. This must accept its
  // OWN output: `validateAdapter` writes `label:""`, and `approveAdapter`
  // re-validates the stored document, so a round-trip has to hold.
  let label = "";
  if (raw.label !== undefined && raw.label !== "") {
    label = boundedString(raw.label, ADAPTER_BOUNDS.maxLabelLength);
    if (label === null) return { ok: false, error: "adapter.label is out of bounds" };
  }

  const tools = raw.tools;
  if (!Array.isArray(tools) || tools.length === 0) return { ok: false, error: "adapter.tools must be a non-empty array" };
  if (tools.length > ADAPTER_BOUNDS.maxToolsPerAdapter) return { ok: false, error: "adapter.tools exceeds the per-adapter bound" };

  const out = [];
  const seen = new Set();
  for (const t of tools) {
    const r = validateTool(t);
    if (!r.ok) return { ok: false, error: r.error };
    // A duplicate name is a refusal, not a last-one-wins: the owner approved a
    // document, and silently dropping one of two same-named tools would mean
    // the thing that runs is not the thing they read.
    if (seen.has(r.tool.name)) return { ok: false, error: `duplicate tool name: ${r.tool.name}` };
    seen.add(r.tool.name);
    out.push(r.tool);
  }

  const adapter = {
    v: 1,
    origin,
    label,
    tools: out,
    status: "proposed",
    authoredBy: raw.authoredBy === "agent" ? "agent" : "owner",
  };

  let bytes;
  try {
    bytes = JSON.stringify(adapter).length;
  } catch {
    return { ok: false, error: "adapter is not serialisable" };
  }
  if (bytes > ADAPTER_BOUNDS.maxTotalBytes) return { ok: false, error: "adapter exceeds the total size bound" };

  return { ok: true, adapter };
}

/**
 * The ONLY transition to an executable adapter, and it requires an explicit
 * owner act — the caller must pass a genuine owner approval, exactly as the
 * rest of the platform does for destructive operations. An agent-authored
 * proposal is inert until this runs.
 *
 * `at` is supplied by the caller rather than read from the clock so this module
 * stays pure and testable.
 */
export function approveAdapter(adapter, { ownerApproved, at }) {
  if (ownerApproved !== true) return { ok: false, error: "an adapter can only be approved by an explicit owner action" };
  const revalidated = validateAdapter(adapter);
  // Re-validate on approval rather than trusting the stored bytes: the document
  // may have been written before a bound tightened, or edited in storage.
  if (!revalidated.ok) return revalidated;
  if (!Number.isFinite(at)) return { ok: false, error: "approval timestamp is required" };
  return { ok: true, adapter: { ...revalidated.adapter, status: "approved", approvedAt: at } };
}

/**
 * Project an approved adapter into the tool descriptors the rest of the
 * platform already understands (`extension/lib/tools.js`). `source:"adapter"`
 * sits alongside declared/inferred so every existing consumer — the directory,
 * the approval prompt, the dispatcher — can tell the owner where a tool came
 * from. A proposed adapter projects to NOTHING: unapproved means invisible,
 * not merely unexecutable.
 */
export function adapterToolDescriptors(adapter) {
  if (adapter?.status !== "approved") return [];
  return adapter.tools.map((t) => ({
    origin: adapter.origin,
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    source: "adapter",
    mutating: t.mutating,
  }));
}
