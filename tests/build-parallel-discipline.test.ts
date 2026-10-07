// tests/build-parallel-discipline.test.ts — bead chrome-agent-platform-jjsz.
//
// Three RULES the parallel build pipeline must keep. build.mjs is a script (importing it runs a
// build), so these are AST rules over its PARSED TEXT, not substring pins: comments, strings and
// import specifiers cannot satisfy them. Each rule was proven by a mutant that removes the live
// construct AND by a mutant that adds a FRESH instance of what the rule forbids (a pin on today's
// instance is not a pin on the rule) — see the jjsz landing evidence bundle. The rule FUNCTIONS are
// proven in this file too: a compact clean fixture must be accepted and each mutant of it rejected by
// the category it targets, so a regression inside a rule function cannot hide behind a build script
// that happens to be clean.
//
//  A. No early-rejecting combinator in build.mjs. `Promise.all/race/any` reject (or resolve) while
//     siblings are still running; build.mjs fans out writers into its staging directory and its
//     failure path then removes that directory. Every fan-out goes through settleAll
//     (scripts/lib/build-concurrency.mjs, behaviour proven in tests/build-concurrency.test.ts), and
//     now also:
//       - `Promise.allSettled` is refused too: awaited bare it never rejects, so a failed writer would
//         be swallowed and the build would go on to publish;
//       - EVERY settleAll(...) call is directly awaited or returned (checked per call, not "at least
//         one"), and settleAll is never aliased, shadowed or passed around as a value;
//       - the final evaluator gate (chrome-agent-platform-kdax) is wired: an awaited settleAll over
//         ALL_BUNDLE_PATHS whose callback hands assertNoDynamicEvaluators the CONTENTS of each bundle
//         (readFile of the callback's path parameter), as a straight-line statement — not in a
//         function that may never run, not under a branch, not in a catch/finally — and
//         assertNoDynamicEvaluators is the one imported from the evaluator scan;
//       - the cheap evasions are refused: Array.fromAsync, computed member access of "Promise" (also
//         through a folded constant such as "Pro" + "mise"), and the identifiers globalThis, global and
//         Reflect (build.mjs uses none of them).
//     package-archive.mjs's stage writer `copyInventoryToStage` follows the same rule. The module
//     legitimately uses Promise.all in READ-ONLY functions, so the whole module is NOT held to "no
//     Promise.all"; instead EVERY function whose body (nested functions included) calls a write
//     primitive (writeFile, appendFile, copyFile, cp, mkdir, rename, symlink, link, chmod, chown,
//     lchmod, lchown, utimes, lutimes, truncate, rm, rmdir, unlink, createWriteStream) must be free
//     of early-rejecting uses.
//
//     What rule A does NOT catch (stated, not implied): an IMPORTED helper that fans out with
//     Promise.all internally (the AST sees only the file it parses; settleAll's own correctness is
//     tests/build-concurrency.test.ts); in package-archive.mjs, a read-looking function that wraps
//     Promise.all and is called with writers (`await fanOut(items.map(writeOne))`) because only
//     functions that contain a write call themselves are scanned; a write through a primitive that is
//     not in the list above (the make-temp-directory call is deliberately absent: the repo's
//     durable-root guard bans its name in test sources, and package-archive.mjs's two uses sit in
//     functions that also call rm, mkdir or rename); an aliased named fs import
//     (`import { writeFile as put }`), a write at module top level, and code reached through eval,
//     `new Function`, import() of another module or `(async () => {})().constructor`.
//  B. The build-once record ("this build exited 0") has ONE writer: writeBuildOnceRecord in
//     scripts/lib/build-once-record.mjs, which applies the strict shouldRecordBuild gate INSIDE
//     itself and whose behaviour is executed by tests/build-once-record.test.ts. This file pins the
//     CALL SITE in build.mjs: it is imported from the helper under its own name and never redeclared;
//     there is exactly one call, a top-level `await` statement; its single argument is exactly
//     { record: storeBuildRecord, buildSucceeded, exitCode: process.exitCode ?? 0 } (no constant, no
//     spread, no extra property); it comes AFTER the last top-level try/finally (after the staging
//     cleanup and the lock release), and the ONLY statement after it is the warn-only changelog block
//     (so nothing fatal can follow the record write; that block's own gate must receive the same live
//     build state, so it too can never be opened by a constant or by the captured record); and nothing
//     else in build.mjs writes a record:
//     no directory-name literal (a plain, template or concatenated string), no durableRoot, and the
//     captured record is never read except by that call. Written earlier, or ungated, the record
//     outlives a late failure and lets build-smoke pass on a build that exited non-zero.
//     NOT caught: a fatal raised later by an exit handler or an unhandled rejection; a record directory
//     name assembled at runtime from parts (`["serial", "build", "once"].join("-")`) by a writer that
//     finds the durable root without naming it; the helper's own behaviour and its agreement with
//     tests/fixtures/build-once.mjs (tests/build-once-record.test.ts).
//  C. The version-GC grace comes from the tested resolver, not an inline constant.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { parse } from "npm:acorn";

// deno-lint-ignore no-explicit-any
type Node = any;

function parseSource(source: string): Node {
  return parse(source, { ecmaVersion: "latest", sourceType: "module", locations: true });
}

// One read per file per run: the real files are parsed once and the analyses never mutate the AST.
const parsedModules = new Map<string, { program: Node; source: string }>();
function parseModule(relativeToRepo: string): { program: Node; source: string } {
  const known = parsedModules.get(relativeToRepo);
  if (known) return known;
  const source = Deno.readTextFileSync(new URL(`../${relativeToRepo}`, import.meta.url));
  const parsed = { program: parseSource(source), source };
  parsedModules.set(relativeToRepo, parsed);
  return parsed;
}

/** Every AST node under `root` (including `root`), depth first. */
function* walk(root: unknown): Generator<Node> {
  if (Array.isArray(root)) {
    for (const child of root) yield* walk(child);
    return;
  }
  if (root === null || typeof root !== "object") return;
  const node = root as Node;
  if (typeof node.type !== "string") return;
  yield node;
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "type" || key === "start" || key === "end") continue;
    yield* walk(value);
  }
}

/** Every AST node under `root` paired with its parent (the root's parent is `parent`). */
function* walkWithParent(root: unknown, parent: Node | null = null): Generator<[Node, Node | null]> {
  if (Array.isArray(root)) {
    for (const child of root) yield* walkWithParent(child, parent);
    return;
  }
  if (root === null || typeof root !== "object") return;
  const node = root as Node;
  if (typeof node.type !== "string") return;
  yield [node, parent];
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "type" || key === "start" || key === "end") continue;
    yield* walkWithParent(value, node);
  }
}

type Parents = Map<Node, Node | null>;
function parentMapOf(program: Node): Parents {
  const parents: Parents = new Map();
  for (const [node, parent] of walkWithParent(program)) parents.set(node, parent);
  return parents;
}

const where = (node: Node) => `line ${node.loc.start.line}`;

const isIdent = (node: Node, name: string) => node?.type === "Identifier" && node.name === name;

const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

/** The statically known string value of an expression (literal, constant template, `+` of constants), else null. */
function constString(node: Node): string | null {
  if (!node) return null;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral") {
    let out = "";
    for (let i = 0; i < node.quasis.length; i++) {
      out += node.quasis[i].value.cooked ?? "";
      if (i < node.expressions.length) {
        const part = constString(node.expressions[i]);
        if (part === null) return null;
        out += part;
      }
    }
    return out;
  }
  if (node.type === "BinaryExpression" && node.operator === "+") {
    const left = constString(node.left);
    const right = constString(node.right);
    return left !== null && right !== null ? left + right : null;
  }
  return null;
}

/** Like constString, but a template keeps its constant parts when other parts are not constant. */
function foldedString(node: Node): string | null {
  if (node?.type === "TemplateLiteral") {
    let out = "";
    for (let i = 0; i < node.quasis.length; i++) {
      out += node.quasis[i].value.cooked ?? "";
      if (i < node.expressions.length) out += constString(node.expressions[i]) ?? "\u0000";
    }
    return out;
  }
  return constString(node);
}

/** The identifiers a binding pattern declares. */
function patternNames(pattern: Node): string[] {
  if (!pattern) return [];
  switch (pattern.type) {
    case "Identifier":
      return [pattern.name];
    case "ObjectPattern":
      return pattern.properties.flatMap((p: Node) => patternNames(p.type === "RestElement" ? p.argument : p.value));
    case "ArrayPattern":
      return pattern.elements.flatMap((element: Node) => patternNames(element));
    case "RestElement":
      return patternNames(pattern.argument);
    case "AssignmentPattern":
      return patternNames(pattern.left);
    default:
      return [];
  }
}

/** Does `node` introduce a binding called `name` (declaration, declarator, parameter, catch parameter)? */
function declaresName(node: Node, name: string): boolean {
  if ((node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") && isIdent(node.id, name)) return true;
  if (node.type === "FunctionExpression" && isIdent(node.id, name)) return true;
  if (node.type === "VariableDeclarator" && patternNames(node.id).includes(name)) return true;
  if (FUNCTION_TYPES.has(node.type) && node.params.some((param: Node) => patternNames(param).includes(name))) return true;
  if (node.type === "CatchClause" && patternNames(node.param).includes(name)) return true;
  return false;
}

// ---------------------------------------------------------------------------------------------------
// Rule A: the combinators.
// ---------------------------------------------------------------------------------------------------

/** The property name of `Promise.<name>` / `Promise["<name>"]`, else null. */
function promiseMember(node: Node): string | null {
  if (node?.type !== "MemberExpression" || !isIdent(node.object, "Promise")) return null;
  if (!node.computed && node.property.type === "Identifier") return node.property.name;
  if (node.computed) return constString(node.property) ?? "<computed>";
  return "<computed>";
}

/** The only `Promise` statics build code may use: constructors that cannot reject a fan-out early.
 *  allSettled is deliberately NOT here — see the header: awaited bare, it swallows every rejection. */
const STRICT_STATICS = new Set(["resolve", "reject", "withResolvers"]);

/** Violations of rule A inside `scope`: any use of the global Promise other than `new Promise(...)`
 *  and the constructor-style statics, including aliasing it (`const P = Promise`). */
function earlyRejectingUses(scope: Node, allowedStatics: Set<string> = STRICT_STATICS): string[] {
  const problems: string[] = [];
  let promiseIdentifiers = 0;
  let accountedFor = 0;
  for (const node of walk(scope)) {
    if (isIdent(node, "Promise")) promiseIdentifiers++;
    if (node.type === "NewExpression" && isIdent(node.callee, "Promise")) accountedFor++;
    const member = promiseMember(node);
    if (member !== null) {
      accountedFor++;
      if (!allowedStatics.has(member)) problems.push(`Promise.${member} at ${where(node)}`);
    }
  }
  if (promiseIdentifiers !== accountedFor) {
    problems.push(
      `the global Promise is referenced ${promiseIdentifiers - accountedFor} time(s) other than as "new Promise" or Promise.<static> (an alias would hide Promise.all)`,
    );
  }
  return problems;
}

const EVASION_IDENTIFIERS = new Set(["globalThis", "global", "Reflect", "fromAsync"]);
const EVASION_COMPUTED_NAMES = new Set(["Promise", "fromAsync"]);

/** The cheap ways to reach Promise.all / Array.fromAsync without writing `Promise.all`. */
function evasionUses(scope: Node): string[] {
  const problems: string[] = [];
  for (const node of walk(scope)) {
    if (node.type === "Identifier" && EVASION_IDENTIFIERS.has(node.name)) {
      problems.push(`the identifier ${node.name} at ${where(node)} (a way to reach Promise.all or Array.fromAsync without naming them)`);
    }
    let computedKey: Node = null;
    if (node.type === "MemberExpression" && node.computed) computedKey = node.property;
    if ((node.type === "Property" || node.type === "MethodDefinition" || node.type === "PropertyDefinition") && node.computed) {
      computedKey = node.key;
    }
    const name = computedKey ? constString(computedKey) : null;
    if (name !== null && EVASION_COMPUTED_NAMES.has(name)) {
      problems.push(`computed access of ${JSON.stringify(name)} at ${where(node)}`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------
// Rule A: settleAll.
// ---------------------------------------------------------------------------------------------------

function settleAllCalls(scope: Node): Node[] {
  return [...walk(scope)].filter((n) => n.type === "CallExpression" && isIdent(n.callee, "settleAll"));
}

/** settleAll is the REAL helper: imported once from the tested module under its own name, never shadowed. */
function settleAllHelperProblems(program: Node, specifier: string): string[] {
  const problems: string[] = [];
  const specifiers = program.body
    .filter((n: Node) => n.type === "ImportDeclaration" && n.source.value === specifier)
    .flatMap((n: Node) => n.specifiers)
    .filter((s: Node) => s.type === "ImportSpecifier" && s.imported.name === "settleAll");
  if (specifiers.length !== 1) {
    problems.push(`settleAll must be imported from ${specifier} exactly once (found ${specifiers.length})`);
  } else if (specifiers[0].local.name !== "settleAll") {
    problems.push(`settleAll must be imported under its own name, not as ${specifiers[0].local.name}`);
  }
  for (const node of walk(program)) {
    if (declaresName(node, "settleAll")) problems.push(`settleAll is declared locally at ${where(node)} (the real helper must not be shadowed)`);
  }
  return problems;
}

/** Every settleAll reference in `scope` is a direct call, and every call is awaited or returned. */
function settleAllUseProblems(scope: Node, parents: Parents): string[] {
  const problems: string[] = [];
  for (const node of walk(scope)) {
    if (!isIdent(node, "settleAll")) continue;
    const parent = parents.get(node);
    if (parent?.type === "ImportSpecifier") continue;
    if (!(parent?.type === "CallExpression" && parent.callee === node)) {
      problems.push(`settleAll is referenced at ${where(node)} other than as a direct call (an alias or a callback hides the call site)`);
      continue;
    }
    const consumer = parents.get(parent);
    const consumed = (consumer?.type === "AwaitExpression" || consumer?.type === "ReturnStatement") && consumer.argument === parent;
    if (!consumed) {
      problems.push(`settleAll(...) at ${where(parent)} is not directly awaited or returned (its siblings may still be writing when the next step runs)`);
    }
  }
  return problems;
}

// Statement-level branches and loops (an expression-level `a && await x()` is refused separately: the
// awaited gate must be a statement of its own, and a statement cannot sit in an expression without a function).
const CONDITIONAL_TYPES = new Set([
  "IfStatement",
  "SwitchCase",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
]);

/** Why `node` might never run: inside a function, under a branch or loop, or in a catch/finally clause. */
function straightLineProblems(node: Node, parents: Parents, label: string): string[] {
  const problems: string[] = [];
  let child = node;
  for (let ancestor = parents.get(child); ancestor; child = ancestor, ancestor = parents.get(child)) {
    if (FUNCTION_TYPES.has(ancestor.type)) {
      problems.push(`${label} sits inside a function (${where(ancestor)}), which may never be called`);
    } else if (CONDITIONAL_TYPES.has(ancestor.type)) {
      problems.push(`${label} sits under a ${ancestor.type} (${where(ancestor)}), so it may not run`);
    } else if (ancestor.type === "CatchClause" || (ancestor.type === "TryStatement" && ancestor.block !== child)) {
      problems.push(`${label} sits in a catch or finally clause (${where(ancestor)})`);
    }
  }
  return problems;
}

const isBundlePathMap = (call: Node) => {
  const fanOut = call.arguments[0];
  return fanOut?.type === "CallExpression" && fanOut.callee.type === "MemberExpression" && !fanOut.callee.computed &&
    isIdent(fanOut.callee.object, "ALL_BUNDLE_PATHS") && isIdent(fanOut.callee.property, "map");
};

/** The shape of ONE candidate gate: `await settleAll(ALL_BUNDLE_PATHS.map(async (p) => { assertNoDynamicEvaluators(await readFile(p, ...), p); }))`. */
function gateShapeProblems(call: Node, parents: Parents): string[] {
  const problems: string[] = [];
  if (call.arguments.length !== 1) problems.push("settleAll must be given exactly the one fan-out array");
  const mapCall = call.arguments[0];
  const callback = mapCall.arguments[0];
  if (mapCall.arguments.length !== 1 || !FUNCTION_TYPES.has(callback?.type)) {
    return [...problems, "the gate fan-out must map ALL_BUNDLE_PATHS with exactly one function"];
  }
  const pathParam = callback.params[0];
  if (pathParam?.type !== "Identifier") {
    return [...problems, "the gate callback must take the bundle path as its first parameter"];
  }
  const statements: Node[] = callback.body.type === "BlockStatement" ? callback.body.body : [callback.body];
  if (statements.length !== 1) {
    problems.push(
      `the gate callback must be exactly the one assertNoDynamicEvaluators(...) statement (found ${statements.length}): an early return or a branch could skip a bundle`,
    );
  }
  const gateStatement = statements.find((s) => {
    const expression = s.type === "ExpressionStatement" ? s.expression : s;
    return expression?.type === "CallExpression" && isIdent(expression.callee, "assertNoDynamicEvaluators");
  });
  if (!gateStatement) {
    problems.push("the callback must call assertNoDynamicEvaluators(...) as one of its own statements (not inside a branch or an inner function)");
  } else {
    const gateCall = gateStatement.type === "ExpressionStatement" ? gateStatement.expression : gateStatement;
    const first = gateCall.arguments[0];
    const read = first?.type === "AwaitExpression" ? first.argument : first;
    const asyncRead = read?.type === "CallExpression" && isIdent(read.callee, "readFile");
    const syncRead = read?.type === "CallExpression" && isIdent(read.callee, "readFileSync");
    // An async readFile that is not awaited hands the scan a Promise, not the bundle's bytes.
    const readsBundle = ((asyncRead && first.type === "AwaitExpression") || syncRead) && isIdent(read.arguments[0], pathParam.name);
    if (!readsBundle) {
      problems.push(
        `assertNoDynamicEvaluators must be handed the CONTENTS of the bundle: its first argument must be exactly await readFile(${pathParam.name}, ...) or readFileSync(${pathParam.name}, ...)`,
      );
    }
  }
  const awaited = parents.get(call);
  if (!(awaited?.type === "AwaitExpression" && awaited.argument === call)) {
    problems.push("the gate's settleAll must be directly awaited");
  } else {
    const statement = parents.get(awaited);
    if (statement?.type !== "ExpressionStatement") problems.push("the awaited gate must be a statement of its own");
    else problems.push(...straightLineProblems(statement, parents, "the gate"));
  }
  return problems;
}

/** N2: the final evaluator gate is wired — and its assertNoDynamicEvaluators is the real imported one. */
function evaluatorGateProblems(program: Node, parents: Parents): string[] {
  const bindings = [...walk(program)].filter((n) => declaresName(n, "assertNoDynamicEvaluators"));
  const fromScan = bindings.filter((n) => {
    const init = n.type === "VariableDeclarator" ? n.init : null;
    const imported = init?.type === "AwaitExpression" ? init.argument : null;
    return imported?.type === "ImportExpression" && constString(imported.source) === "./scripts/lib/dynamic-evaluator-scan.mjs";
  });
  const problems: string[] = [];
  if (bindings.length !== 1 || fromScan.length !== 1) {
    problems.push(
      `assertNoDynamicEvaluators must have exactly one binding, from await import("./scripts/lib/dynamic-evaluator-scan.mjs") (found ${bindings.length} binding(s), ${fromScan.length} from the scan)`,
    );
  }
  const gates = settleAllCalls(program).filter(isBundlePathMap).filter((call) =>
    [...walk(call)].some((n) => isIdent(n, "assertNoDynamicEvaluators"))
  );
  if (gates.length === 0) {
    problems.push("no settleAll(ALL_BUNDLE_PATHS.map(...)) fan-out calls assertNoDynamicEvaluators: the final evaluator gate is missing");
    return problems;
  }
  const attempts = gates.map((gate) => gateShapeProblems(gate, parents));
  if (!attempts.some((attempt) => attempt.length === 0)) problems.push(...attempts[0]);
  return problems;
}

// ---------------------------------------------------------------------------------------------------
// Rule A: package-archive.mjs.
// ---------------------------------------------------------------------------------------------------

// Every fs call that mutates the file system. A function that calls one of these AND fans out with an
// early-rejecting combinator can leave a sibling still writing (or removing) after the caller has moved on
// to remove the staging directory. Reads (stat, readFile, readdir, ...) are deliberately absent.
const WRITE_PRIMITIVES = new Set([
  "writeFile",
  "appendFile",
  "copyFile",
  "cp",
  "mkdir",
  "rename",
  "symlink",
  "link",
  "chmod",
  "chown",
  "lchmod",
  "lchown",
  "utimes",
  "lutimes",
  "truncate",
  "rm",
  "rmdir",
  "unlink",
  "createWriteStream",
]);

function calleeName(callee: Node): string | null {
  if (callee?.type === "Identifier") return callee.name;
  if (callee?.type === "MemberExpression") {
    if (!callee.computed && callee.property.type === "Identifier") return callee.property.name;
    if (callee.computed) return constString(callee.property);
  }
  return null;
}

/** Every function (declaration, expression, arrow, method) whose body — nested functions included — calls a write primitive. */
function writerFunctions(program: Node): Node[] {
  return [...walk(program)].filter((n) =>
    FUNCTION_TYPES.has(n.type) &&
    [...walk(n.body)].some((c) => c.type === "CallExpression" && WRITE_PRIMITIVES.has(calleeName(c.callee) ?? ""))
  );
}

const functionLabel = (fn: Node) => fn.id?.name ?? `${fn.type} at ${where(fn)}`;

type Report = Record<string, string[]>;

function packageArchiveReport(program: Node): Report {
  const parents = parentMapOf(program);
  const report: Report = { "PA.import": [], "PA.stageWriter": [], "PA.writers": [] };
  report["PA.import"].push(...settleAllHelperProblems(program, "./lib/build-concurrency.mjs"), ...settleAllUseProblems(program, parents));
  const stage = program.body.find((n: Node) => n.type === "FunctionDeclaration" && n.id?.name === "copyInventoryToStage");
  if (!stage) {
    report["PA.stageWriter"].push("copyInventoryToStage must exist (it writes into the private staging directory the finally removes)");
  } else {
    report["PA.stageWriter"].push(...earlyRejectingUses(stage));
    if (settleAllCalls(stage).length < 1) report["PA.stageWriter"].push("copyInventoryToStage must call settleAll");
  }
  const writers = writerFunctions(program);
  const seen = new Set<string>();
  for (const fn of writers) {
    for (const problem of [...earlyRejectingUses(fn), ...evasionUses(fn)]) {
      if (seen.has(problem)) continue;
      seen.add(problem);
      report["PA.writers"].push(`${functionLabel(fn)}: ${problem}`);
    }
  }
  if (!writers.some((fn) => fn.id?.name === "copyInventoryToStage")) {
    report["PA.writers"].push("the writer scan did not find copyInventoryToStage: the scan is vacuous");
  }
  return report;
}

// ---------------------------------------------------------------------------------------------------
// Rule B: the call site of the build-once record writer.
// ---------------------------------------------------------------------------------------------------

const RECORD_HELPER = "./scripts/lib/build-once-record.mjs";
const RECORD_WRITER = "writeBuildOnceRecord";
const RECORD_DIR_NAME = "serial-build-once";

function topLevelStatementOf(node: Node, parents: Parents): Node {
  let current = node;
  for (;;) {
    const parent = parents.get(current);
    if (!parent || parent.type === "Program") return current;
    current = parent;
  }
}

const isProcessMember = (node: Node, property: string) =>
  node?.type === "MemberExpression" && !node.computed && isIdent(node.object, "process") && isIdent(node.property, property);

/**
 * Problems with an object literal that must hand a gate the LIVE build state: `buildSucceeded` (the
 * identifier), `exitCode: process.exitCode ?? 0`, and — when `withRecord` — `record: storeBuildRecord`;
 * and nothing else. No constant, no spread or computed key, no extra property, and never `||` for the
 * exit code (a failed build's `process.exitCode = 1` must reach the gate as 1, not be defaulted away).
 */
function liveBuildStateProblems(argument: Node, withRecord: boolean): string[] {
  const problems: string[] = [];
  const values = new Map<string, Node>();
  for (const property of argument.properties) {
    if (property.type !== "Property" || property.computed || property.kind !== "init" || property.method) {
      problems.push(`${where(property)}: only plain "name: value" properties are allowed (no spread, computed key, accessor or method)`);
      continue;
    }
    const name = property.key.type === "Identifier" ? property.key.name : property.key.type === "Literal" ? String(property.key.value) : "<unknown>";
    if (values.has(name)) problems.push(`property ${name} is given twice`);
    values.set(name, property.value);
  }
  const expected = withRecord ? "buildSucceeded, exitCode, record" : "buildSucceeded, exitCode";
  const names = [...values.keys()].sort().join(", ");
  if (names !== expected) problems.push(`the properties must be exactly ${expected} (found ${names || "none"})`);
  const record = values.get("record");
  if (record && !isIdent(record, "storeBuildRecord")) problems.push("record must be the identifier storeBuildRecord");
  const succeeded = values.get("buildSucceeded");
  if (succeeded && !isIdent(succeeded, "buildSucceeded")) problems.push("buildSucceeded must be the identifier buildSucceeded (never a constant)");
  const exitCode = values.get("exitCode");
  if (
    exitCode &&
    !(exitCode.type === "LogicalExpression" && exitCode.operator === "??" && isProcessMember(exitCode.left, "exitCode") &&
      exitCode.right.type === "Literal" && exitCode.right.value === 0)
  ) {
    problems.push("exitCode must be exactly process.exitCode ?? 0 (never a constant, never ||)");
  }
  return problems;
}

type RecordReport = { import: string[]; call: string[]; argument: string[]; tail: string[]; singleWriter: string[] };

function recordSiteReport(program: Node, parents: Parents): RecordReport {
  const all = [...walk(program)];
  const report: RecordReport = { import: [], call: [], argument: [], tail: [], singleWriter: [] };

  // (1) imported from the helper under its own name, bound once, never redeclared.
  const imports = program.body.filter((n: Node) => n.type === "ImportDeclaration");
  const fromHelper = imports.filter((n: Node) => n.source.value === RECORD_HELPER);
  if (fromHelper.length !== 1) {
    report.import.push(`exactly one import from ${RECORD_HELPER} is required (found ${fromHelper.length})`);
  } else {
    const [specifier, ...rest] = fromHelper[0].specifiers;
    if (rest.length > 0 || specifier?.type !== "ImportSpecifier" || specifier.imported.name !== RECORD_WRITER || specifier.local.name !== RECORD_WRITER) {
      report.import.push(`the import from ${RECORD_HELPER} must be exactly { ${RECORD_WRITER} } under its own name`);
    }
  }
  const bindings = imports.flatMap((n: Node) => n.specifiers).filter((s: Node) => s.local.name === RECORD_WRITER);
  if (bindings.length !== 1) report.import.push(`${RECORD_WRITER} must be bound by exactly one import (found ${bindings.length})`);
  for (const node of all) {
    if (declaresName(node, RECORD_WRITER)) report.import.push(`${RECORD_WRITER} is declared locally at ${where(node)} (the real writer must not be shadowed)`);
  }

  // (2) exactly one call, directly awaited, a top-level statement; no other reference to the writer.
  const calls = all.filter((n) => n.type === "CallExpression" && isIdent(n.callee, RECORD_WRITER));
  if (calls.length !== 1) report.call.push(`exactly one ${RECORD_WRITER}(...) call is required (found ${calls.length})`);
  for (const node of all) {
    if (!isIdent(node, RECORD_WRITER)) continue;
    const parent = parents.get(node);
    if (parent?.type === "ImportSpecifier" || (parent?.type === "CallExpression" && parent.callee === node)) continue;
    report.call.push(`${RECORD_WRITER} is referenced at ${where(node)} other than as a direct call`);
  }
  const call = calls.length === 1 ? calls[0] : null;
  if (call) {
    const awaited = parents.get(call);
    if (!(awaited?.type === "AwaitExpression" && awaited.argument === call)) {
      report.call.push(`the ${RECORD_WRITER}(...) call at ${where(call)} must be directly awaited`);
    } else {
      const statement = parents.get(awaited);
      if (!(statement?.type === "ExpressionStatement" && statement.expression === awaited && parents.get(statement) === program)) {
        report.call.push(`the awaited call at ${where(call)} must be a top-level ExpressionStatement of the module`);
      }
    }
  }

  // (3) its single argument: { record: storeBuildRecord, buildSucceeded, exitCode: process.exitCode ?? 0 } and nothing else.
  if (call) {
    const argument = call.arguments[0];
    if (call.arguments.length !== 1 || argument?.type !== "ObjectExpression") {
      report.argument.push(`${RECORD_WRITER} must be given exactly one argument, an object literal`);
    } else {
      report.argument.push(...liveBuildStateProblems(argument, true));
    }
  }

  // (4) after the last top-level try/finally; only the warn-only changelog block may follow.
  if (call) {
    const body: Node[] = program.body;
    const statement = topLevelStatementOf(call, parents);
    const index = body.indexOf(statement);
    const lastTry = body.reduce((last, s, i) => (s.type === "TryStatement" ? i : last), -1);
    if (lastTry < 0) {
      report.tail.push("the build script must still have its top-level try/finally finalizers");
    } else if (index <= lastTry) {
      report.tail.push(
        `the record write (${where(call)}) must come AFTER the last top-level try/finally (${where(body[lastTry])}): the staging cleanup and the lock release are its last fatal steps`,
      );
    }
    const after = body.slice(index + 1);
    if (after.length !== 1) {
      report.tail.push(`exactly one top-level statement may follow the record write (the warn-only changelog block); found ${after.length}`);
    } else {
      const next = after[0];
      const gated = next.type === "IfStatement" && next.test.type === "CallExpression" && isIdent(next.test.callee, "shouldRecordBuild");
      if (!gated) {
        report.tail.push(`the only statement after the record write must be the changelog block, if (shouldRecordBuild(...)) { ... } (found ${next.type} at ${where(next)})`);
      } else {
        const gateArgument = next.test.arguments[0];
        if (next.test.arguments.length !== 1 || gateArgument?.type !== "ObjectExpression") {
          report.tail.push("the changelog gate shouldRecordBuild(...) must be given exactly one argument, an object literal");
        } else {
          report.tail.push(...liveBuildStateProblems(gateArgument, false).map((problem) => `changelog gate: ${problem}`));
        }
        const block = next.consequent;
        const guarded = block.type === "BlockStatement" && block.body.length === 1 && block.body[0].type === "TryStatement";
        if (next.alternate) report.tail.push("the changelog block must not have an else branch");
        if (!guarded) {
          report.tail.push("the changelog block must be one try/catch, so a failure in it only warns");
        } else {
          const guard = block.body[0];
          if (!guard.handler || guard.finalizer) {
            report.tail.push("the changelog block must be try/catch without a finally (it never fails the build)");
          } else {
            const handler = [...walk(guard.handler.body)];
            const failsTheBuild = handler.some((n) =>
              n.type === "ThrowStatement" ||
              (n.type === "AssignmentExpression" && isProcessMember(n.left, "exitCode")) ||
              (n.type === "CallExpression" && n.callee.type === "MemberExpression" && isIdent(n.callee.object, "process") &&
                isIdent(n.callee.property, "exit"))
            );
            if (failsTheBuild) report.tail.push("the changelog catch must only warn: no throw, no process.exit, no process.exitCode");
          }
        }
      }
    }
  }

  // (5) ONE writer: no directory-name string in any spelling, no durableRoot, no other reader of the captured record.
  const spellings = new Set<string>();
  for (const node of all) {
    let text: string | null = null;
    if (node.type === "Literal" && typeof node.value === "string") text = node.value;
    else if (node.type === "TemplateElement") text = node.value.cooked ?? node.value.raw;
    else if (node.type === "TemplateLiteral" || node.type === "BinaryExpression") text = foldedString(node);
    if (text !== null && text.includes(RECORD_DIR_NAME)) spellings.add(`the record directory name appears at ${where(node)} (${node.type})`);
    if (isIdent(node, "durableRoot")) spellings.add(`durableRoot is referenced at ${where(node)}: the record directory belongs to the helper`);
    if (node.type === "Literal" && typeof node.value === "string" && node.value.includes("durable-root")) {
      spellings.add(`the durable-root module is named at ${where(node)}: the record directory belongs to the helper`);
    }
  }
  report.singleWriter.push(...spellings);
  const captureSite = call?.arguments[0];
  for (const node of all) {
    if (!isIdent(node, "storeBuildRecord")) continue;
    const parent = parents.get(node);
    const declared = parent?.type === "VariableDeclarator" && parent.id === node;
    const captured = parent?.type === "AssignmentExpression" && parent.left === node && parent.operator === "=";
    const handedToWriter = parent?.type === "Property" && parent.value === node && parents.get(parent) === captureSite;
    if (!declared && !captured && !handedToWriter) {
      report.singleWriter.push(`the captured record is read at ${where(node)}: only ${RECORD_WRITER} may consume it`);
    }
  }
  return report;
}

// ---------------------------------------------------------------------------------------------------
// The whole build script, as categories.
// ---------------------------------------------------------------------------------------------------

function buildScriptReport(program: Node): Report {
  const parents = parentMapOf(program);
  const record = recordSiteReport(program, parents);
  return {
    "A.combinators": earlyRejectingUses(program),
    "A.evasions": evasionUses(program),
    "A.helper": settleAllHelperProblems(program, "./scripts/lib/build-concurrency.mjs"),
    "A.awaited": settleAllUseProblems(program, parents),
    "A.gate": evaluatorGateProblems(program, parents),
    "B.import": record.import,
    "B.call": record.call,
    "B.argument": record.argument,
    "B.tail": record.tail,
    "B.singleWriter": record.singleWriter,
  };
}

let realBuildReport: Report | null = null;
function realBuild(): { report: Report; program: Node } {
  const { program } = parseModule("build.mjs");
  realBuildReport ??= buildScriptReport(program);
  return { report: realBuildReport, program };
}

const assertClean = (report: Report, categories: string[], hint: string) => {
  for (const category of categories) assertEquals(report[category], [], `${category}: ${hint}`);
};

// ---------------------------------------------------------------------------------------------------
// The real files.
// ---------------------------------------------------------------------------------------------------

Deno.test("build discipline A: build.mjs has no Promise.all/race/any — every fan-out settles before a failure can reach the staging rollback", () => {
  const { report, program } = realBuild();
  assertEquals(report["A.combinators"], [], "build.mjs must fan out through settleAll");

  // settleAll is the REAL helper: imported from the tested module, not shadowed by a local binding.
  assertEquals(report["A.helper"], [], "settleAll must be the tested helper, imported under its own name");
  assert(settleAllCalls(program).length >= 1, "build.mjs must actually call settleAll (an import is not a call site)");
});

Deno.test("build discipline A: every settleAll(...) call in build.mjs is directly awaited or returned, and none is aliased or passed as a value", () => {
  const { report } = realBuild();
  assertEquals(report["A.awaited"], [], "an un-awaited settleAll lets the next step (and the rollback) run under live writers");
});

Deno.test("build discipline A: the final evaluator gate is an awaited settleAll over ALL_BUNDLE_PATHS that reads each bundle into the real assertNoDynamicEvaluators", () => {
  const { report } = realBuild();
  assertEquals(report["A.gate"], [], "the final whole-AST evaluator gate must stay wired");
});

Deno.test("build discipline A: build.mjs has none of the cheap evasions (Array.fromAsync, computed Promise access, globalThis/global/Reflect)", () => {
  const { report } = realBuild();
  assertEquals(report["A.evasions"], [], "a rule that Promise.all cannot be written must not be satisfiable by writing it another way");
});

Deno.test("build discipline A: package-archive.mjs's stage writer (copyInventoryToStage) settles too", () => {
  const { program } = parseModule("scripts/package-archive.mjs");
  const report = packageArchiveReport(program);
  const writer = program.body.find((n: Node) => n.type === "FunctionDeclaration" && n.id?.name === "copyInventoryToStage");
  assert(writer, "copyInventoryToStage must exist (it writes into the private staging directory the finally removes)");
  assertEquals(report["PA.stageWriter"], [], "copyInventoryToStage must not use Promise.all/race/any/allSettled and must call settleAll");
  const calls = settleAllCalls(writer);
  assert(calls.length >= 1, "copyInventoryToStage must call settleAll");
  assertEquals(report["PA.import"], [], "package-archive.mjs must import settleAll from ./lib/build-concurrency.mjs and await every call");
});

Deno.test("build discipline A: every function in package-archive.mjs that calls a write primitive is free of early-rejecting uses", () => {
  const { program } = parseModule("scripts/package-archive.mjs");
  const report = packageArchiveReport(program);
  assertEquals(report["PA.writers"], [], "a writer must not fan out with Promise.all/race/any/allSettled (read-only functions may)");
  // Non-vacuity: the scan sees the two known writers (and the read-only Promise.all functions stay out of it).
  const names = writerFunctions(program).map(functionLabel);
  assert(names.includes("copyInventoryToStage"), `the writer scan must find copyInventoryToStage (found ${names.join(", ")})`);
});

Deno.test("build discipline B.1: build.mjs imports writeBuildOnceRecord from the helper under its own name and calls it exactly once, as a top-level awaited statement", () => {
  const { report } = realBuild();
  assertClean(report, ["B.import", "B.call"], "the record has one writer, called once, awaited, at the top level");
});

Deno.test("build discipline B.2: the call's argument is exactly { record: storeBuildRecord, buildSucceeded, exitCode: process.exitCode ?? 0 }", () => {
  const { report } = realBuild();
  assertClean(report, ["B.argument"], "a constant or a swapped identifier would feed the gate something other than the live build state");
});

Deno.test("build discipline B.3: the record write comes after the last top-level try/finally, and only the warn-only changelog block follows it", () => {
  const { report } = realBuild();
  assertClean(report, ["B.tail"], "nothing fatal may run between the record write and the end of the build");
});

Deno.test("build discipline B.4: the record has ONE writer — the helper; build.mjs holds no record directory name, no durableRoot and no other reader of the captured record", () => {
  const { report } = realBuild();
  assertClean(report, ["B.singleWriter"], "a second writer could skip the gate");
});

Deno.test("build discipline C: the version-GC grace comes from resolveGcGraceMs(process.env) and drives the delay", () => {
  const { program } = parseModule("build.mjs");
  const all = [...walk(program)];
  const declarators = all.filter((n) => n.type === "VariableDeclarator" && isIdent(n.id, "gcGraceMs"));
  assertEquals(declarators.length, 1, "exactly one gcGraceMs binding");
  const init = declarators[0].init;
  assertEquals(init?.type, "CallExpression", "gcGraceMs must be initialised by a call, not a constant");
  assert(isIdent(init.callee, "resolveGcGraceMs"), "gcGraceMs must come from resolveGcGraceMs");
  assertEquals(init.arguments.length, 1);
  assert(
    init.arguments[0].type === "MemberExpression" && isIdent(init.arguments[0].object, "process") &&
      isIdent(init.arguments[0].property, "env"),
    "resolveGcGraceMs must be given process.env",
  );
  // ... and the resolved value is what the delay uses: one setTimeout whose DURATION argument is
  // gcGraceMs, inside an `if` whose condition reads gcGraceMs (so 0 skips the wait entirely).
  const timers = all.filter((n) =>
    n.type === "CallExpression" && isIdent(n.callee, "setTimeout") && isIdent(n.arguments[1], "gcGraceMs")
  );
  assertEquals(timers.length, 1, "exactly one timer must wait for gcGraceMs milliseconds");
  const guard = all.find((n) =>
    n.type === "IfStatement" && [...walk(n.test)].some((t) => isIdent(t, "gcGraceMs")) &&
    [...walk(n.consequent)].includes(timers[0])
  );
  assert(guard, "the grace timer must sit inside an `if` that reads gcGraceMs (0 = no wait)");
});

// ---------------------------------------------------------------------------------------------------
// Self-proof: the rule functions accept a clean fixture and reject each mutant of it. A mutant is a
// real text edit of the fixture (re-parsed from source), and each one names the category that must
// notice it. "today's instance removed" and "a FRESH instance added" are both represented.
// ---------------------------------------------------------------------------------------------------

const CLEAN = {
  imports: [
    'import { resolveGcGraceMs, settleAll } from "./scripts/lib/build-concurrency.mjs";',
    'import { writeBuildOnceRecord } from "./scripts/lib/build-once-record.mjs";',
    'import { shouldRecordBuild, writeLastBuiltVersion } from "./scripts/changelog-delta.mjs";',
  ].join("\n"),
  state: ["let buildSucceeded = false;", "let storeBuildRecord = null;"].join("\n"),
  fanOut: ["await settleAll(WRITERS.map(async (writer) => {", "  await writer();", "}));"].join("\n"),
  gateBinding: 'const { assertNoDynamicEvaluators } = await import("./scripts/lib/dynamic-evaluator-scan.mjs");',
  gate: [
    "await settleAll(ALL_BUNDLE_PATHS.map(async (gatePath) => {",
    '  assertNoDynamicEvaluators(await readFile(gatePath, "utf8"), gatePath);',
    "}));",
  ].join("\n"),
  capture: [
    "storeBuildRecord = {",
    "  key: `${marker.commit}-${marker.source.digest}`,",
    '  stdout: "built\\n",',
    "};",
  ].join("\n"),
  success: "buildSucceeded = true;",
  insideTry: "",
  beforeRecord: "",
  recordCall: "await writeBuildOnceRecord({ record: storeBuildRecord, buildSucceeded, exitCode: process.exitCode ?? 0 });",
  betweenRecordAndChangelog: "",
  changelog: [
    "if (shouldRecordBuild({ buildSucceeded, exitCode: process.exitCode ?? 0 })) {",
    "  try {",
    "    await writeLastBuiltVersion(version);",
    "  } catch (e) {",
    "    console.error(`warning: changelog delta print failed (${e?.message ?? e})`);",
    "  }",
    "}",
  ].join("\n"),
  afterChangelog: "",
};
type Blocks = typeof CLEAN;

function fixture(overrides: Partial<Blocks> = {}): string {
  const b = { ...CLEAN, ...overrides };
  return [
    b.imports,
    b.state,
    "try {",
    "  try {",
    b.fanOut,
    b.gateBinding,
    b.gate,
    b.capture,
    b.success,
    b.insideTry,
    "  } finally {",
    "    await cleanupStage();",
    "  }",
    "} finally {",
    "  await releaseLock();",
    "}",
    b.beforeRecord,
    b.recordCall,
    b.betweenRecordAndChangelog,
    b.changelog,
    b.afterChangelog,
  ].join("\n");
}

/** Replace `anchor` in `text`, asserting it occurs exactly once (an unapplied mutant proves nothing). */
function replaceOnce(text: string, anchor: string, replacement: string): string {
  const parts = text.split(anchor);
  assertEquals(parts.length - 1, 1, `mutation anchor ${JSON.stringify(anchor)} must occur exactly once`);
  return parts[0] + replacement + parts[1];
}

const reportOf = (source: string) => buildScriptReport(parseSource(source));

Deno.test("build discipline self-proof: the clean fixture is accepted by every category", () => {
  const report = reportOf(fixture());
  for (const [category, problems] of Object.entries(report)) assertEquals(problems, [], `${category} must accept the clean fixture`);
});

Deno.test("build discipline self-proof: equivalent spellings are accepted (a synchronous read; an expression-bodied callback; a returned settleAll)", () => {
  const spellings = [
    [
      "await settleAll(ALL_BUNDLE_PATHS.map(async (gatePath) => {",
      '  assertNoDynamicEvaluators(readFileSync(gatePath, "utf8"), gatePath);',
      "}));",
    ].join("\n"),
    'await settleAll(ALL_BUNDLE_PATHS.map(async (gatePath) => assertNoDynamicEvaluators(await readFile(gatePath, "utf8"), gatePath)));',
  ];
  for (const gate of spellings) {
    assert(gate !== CLEAN.gate, "a spelling must differ from the clean gate");
    assertEquals(reportOf(fixture({ gate }))["A.gate"], [], `the gate spelling ${JSON.stringify(gate)} wires the same check and must be accepted`);
  }
  const returned = reportOf(fixture({ insideTry: "async function fan(items) {\n  return settleAll(items.map((item) => item()));\n}" }));
  assertEquals(returned["A.awaited"], [], "returning settleAll(...) hands the caller the settled fan-out and must be accepted");
});

interface BuildMutant {
  name: string;
  /** Categories that must report at least one problem. */
  flagged: string[];
  overrides: Partial<Blocks>;
}

const callWithWriter = CLEAN.recordCall;
const buildMutants: BuildMutant[] = [
  // --- rule A: the gate (today's instance removed or broken) ------------------------------------
  { name: "gate: await dropped on THAT call only", flagged: ["A.gate", "A.awaited"], overrides: { gate: replaceOnce(CLEAN.gate, "await settleAll(", "settleAll(") } },
  { name: "gate: replaced by await Promise.allSettled(...)", flagged: ["A.gate", "A.combinators"], overrides: { gate: replaceOnce(CLEAN.gate, "await settleAll(", "await Promise.allSettled(") } },
  { name: "gate: deleted", flagged: ["A.gate"], overrides: { gate: "" } },
  { name: "gate: reads an empty string instead of the bundle", flagged: ["A.gate"], overrides: { gate: replaceOnce(CLEAN.gate, 'await readFile(gatePath, "utf8")', '""') } },
  { name: "gate: reads the bundle but throws the contents away", flagged: ["A.gate"], overrides: { gate: replaceOnce(CLEAN.gate, 'await readFile(gatePath, "utf8")', '(await readFile(gatePath, "utf8")) && ""') } },
  { name: "gate: maps an empty array instead of ALL_BUNDLE_PATHS", flagged: ["A.gate"], overrides: { gate: replaceOnce(CLEAN.gate, "ALL_BUNDLE_PATHS.map(", "[].map(") } },
  { name: "gate: readFile result not awaited (the scan is handed a Promise)", flagged: ["A.gate"], overrides: { gate: replaceOnce(CLEAN.gate, 'await readFile(gatePath, "utf8")', 'readFile(gatePath, "utf8")') } },
  { name: "gate: callback returns early for some bundles", flagged: ["A.gate"], overrides: { gate: replaceOnce(CLEAN.gate, "  assertNoDynamicEvaluators(", '  if (gatePath.endsWith(".js")) return;\n  assertNoDynamicEvaluators(') } },
  { name: "gate: callback skips a bundle behind a branch", flagged: ["A.gate"], overrides: { gate: replaceOnce(CLEAN.gate, '  assertNoDynamicEvaluators(await readFile(gatePath, "utf8"), gatePath);', '  if (gatePath !== "skipped") {\n    assertNoDynamicEvaluators(await readFile(gatePath, "utf8"), gatePath);\n  }') } },
  { name: "gate: moved into a function that is never called", flagged: ["A.gate"], overrides: { gate: `async function neverCalled() {\n${CLEAN.gate}\n}` } },
  { name: "gate: under if (false)", flagged: ["A.gate"], overrides: { gate: `if (false) {\n${CLEAN.gate}\n}` } },
  { name: "gate: inside a finally clause", flagged: ["A.gate"], overrides: { gate: `try {\n  await noop();\n} finally {\n${CLEAN.gate}\n}` } },
  { name: "gate: assertNoDynamicEvaluators is a local no-op", flagged: ["A.gate"], overrides: { gateBinding: "const assertNoDynamicEvaluators = () => {};" } },
  { name: "gate: assertNoDynamicEvaluators imported from somewhere else", flagged: ["A.gate"], overrides: { gateBinding: replaceOnce(CLEAN.gateBinding, "dynamic-evaluator-scan", "something-else") } },
  // --- rule A: settleAll (today's instance weakened, and fresh instances) ----------------------
  { name: "FRESH settleAll without await", flagged: ["A.awaited"], overrides: { insideTry: "settleAll(WRITERS.map((writer) => writer()));" } },
  { name: "FRESH settleAll behind void", flagged: ["A.awaited"], overrides: { insideTry: "void settleAll(WRITERS.map((writer) => writer()));" } },
  { name: "FRESH settleAll captured as a value", flagged: ["A.awaited"], overrides: { insideTry: "const run = settleAll;" } },
  { name: "FRESH settleAll handed to an awaited call as a callback", flagged: ["A.awaited"], overrides: { insideTry: "await invoke(settleAll, WRITERS);" } },
  { name: "settleAll redeclared locally", flagged: ["A.helper"], overrides: { insideTry: "async function settleAll(promises) { return promises; }" } },
  { name: "settleAll shadowed by a parameter", flagged: ["A.helper"], overrides: { insideTry: "const shadow = (settleAll) => settleAll;" } },
  { name: "settleAll imported under an alias", flagged: ["A.helper"], overrides: { imports: replaceOnce(CLEAN.imports, "resolveGcGraceMs, settleAll }", "resolveGcGraceMs, settleAll as sa }") } },
  { name: "settleAll import dropped", flagged: ["A.helper"], overrides: { imports: replaceOnce(CLEAN.imports, "resolveGcGraceMs, settleAll }", "resolveGcGraceMs }") } },
  // --- rule A: combinators and evasions (fresh instances) --------------------------------------
  { name: "FRESH Promise.all", flagged: ["A.combinators"], overrides: { insideTry: "await Promise.all(WRITERS.map((writer) => writer()));" } },
  { name: "FRESH Promise.race", flagged: ["A.combinators"], overrides: { insideTry: "await Promise.race(WRITERS.map((writer) => writer()));" } },
  { name: "FRESH Promise.any", flagged: ["A.combinators"], overrides: { insideTry: "await Promise.any(WRITERS.map((writer) => writer()));" } },
  { name: "FRESH Promise.allSettled", flagged: ["A.combinators"], overrides: { insideTry: "await Promise.allSettled(WRITERS.map((writer) => writer()));" } },
  { name: 'FRESH Promise["all"]', flagged: ["A.combinators"], overrides: { insideTry: 'await Promise["all"](WRITERS.map((writer) => writer()));' } },
  { name: 'FRESH Promise["al" + "l"]', flagged: ["A.combinators"], overrides: { insideTry: 'await Promise["al" + "l"](WRITERS.map((writer) => writer()));' } },
  { name: "FRESH alias const P = Promise", flagged: ["A.combinators"], overrides: { insideTry: "const P = Promise;\nawait P.all(WRITERS.map((writer) => writer()));" } },
  { name: "FRESH destructured const { all } = Promise", flagged: ["A.combinators"], overrides: { insideTry: "const { all } = Promise;\nawait all.call(Promise, WRITERS.map((writer) => writer()));" } },
  { name: 'FRESH globalThis["Promise"].all', flagged: ["A.evasions"], overrides: { insideTry: 'await globalThis["Promise"].all(WRITERS.map((writer) => writer()));' } },
  { name: 'FRESH self["Promise"].all', flagged: ["A.evasions"], overrides: { insideTry: 'await self["Promise"].all(WRITERS.map((writer) => writer()));' } },
  { name: 'FRESH folded ["Pro" + "mise"] access', flagged: ["A.evasions"], overrides: { insideTry: 'await self["Pro" + "mise"].all(WRITERS.map((writer) => writer()));' } },
  { name: "FRESH Array.fromAsync", flagged: ["A.evasions"], overrides: { insideTry: "await Array.fromAsync(WRITERS.map((writer) => writer()));" } },
  { name: 'FRESH Reflect.get(globalThis, "Promise")', flagged: ["A.evasions"], overrides: { insideTry: 'const P = Reflect.get(globalThis, "Promise");' } },
  // --- rule B: the call site (today's instance changed, and fresh instances) ------------------------
  { name: "call moved INTO the publish try", flagged: ["B.tail", "B.call"], overrides: { recordCall: "", insideTry: callWithWriter } },
  { name: "call moved BEFORE the last try/finally", flagged: ["B.tail"], overrides: { recordCall: "", state: `${CLEAN.state}\n${callWithWriter}` } },
  { name: "buildSucceeded replaced by true", flagged: ["B.argument"], overrides: { recordCall: replaceOnce(callWithWriter, "buildSucceeded, exitCode", "buildSucceeded: true, exitCode") } },
  { name: "exitCode replaced by 0", flagged: ["B.argument"], overrides: { recordCall: replaceOnce(callWithWriter, "exitCode: process.exitCode ?? 0", "exitCode: 0") } },
  { name: "exitCode ?? replaced by ||", flagged: ["B.argument"], overrides: { recordCall: replaceOnce(callWithWriter, "process.exitCode ?? 0", "process.exitCode || 0") } },
  { name: "exitCode reads a different member", flagged: ["B.argument"], overrides: { recordCall: replaceOnce(callWithWriter, "process.exitCode ?? 0", "process.exit ?? 0") } },
  { name: "record argument swapped for another identifier", flagged: ["B.argument"], overrides: { recordCall: replaceOnce(callWithWriter, "record: storeBuildRecord", "record: marker") } },
  { name: "FRESH extra property (recordDir)", flagged: ["B.argument"], overrides: { recordCall: replaceOnce(callWithWriter, "process.exitCode ?? 0 }", 'process.exitCode ?? 0, recordDir: "x" }') } },
  { name: "FRESH spread of another object", flagged: ["B.argument"], overrides: { recordCall: replaceOnce(callWithWriter, "{ record:", "{ ...overrides, record:") } },
  { name: "property renamed", flagged: ["B.argument"], overrides: { recordCall: replaceOnce(callWithWriter, "{ record:", "{ rec:") } },
  { name: "computed property key", flagged: ["B.argument"], overrides: { recordCall: replaceOnce(callWithWriter, "{ record:", '{ ["record"]:') } },
  { name: "await dropped", flagged: ["B.call"], overrides: { recordCall: replaceOnce(callWithWriter, "await writeBuildOnceRecord(", "writeBuildOnceRecord(") } },
  { name: "call guarded by an if (not a top-level statement)", flagged: ["B.call"], overrides: { recordCall: `if (ready) {\n  ${callWithWriter}\n}` } },
  { name: "FRESH second call to the writer", flagged: ["B.call"], overrides: { betweenRecordAndChangelog: callWithWriter } },
  { name: "FRESH await somethingFatal() between the call and the changelog block", flagged: ["B.tail"], overrides: { betweenRecordAndChangelog: "await somethingFatal();" } },
  { name: "FRESH await somethingFatal() after the changelog block", flagged: ["B.tail"], overrides: { afterChangelog: "await somethingFatal();" } },
  { name: "import dropped", flagged: ["B.import"], overrides: { imports: replaceOnce(CLEAN.imports, 'import { writeBuildOnceRecord } from "./scripts/lib/build-once-record.mjs";\n', "") } },
  { name: "import from another module", flagged: ["B.import"], overrides: { imports: replaceOnce(CLEAN.imports, "build-once-record", "build-once-record-lite") } },
  { name: "import aliased and called through the alias", flagged: ["B.import", "B.call"], overrides: { imports: replaceOnce(CLEAN.imports, "{ writeBuildOnceRecord }", "{ writeBuildOnceRecord as put }"), recordCall: replaceOnce(callWithWriter, "await writeBuildOnceRecord(", "await put(") } },
  { name: "writer redeclared locally", flagged: ["B.import"], overrides: { insideTry: "async function writeBuildOnceRecord() {}" } },
  { name: "changelog block: try/catch removed", flagged: ["B.tail"], overrides: { changelog: ["if (shouldRecordBuild({ buildSucceeded, exitCode: process.exitCode ?? 0 })) {", "  await writeLastBuiltVersion(version);", "}"].join("\n") } },
  { name: "changelog block: catch rethrows", flagged: ["B.tail"], overrides: { changelog: replaceOnce(CLEAN.changelog, "  } catch (e) {\n", "  } catch (e) {\n    throw e;\n") } },
  { name: "changelog block: catch sets the exit code", flagged: ["B.tail"], overrides: { changelog: replaceOnce(CLEAN.changelog, "  } catch (e) {\n", "  } catch (e) {\n    process.exitCode = 1;\n") } },
  { name: "changelog block: gained a finally", flagged: ["B.tail"], overrides: { changelog: replaceOnce(CLEAN.changelog, "  }\n}", "  } finally {\n    await somethingFatal();\n  }\n}") } },
  { name: "changelog block: no longer gated by shouldRecordBuild", flagged: ["B.tail"], overrides: { changelog: replaceOnce(CLEAN.changelog, "shouldRecordBuild({ buildSucceeded, exitCode: process.exitCode ?? 0 })", "true") } },
  { name: "changelog gate: constant arguments (reviewer N1 mutant b)", flagged: ["B.tail"], overrides: { changelog: replaceOnce(CLEAN.changelog, "shouldRecordBuild({ buildSucceeded, exitCode: process.exitCode ?? 0 })", "shouldRecordBuild({ buildSucceeded: true, exitCode: 0 })") } },
  { name: "changelog gate: exitCode defaulted with ||", flagged: ["B.tail"], overrides: { changelog: replaceOnce(CLEAN.changelog, "exitCode: process.exitCode ?? 0 })) {", "exitCode: process.exitCode || 0 })) {") } },
  { name: "changelog gate: buildSucceeded argument dropped", flagged: ["B.tail"], overrides: { changelog: replaceOnce(CLEAN.changelog, "shouldRecordBuild({ buildSucceeded, exitCode: process.exitCode ?? 0 })", "shouldRecordBuild({ exitCode: process.exitCode ?? 0 })") } },
  { name: "changelog gate: a captured record opens it (reviewer N1 mutant a)", flagged: ["B.tail", "B.singleWriter"], overrides: { changelog: replaceOnce(CLEAN.changelog, "if (shouldRecordBuild(", "if (storeBuildRecord !== null || shouldRecordBuild(") } },
  { name: "changelog block: gained an else branch", flagged: ["B.tail"], overrides: { changelog: `${CLEAN.changelog} else {\n  await somethingFatal();\n}` } },
  { name: "changelog block removed (nothing follows the call)", flagged: ["B.tail"], overrides: { changelog: "" } },
  // --- rule B: a second writer ---------------------------------------------------------------
  { name: "FRESH writer with a plain string directory", flagged: ["B.singleWriter"], overrides: { insideTry: `await writeFile(path.join(root, "${RECORD_DIR_NAME}", "k.json"), "{}");` } },
  { name: "FRESH writer with a template literal directory (no expression)", flagged: ["B.singleWriter"], overrides: { insideTry: `await writeFile(path.join(root, \`${RECORD_DIR_NAME}\`, "k.json"), "{}");` } },
  { name: "FRESH writer with a template literal directory (constant expression)", flagged: ["B.singleWriter"], overrides: { insideTry: 'await writeFile(path.join(root, `serial-${"build"}-once`, "k.json"), "{}");' } },
  { name: "FRESH writer with a concatenated directory", flagged: ["B.singleWriter"], overrides: { insideTry: 'await writeFile(path.join(root, "serial-" + "build-once", "k.json"), "{}");' } },
  { name: "FRESH writer that resolves the durable root itself", flagged: ["B.singleWriter"], overrides: { insideTry: 'const { durableRoot } = await import("./scripts/lib/durable-root.mjs");\nawait mkdir(path.join(durableRoot(), "records"), { recursive: true });' } },
  { name: "FRESH second reader of the captured record", flagged: ["B.singleWriter"], overrides: { insideTry: "await writeFile(path.join(out, `${storeBuildRecord.key}.json`), storeBuildRecord.stdout);" } },
  // --- one fixture per rule clause that nothing above exercised on its own (found by mutating the rule functions) ---
  { name: "FRESH globalThis.Promise.all (dot access)", flagged: ["A.evasions"], overrides: { insideTry: "await globalThis.Promise.all(WRITERS.map((writer) => writer()));" } },
  { name: "FRESH global.Promise.all", flagged: ["A.evasions"], overrides: { insideTry: "await global.Promise.all(WRITERS.map((writer) => writer()));" } },
  { name: "FRESH Reflect.get on a non-global object (Reflect alone)", flagged: ["A.evasions"], overrides: { insideTry: 'const P = Reflect.get(self, "Promise");' } },
  { name: 'FRESH Array["from" + "Async"] (the computed key fromAsync alone)', flagged: ["A.evasions"], overrides: { insideTry: 'await Array["from" + "Async"](WRITERS);' } },
  { name: "FRESH self[`Promise`] (a template literal key)", flagged: ["A.evasions"], overrides: { insideTry: "await self[`Promise`].all(WRITERS.map((writer) => writer()));" } },
  { name: "gate: inside a catch clause", flagged: ["A.gate"], overrides: { gate: `try {\n  await noop();\n} catch (error) {\n${CLEAN.gate}\n}` } },
  { name: "gate: inside a for-of loop", flagged: ["A.gate"], overrides: { gate: `for (const round of []) {\n${CLEAN.gate}\n}` } },
  { name: "gate: inside a while loop", flagged: ["A.gate"], overrides: { gate: `while (false) {\n${CLEAN.gate}\n}` } },
  { name: "gate: inside a switch case", flagged: ["A.gate"], overrides: { gate: `switch (mode) {\n  case "store":\n${CLEAN.gate}\n}` } },
  { name: "gate: maps assertNoDynamicEvaluators itself (it would be handed the PATH, not the bytes)", flagged: ["A.gate"], overrides: { gate: "await settleAll(ALL_BUNDLE_PATHS.map(assertNoDynamicEvaluators));" } },
  { name: "gate: callback ignores its path parameter", flagged: ["A.gate"], overrides: { gate: ["await settleAll(ALL_BUNDLE_PATHS.map(async () => {", '  assertNoDynamicEvaluators(await readFile("one.js", "utf8"), "one.js");', "}));"].join("\n") } },
  { name: "gate: reads a fixed file instead of the callback's path", flagged: ["A.gate"], overrides: { gate: replaceOnce(CLEAN.gate, 'await readFile(gatePath, "utf8")', 'await readFile("one.js", "utf8")') } },
  { name: "assertNoDynamicEvaluators shadowed in a nested block", flagged: ["A.gate"], overrides: { gateBinding: `${CLEAN.gateBinding}\n{\n  const assertNoDynamicEvaluators = () => {};\n}` } },
  { name: "writer captured as a value", flagged: ["B.call"], overrides: { insideTry: "const w = writeBuildOnceRecord;" } },
  { name: "exitCode defaulted to 1 instead of 0", flagged: ["B.argument"], overrides: { recordCall: replaceOnce(callWithWriter, "process.exitCode ?? 0 }", "process.exitCode ?? 1 }") } },
  { name: "changelog block: catch calls process.exit", flagged: ["B.tail"], overrides: { changelog: replaceOnce(CLEAN.changelog, "  } catch (e) {\n", "  } catch (e) {\n    process.exit(2);\n") } },
  { name: "FRESH import of the durable-root module (no binding, no directory name)", flagged: ["B.singleWriter"], overrides: { insideTry: 'await import("./scripts/lib/durable-root.mjs");' } },
  { name: "FRESH durableRoot identifier alone", flagged: ["B.singleWriter"], overrides: { insideTry: "const root = durableRoot();" } },
  { name: "gate: inside a for loop", flagged: ["A.gate"], overrides: { gate: `for (let round = 0; round < 1; round++) {\n${CLEAN.gate}\n}` } },
  { name: "gate: inside a for-in loop", flagged: ["A.gate"], overrides: { gate: `for (const key in {}) {\n${CLEAN.gate}\n}` } },
  { name: "gate: inside a do-while loop", flagged: ["A.gate"], overrides: { gate: `do {\n${CLEAN.gate}\n} while (false);` } },
  { name: "gate: behind an expression-level && (not a statement of its own)", flagged: ["A.gate"], overrides: { gate: replaceOnce(CLEAN.gate, "await settleAll(", "ready && await settleAll(") } },
  { name: "changelog block: a fatal statement after its try/catch", flagged: ["B.tail"], overrides: { changelog: replaceOnce(CLEAN.changelog, "  }\n}", "  }\n  await somethingFatal();\n}") } },
  { name: "FRESH second consumer: the captured record handed to another call as a property", flagged: ["B.singleWriter"], overrides: { insideTry: "await persist({ record: storeBuildRecord });" } },
  { name: 'FRESH destructured computed key (const { ["Promise"]: P } = self)', flagged: ["A.evasions"], overrides: { insideTry: 'const { ["Promise"]: P } = self;\nawait P.all(WRITERS.map((writer) => writer()));' } },
  { name: 'FRESH class method with a computed Promise name (class Fan { static ["Promise"]() {} })', flagged: ["A.evasions"], overrides: { insideTry: 'class Fan {\n  static ["Promise"]() {}\n}' } },
  { name: 'FRESH class field with a computed fromAsync name (class Fan { static ["fromAsync"] = 1 })', flagged: ["A.evasions"], overrides: { insideTry: 'class Fan {\n  static ["fromAsync"] = 1;\n}' } },
  { name: "changelog gate: another function decides (not shouldRecordBuild)", flagged: ["B.tail"], overrides: { changelog: replaceOnce(CLEAN.changelog, "if (shouldRecordBuild(", "if (looksFine(") } },
];

for (const mutant of buildMutants) {
  Deno.test(`build discipline self-proof [${mutant.flagged.join("+")}]: ${mutant.name}`, () => {
    const source = fixture(mutant.overrides);
    assert(source !== fixture(), "the mutant must differ from the clean fixture");
    const report = reportOf(source);
    for (const category of mutant.flagged) {
      assert(report[category].length > 0, `${category} must reject this mutant (it reported nothing)`);
    }
  });
}

// Every way a nested scope can bind the name `settleAll`: the real helper must not be shadowed by any of them.
const SHADOWS: Array<[string, string]> = [
  ["a function declaration", "function settleAll() {}"],
  ["a class declaration", "class settleAll {}"],
  ["a variable", "const settleAll = () => {};"],
  ["an object pattern", "const { settleAll } = helpers;"],
  ["a renamed object pattern", "const { fan: settleAll } = helpers;"],
  ["an object pattern rest", "const { ...settleAll } = helpers;"],
  ["a defaulted object pattern", "const { settleAll = noop } = helpers;"],
  ["an array pattern", "const [settleAll] = helpers;"],
  ["an array pattern rest", "const [...settleAll] = helpers;"],
  ["a parameter", "const f = (settleAll) => settleAll;"],
  ["a rest parameter", "const f = (...settleAll) => settleAll;"],
  ["a defaulted parameter", "const f = (settleAll = noop) => settleAll;"],
  ["a destructured parameter", "const f = ({ settleAll }) => settleAll;"],
  ["a named function expression", "const f = function settleAll() {};"],
  ["a catch parameter", "try { noop(); } catch (settleAll) {}"],
  ["a destructured catch parameter", "try { noop(); } catch ({ settleAll }) {}"],
];
for (const [description, declaration] of SHADOWS) {
  Deno.test(`build discipline self-proof [A.helper]: settleAll shadowed by ${description}`, () => {
    const report = reportOf(fixture({ insideTry: declaration }));
    assert(report["A.helper"].length > 0, `${JSON.stringify(declaration)} shadows the real helper and must be refused`);
  });
}

// --- package-archive.mjs ----------------------------------------------------------------------------

const PACKAGE_ARCHIVE_CLEAN = [
  'import { settleAll } from "./lib/build-concurrency.mjs";',
  "async function copyInventoryToStage(items, stage) {",
  "  await mkdir(stage, { recursive: true });",
  "  await settleAll(items.map(async (item) => {",
  "    await copyFile(item, stage + item);",
  "  }));",
  "}",
  "async function readSizes(files) {",
  "  return Promise.all(files.map((file) => stat(file)));",
  "}",
  "async function packageExtensionArchive(tmp, out) {",
  "  await mkdir(out, { recursive: true });",
  "  await rename(tmp, out);",
  "}",
].join("\n");

const packageArchiveReportOf = (source: string) => packageArchiveReport(parseSource(source));

Deno.test("build discipline self-proof: the package-archive fixture is accepted, including a READ-ONLY Promise.all function", () => {
  const report = packageArchiveReportOf(PACKAGE_ARCHIVE_CLEAN);
  for (const [category, problems] of Object.entries(report)) assertEquals(problems, [], `${category} must accept the clean package-archive fixture`);
});

const packageArchiveMutants: Array<{ name: string; flagged: string[]; source: string }> = [
  {
    name: "FRESH writer function declaration using Promise.all",
    flagged: ["PA.writers"],
    source: `${PACKAGE_ARCHIVE_CLEAN}\nasync function stageExtra(items) { await Promise.all(items.map((item) => writeFile(item, ""))); }`,
  },
  {
    name: "FRESH writer arrow function using Promise.race",
    flagged: ["PA.writers"],
    source: `${PACKAGE_ARCHIVE_CLEAN}\nconst stageMore = async (items) => { await Promise.race([writeFile("a", ""), writeFile("b", "")]); };`,
  },
  {
    name: "FRESH writer method using Promise.allSettled",
    flagged: ["PA.writers"],
    source: `${PACKAGE_ARCHIVE_CLEAN}\nconst stager = { async put(items) { await Promise.allSettled(items.map((item) => rename(item, item + ".x"))); } };`,
  },
  {
    name: "FRESH writer reaching Promise through globalThis",
    flagged: ["PA.writers"],
    source: `${PACKAGE_ARCHIVE_CLEAN}\nasync function stageSneaky(items) { await globalThis["Promise"].all(items.map((item) => copyFile(item, item + ".y"))); }`,
  },
  {
    name: "FRESH writer using a namespace fs call (fs.writeFile) with Promise.any",
    flagged: ["PA.writers"],
    source: `${PACKAGE_ARCHIVE_CLEAN}\nasync function stageNs(items) { await Promise.any(items.map((item) => fs.writeFile(item, ""))); }`,
  },
  {
    name: "copyInventoryToStage fans out with Promise.all instead of settleAll",
    flagged: ["PA.stageWriter", "PA.writers"],
    source: replaceOnce(
      PACKAGE_ARCHIVE_CLEAN,
      "await settleAll(items.map(async (item) => {\n    await copyFile(item, stage + item);\n  }));",
      "await Promise.all(items.map(async (item) => {\n    await copyFile(item, stage + item);\n  }));",
    ),
  },
  {
    name: "packageExtensionArchive (mkdir + rename) gains a Promise.any",
    flagged: ["PA.writers"],
    source: replaceOnce(PACKAGE_ARCHIVE_CLEAN, "  await rename(tmp, out);", "  await Promise.any([rename(tmp, out), rename(tmp, out + '.bak')]);"),
  },
  {
    name: "settleAll import dropped",
    flagged: ["PA.import"],
    source: replaceOnce(PACKAGE_ARCHIVE_CLEAN, 'import { settleAll } from "./lib/build-concurrency.mjs";\n', ""),
  },
  {
    name: "copyInventoryToStage's settleAll lost its await",
    flagged: ["PA.import"],
    source: replaceOnce(PACKAGE_ARCHIVE_CLEAN, "  await settleAll(items.map", "  settleAll(items.map"),
  },
  {
    name: "copyInventoryToStage no longer calls settleAll at all",
    flagged: ["PA.stageWriter"],
    source: replaceOnce(
      PACKAGE_ARCHIVE_CLEAN,
      "  await settleAll(items.map(async (item) => {\n    await copyFile(item, stage + item);\n  }));",
      "  for (const item of items) await copyFile(item, stage + item);",
    ),
  },
  {
    name: "FRESH writer using a computed fs member (fs[\"writeFile\"]) with Promise.all",
    flagged: ["PA.writers"],
    source: `${PACKAGE_ARCHIVE_CLEAN}\nasync function stageComputed(items) { await Promise.all(items.map((item) => fs["writeFile"](item, ""))); }`,
  },
  {
    name: "FRESH read-looking wrapper whose nested arrow writes (chmod)",
    flagged: ["PA.writers"],
    source: `${PACKAGE_ARCHIVE_CLEAN}\nasync function wrap(items) { return Promise.all(items.map(async (item) => { await chmod(item, 0o644); })); }`,
  },
  {
    name: "copyInventoryToStage without any write primitive makes the writer scan vacuous",
    flagged: ["PA.writers"],
    source: replaceOnce(
      replaceOnce(PACKAGE_ARCHIVE_CLEAN, "  await mkdir(stage, { recursive: true });\n", ""),
      "    await copyFile(item, stage + item);",
      "    await check(item);",
    ),
  },
];

for (const mutant of packageArchiveMutants) {
  Deno.test(`build discipline self-proof [${mutant.flagged.join("+")}]: package-archive: ${mutant.name}`, () => {
    assert(mutant.source !== PACKAGE_ARCHIVE_CLEAN, "the mutant must differ from the clean fixture");
    const report = packageArchiveReportOf(mutant.source);
    for (const category of mutant.flagged) {
      assert(report[category].length > 0, `${category} must reject this mutant (it reported nothing)`);
    }
  });
}

// One fixture per write primitive: a function whose ONLY write is that primitive and that fans out with
// Promise.all must be seen as a writer. The expectation is a literal list of its own, NOT the set the scan
// uses: a table derived from that set would shrink with it, and dropping a primitive from the scan would
// then remove the fixture that notices.
const EXPECTED_WRITE_PRIMITIVES = [
  "writeFile", "appendFile", "copyFile", "cp", "mkdir", "rename", "symlink", "link", "chmod", "chown",
  "lchmod", "lchown", "utimes", "lutimes", "truncate", "rm", "rmdir", "unlink", "createWriteStream",
];
for (const primitive of EXPECTED_WRITE_PRIMITIVES) {
  Deno.test(`build discipline self-proof [PA.writers]: package-archive: a Promise.all function whose only write is ${primitive}() is a writer`, () => {
    const source = `${PACKAGE_ARCHIVE_CLEAN}\nasync function stageOnly(items) { await Promise.all(items.map((item) => ${primitive}(item))); }`;
    assert(packageArchiveReportOf(source)["PA.writers"].length > 0, `${primitive} must count as a write primitive`);
  });
}

Deno.test("build discipline self-proof: package-archive: Promise.all in a function that only READS stays allowed", () => {
  for (const reader of ["stat", "lstat", "readFile", "readdir", "realpath", "readlink", "access"]) {
    const source = `${PACKAGE_ARCHIVE_CLEAN}\nasync function readOnly(items) { return Promise.all(items.map((item) => ${reader}(item))); }`;
    assertEquals(packageArchiveReportOf(source)["PA.writers"], [], `${reader} only reads: Promise.all is allowed there`);
  }
});
