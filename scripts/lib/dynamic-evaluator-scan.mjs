import { parse } from "acorn";

// Bounded static provenance, NOT arbitrary-JS confinement. Tracks lexical
// bindings, direct globals, member/destructuring aliases, assignments and
// sequence/conditional expressions. Does not interpret payloads or functions.
export function findDynamicEvaluators(ast) {
  const scopes = new WeakMap(), nodes = [], assignments = [];
  const scope = (parent, fn = false) => ({ parent, fn, bindings: new Map() });
  const root = scope(null, true);
  function binding(env, name) {
    for (let s = env; s; s = s.parent) if (s.bindings.has(name)) return s.bindings.get(name);
    return null;
  }
  function declare(pattern, env, source = null) {
    if (!pattern) return;
    if (pattern.type === "Identifier") {
      if (!env.bindings.has(pattern.name)) env.bindings.set(pattern.name, []);
      if (source) env.bindings.get(pattern.name).push(source);
    } else if (pattern.type === "ObjectPattern") {
      for (const p of pattern.properties) {
        const key = p.computed ? string(p.key) : p.key?.name ?? p.key?.value;
        declare(p.value ?? p.argument, env, source && key ? { ...source, property: key } : null);
      }
    } else if (pattern.type === "ArrayPattern") pattern.elements.forEach(p => declare(p, env));
    else if (pattern.type === "AssignmentPattern") declare(pattern.left, env, { node: pattern.right, env });
    else if (pattern.type === "RestElement") declare(pattern.argument, env);
  }
  function visit(node, env) {
    if (!node?.type) return;
    if (/^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/u.test(node.type)) {
      if (node.type === "FunctionDeclaration") declare(node.id, env, { value: 4 });
      env = scope(env, true); declare(node.id, env, { value: 4 });
      node.params.forEach(p => declare(p, env));
    } else if (["BlockStatement", "CatchClause", "ForStatement", "ForOfStatement", "ForInStatement", "SwitchStatement"].includes(node.type)) {
      env = scope(env); if (node.type === "CatchClause") declare(node.param, env);
    }
    scopes.set(node, env); nodes.push(node);
    if (node.type === "VariableDeclaration") {
      let target = env; if (node.kind === "var") while (!target.fn) target = target.parent;
      for (const d of node.declarations) declare(d.id, target, d.init ? { node: d.init, env } : null);
    }
    if (node.type === "ClassDeclaration") declare(node.id, env, { value: 4 });
    if (node.type === "ImportDeclaration") node.specifiers.forEach(s => declare(s.local, env));
    if (node.type === "AssignmentExpression" && node.operator === "=" && node.left.type === "Identifier") assignments.push({ node, env });
    for (const [key, child] of Object.entries(node)) {
      if (["loc", "start", "end"].includes(key)) continue;
      if (Array.isArray(child)) child.forEach(n => visit(n, env));
      else if (child?.type) visit(child, env);
    }
  }
  visit(ast, root);
  for (const { node, env } of assignments) {
    const b = binding(env, node.left.name);
    if (b) b.push({ node: node.right, env });
  }
  function string(n) {
    if (n?.type === "Literal" && typeof n.value === "string") return n.value;
    if (n?.type === "TemplateLiteral" && !n.expressions.length) return n.quasis[0].value.cooked;
    if (n?.type === "BinaryExpression" && n.operator === "+") { const a = string(n.left), b = string(n.right); if (a !== null && b !== null) return a + b; }
    return null;
  }
  const property = n => n.computed ? string(n.property) : n.property?.name;
  function member(value, key) {
    if ((value & 2) && ["Function", "eval"].includes(key)) return 1;
    if ((value & 2) && ["globalThis", "window", "self"].includes(key)) return 2;
    if ((value & 5) && key === "constructor") return 1;
    if ((value & 5) && key === "bind") return 8;
    if ((value & 9) && ["call", "apply"].includes(key)) return value & 9;
    return 0;
  }
  function resolve(n, env, seen = new Set()) {
    if (!n) return 0;
    if (n.type === "Identifier") {
      const b = binding(env, n.name);
      if (b) {
        if (seen.has(b)) return 0;
        const next = new Set(seen); next.add(b);
        return b.reduce((v, s) => { const r = s.value ?? resolve(s.node, s.env, next); return v | (s.property ? member(r, s.property) : r); }, 0);
      }
      return ["Function", "eval"].includes(n.name) ? 1 : ["globalThis", "window", "self"].includes(n.name) ? 2 : 0;
    }
    if (n.type === "MemberExpression") return member(resolve(n.object, env, seen), property(n));
    if (n.type === "SequenceExpression") return resolve(n.expressions.at(-1), env, seen);
    if (n.type === "ChainExpression") return resolve(n.expression, env, seen);
    if (n.type === "AssignmentExpression") return resolve(n.right, env, seen);
    if (n.type === "ConditionalExpression") return resolve(n.consequent, env, seen) | resolve(n.alternate, env, seen);
    if (n.type === "LogicalExpression") return resolve(n.left, env, seen) | resolve(n.right, env, seen);
    if (["FunctionExpression", "ArrowFunctionExpression", "ClassExpression"].includes(n.type)) return 4;
    if (n.type === "CallExpression" && n.callee.type === "MemberExpression") {
      const key = property(n.callee);
      if (key === "bind") return resolve(n.callee.object, env, seen);
      // Function.bind.apply(target, args) binds TARGET, not Function. This is
      // emitted by the admitted HTML minifier's ordinary constructor wrapper.
      if (["call", "apply"].includes(key) && (resolve(n.callee.object, env, seen) & 8)) return resolve(n.arguments[0], env, seen);
    }
    return 0;
  }
  return nodes.filter(n => ["CallExpression", "NewExpression"].includes(n.type) && (resolve(n.callee, scopes.get(n)) & 1));
}

export function assertNoDynamicEvaluators(source, label) {
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true });
  const sites = findDynamicEvaluators(ast);
  if (sites.length) throw new Error(`${label}: dynamic source evaluator is forbidden (${sites.length} AST sites)`);
}
