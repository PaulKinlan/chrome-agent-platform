// @ts-nocheck
// 18ug: approval-classification SEAM closure, not a census of all SW authority.
// Derive operations from executable requireOwnerApproval call sites, including
// the script wrapper and browser dispatch domain. Routes using other owner gates
// are deliberately outside this seam (the wider dispatcher audit is separate).
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { parse } from "npm:acorn";
import { runInNewContext } from "node:vm";
import { DESTRUCTIVE_ACTIONS, OWNER_DIRECT_ACTIONS, isOwnerDirectApproval } from "../extension/lib/owner-approval.js";

// Explicit policy, NOT the implicit complement of OWNER_DIRECT_ACTIONS.
const APPROVAL_REQUIRED_ACTIONS = new Set([
  "agent.update", "asset.update", "capability.revoke", "hooks.subscribe", "hooks.unsubscribe",
  "named-agent.create", "named-agent.set-provider", "script.delete", "script.update", "fs.write",
  "task.schedule-script", "browser.cookie-value", "webmcp.use-tool", "mcp.use-server",
  "browser.close-foreign-tab", "browser.close-window", "browser.wipe", "browser.remove-bookmark",
  "browser.set-cookie", "browser.remove-cookie", "workflow.run",
]);

function walk(node, visit, ancestors = []) {
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") visit(node, ancestors);
  for (const [key, value] of Object.entries(node)) {
    if (key === "start" || key === "end") continue;
    for (const child of Array.isArray(value) ? value : [value]) {
      if (child && typeof child === "object") walk(child, visit, [...ancestors, node]);
    }
  }
}

// Exact current dependency-injection grammar: source module, SW binding and
// dependency argument/parameter. Unknown factories are not approval relays.
const APPROVAL_FACTORIES = new Map([
  ["createSchedulerRoutes", ["routes/scheduler.js", "schedulerRoutes", 0]],
  ["createFsGrantRoutes", ["routes/fs-grants.js", "fsGrantRoutes", 0]],
  ["createAgentScheduleRoutes", ["routes/agent-schedule.js", "agentScheduleRoutes", 0]],
  ["createNamedAgentDeleteGate", ["routes/agent-schedule.js", null, 1]],
]);

function isApprovedInjection(node, ancestors, file) {
  const [property, object, owner, binding, declaration, container] = ancestors.slice(-6).reverse();
  if (node.name !== "requireOwnerApproval" || property?.type !== "Property" ||
      !property.shorthand || property.computed || property.key.name !== node.name) return false;
  if (object?.type === "ObjectPattern" && owner?.type === "FunctionDeclaration") {
    const spec = APPROVAL_FACTORIES.get(owner.id?.name);
    return spec && file === spec[0] && owner.params[spec[2]] === object &&
      binding?.type === "ExportNamedDeclaration" && declaration?.type === "Program";
  }
  if (object?.type !== "ObjectExpression" || owner?.type !== "CallExpression" ||
      owner.callee.type !== "Identifier" || owner.optional || file !== "service-worker.js") return false;
  const spec = APPROVAL_FACTORIES.get(owner.callee.name);
  if (!spec || owner.arguments[spec[2]] !== object) return false;
  if (spec[1]) {
    return binding?.type === "VariableDeclarator" && binding.init === owner && binding.id.name === spec[1] &&
      declaration?.type === "VariableDeclaration" && declaration.kind === "const" && container?.type === "Program";
  }
  // The deletion factory is injected only as the named-agent delete hook,
  // not as an object that an unknown relay could store or inspect.
  return binding?.type === "Property" && !binding.computed && binding.key.name === "gateBeforeDelete" &&
    declaration?.type === "ObjectExpression" && container?.type === "CallExpression" &&
    container.callee.name === "deleteNamedAgent" && container.arguments[1] === declaration &&
    ancestors.some((n) => n.type === "Property" && n.method && n.key.value === "named-agent.delete");
}

function assertApprovalHelperReferences(ast, url) {
  const file = url.pathname.split("/extension/background/")[1];
  const helpers = ["requireOwnerApproval", "scriptApprovalGate"];
  walk(ast, (node, ancestors) => {
    const parent = ancestors.at(-1);
    // A static computed member/key has no Identifier node. It is not an
    // approved DI binding, and must not disappear from the reference census.
    const literalReference = node.type === "Literal" && helpers.includes(node.value) &&
      ((parent?.type === "MemberExpression" && parent.property === node) ||
       (parent?.type === "Property" && parent.key === node));
    if (literalReference || (node.type === "Identifier" && helpers.includes(node.name))) {
      assert(!literalReference && (
        (parent?.type === "CallExpression" && parent.callee === node && !parent.optional) ||
        (parent?.type === "FunctionDeclaration" && parent.id === node && file === "service-worker.js" && ancestors.at(-2)?.type === "Program") ||
        isApprovedInjection(node, ancestors, file)
      ), `unresolved approval helper reference: ${url.pathname}:${node.start}`);
    }
  });
}

async function* backgroundSources(dir = new URL("../extension/background/", import.meta.url)) {
  for await (const entry of Deno.readDir(dir)) {
    const url = new URL(entry.name + (entry.isDirectory ? "/" : ""), dir);
    if (entry.isDirectory) yield* backgroundSources(url);
    else if (entry.name.endsWith(".js")) yield [url, await Deno.readTextFile(url)];
  }
}

Deno.test("owner-approval classification: every executable approval call has explicit policy; unresolved dispatch fails closed", async () => {
  const operations = new Set();
  let scriptForwarders = 0;
  let browserDispatchers = 0;
  let calls = 0;
  for await (const [url, source] of backgroundSources()) {
    const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    assertApprovalHelperReferences(ast, url);
    const dynamicBrowserCalls = [];
    walk(ast, (node, ancestors) => {
      if (node.type !== "CallExpression" || !["requireOwnerApproval", "scriptApprovalGate"].includes(node.callee.name)) return;
      calls++;
      const action = node.arguments[1];
      const where = `${url.pathname.split("/extension/")[1]}:${node.start}`;
      if (action?.type === "Literal" && typeof action.value === "string") {
        operations.add(action.value);
        return;
      }
      const fn = ancestors.findLast((n) => n.type === "FunctionDeclaration");
      if (node.callee.name === "requireOwnerApproval" && fn?.id.name === "scriptApprovalGate") {
        assertEquals(fn.params[1].name, "action", where);
        assertEquals(action?.name, "action", `script approval wrapper must forward its classified action: ${where}`);
        scriptForwarders++;
        return;
      }
      const route = ancestors.findLast((n) => n.type === "Property" && n.key?.value === "browser.destructive-action");
      if (node.callee.name === "requireOwnerApproval" && route && action?.name === "act") {
        dynamicBrowserCalls.push(route);
        return;
      }
      assert(false, `unresolved approval action at ${where}; explicitly classify its dispatch domain`);
    });
    for (const route of dynamicBrowserCalls) {
      browserDispatchers++;
      const declaration = ast.body.flatMap((n) => n.declarations ?? []).find((n) => n.id.name === "DESTRUCTIVE_BROWSER_ACTIONS");
      assertEquals(declaration?.init?.type, "NewExpression");
      assertEquals(declaration.init.callee.name, "Set");
      assertEquals(declaration.init.arguments[0].type, "ArrayExpression");
      const domain = new Set(declaration.init.arguments[0].elements.map((n) => {
        assertEquals(n.type, "Literal", "browser approval domain must be statically enumerable");
        assertEquals(typeof n.value, "string");
        return n.value;
      }));
      const observed = [];
      // Execute the actual dynamic route, not a duplicate of its has() guard.
      const handler = runInNewContext(`({${source.slice(route.start, route.end)}})["browser.destructive-action"]`, {
        ERR_ACTION_NOT_APPROVABLE: Object.freeze({ ok: false, error: "this browser action is not approvable" }),
        DESTRUCTIVE_BROWSER_ACTIONS: domain,
        destructiveActionPolicy: async () => "ask",
        canonicalOperationTarget: () => "target", payloadFields: () => ({}),
        requireOwnerApproval: async (_context, action) => { observed.push(action); return { ok: true }; },
      });
      for (const action of domain) {
        assertEquals((await handler({ action, ref: "ref" }, {})).ok, true);
        operations.add(action);
      }
      assertEquals(observed, [...domain], "browser dispatch forwards exactly its enumerated actions");
      for (const action of ["unclassified.owner-mutation", "", null, {}]) {
        assertEquals((await handler({ action, ref: "ref" }, {})).ok, false, "unknown browser operation cannot enter approval dispatch");
      }
      assertEquals(observed, [...domain], "unknown browser operations never reach approval");
    }
  }
  assert(calls > 0, "approval seam cannot silently disappear");
  assertEquals(scriptForwarders, 1, "one audited script wrapper; a new dynamic wrapper needs explicit census support");
  assertEquals(browserDispatchers, 1, "one audited browser dispatcher");
  for (const action of operations) {
    const direct = OWNER_DIRECT_ACTIONS.has(action);
    const required = APPROVAL_REQUIRED_ACTIONS.has(action);
    assert(direct !== required, `unclassified or multiply classified approval operation: ${action}`);
    assertEquals(isOwnerDirectApproval({ principal: "extension", documentId: "doc" }, action), direct, action);
    assertEquals(isOwnerDirectApproval({ principal: "owner-options", documentId: "doc" }, action), direct, action);
    assertEquals(isOwnerDirectApproval({ principal: "model", documentId: "doc", executionId: "run" }, action), false, action);
    if (required) assert(DESTRUCTIVE_ACTIONS.has(action), `${action} must be able to request an approval`);
  }
  for (const action of APPROVAL_REQUIRED_ACTIONS) assert(operations.has(action), `stale approval-required classification: ${action}`);

  // dari: permanent falsification of the reference guard itself. These fixtures
  // are parsed, never executed; a rejection must be our assertion, not syntax.
  const swUrl = new URL("../extension/background/service-worker.js", import.meta.url);
  const checkReferences = (source, url = swUrl) => assertApprovalHelperReferences(
    parse(source, { ecmaVersion: "latest", sourceType: "module" }), url,
  );
  // Positive controls pin all four current factory call/parameter shapes, in
  // addition to scanning the complete real source above. Location matters.
  for (const [factory, [file, binding, position]] of APPROVAL_FACTORIES) {
    checkReferences(`export function ${factory}(${position ? "context, " : ""}{ requireOwnerApproval }) {
      return requireOwnerApproval(context, "named-agent.update", "target", {});
    }`, new URL(`../extension/background/${file}`, import.meta.url));
    if (binding) checkReferences(`const ${binding} = ${factory}({ requireOwnerApproval });`);
  }
  checkReferences(`const handlers = mergeRouteMaps({ async "named-agent.delete"() {
    return deleteNamedAgent(slug, { gateBeforeDelete: createNamedAgentDeleteGate(context, { requireOwnerApproval }) });
  } });`);
  for (const [label, source] of [
    ["shorthand storage", 'const gate = { requireOwnerApproval };'],
    ["shorthand storage/computed call", 'const gate = { requireOwnerApproval }; gate["requireOwnerApproval"](context, "new.action", "target", {});'],
    ["unknown relay/computed call", 'function relay(deps) { return deps; } const gate = relay({ requireOwnerApproval }); gate["requireOwnerApproval"](context, "new.action", "target", {});'],
    ["unknown relay without member token", 'const key = "requireOwnerApproval"; const gate = relay({ requireOwnerApproval }); gate[key](context, "new.action", "target", {});'],
    ["unknown injection call", 'relay({ requireOwnerApproval });'],
    ["unknown destructuring factory", 'function relay({ requireOwnerApproval }) { return { requireOwnerApproval }; }'],
    ["member call", 'deps.requireOwnerApproval(context, "new.action", "target", {});'],
    ["computed member call", 'deps["requireOwnerApproval"](context, "new.action", "target", {});'],
    ["renamed alias", 'const alias = requireOwnerApproval; alias(context, "new.action", "target", {});'],
    ["destructured alias", 'const { requireOwnerApproval: alias } = deps;'],
    ["string-key destructured alias", 'const { "requireOwnerApproval": alias } = deps;'],
    ["wrapper helper storage", 'const gate = { scriptApprovalGate };'],
    ["known factory wrong binding", 'const unrelated = createSchedulerRoutes({ requireOwnerApproval });'],
    ["known factory nested object", 'const schedulerRoutes = createSchedulerRoutes({ nested: { requireOwnerApproval } });'],
    ["known factory wrong argument", 'const schedulerRoutes = createSchedulerRoutes({}, { requireOwnerApproval });'],
    ["known factory nested binding", 'function relay() { const schedulerRoutes = createSchedulerRoutes({ requireOwnerApproval }); }'],
    ["known declaration wrong module", 'export function createSchedulerRoutes({ requireOwnerApproval }) {}'],
    ["unknown declaration", 'function anotherGate(context, { requireOwnerApproval }) {}'],
    ["delete gate outside hook", 'const gate = createNamedAgentDeleteGate(context, { requireOwnerApproval });'],
    ["delete gate under unknown relay", 'const handlers = { async "named-agent.delete"() { return relay(slug, { gateBeforeDelete: createNamedAgentDeleteGate(context, { requireOwnerApproval }) }); } };'],
    ["delete gate wrong argument", 'const handlers = { async "named-agent.delete"() { return deleteNamedAgent({ gateBeforeDelete: createNamedAgentDeleteGate(context, { requireOwnerApproval }) }, slug); } };'],
  ]) {
    assertThrows(() => checkReferences(source), Error, "unresolved approval helper reference:", label);
  }
});
