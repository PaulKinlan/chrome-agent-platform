// tests/build-parallel-discipline.test.ts — bead chrome-agent-platform-jjsz.
//
// Three RULES the parallel build pipeline must keep. build.mjs is a script (importing it runs a
// build), so these are AST rules, not substring pins: comments, strings and import specifiers cannot
// satisfy them. Each rule was proven by a mutant that removes the live construct AND by a mutant that
// adds a FRESH instance of the rule (a pin on today's instance is not a pin on the rule) — see the
// jjsz landing evidence bundle.
//
//  A. No early-rejecting combinator in build.mjs. `Promise.all/race/any` reject (or resolve) while
//     siblings are still running; build.mjs fans out writers into its staging directory and its
//     failure path then removes that directory. Every fan-out goes through settleAll
//     (scripts/lib/build-concurrency.mjs, behaviour proven in tests/build-concurrency.test.ts).
//     package-archive.mjs's stage writer `copyInventoryToStage` follows the same rule.
//  B. The serial-build-once record ("this build exited 0") is written only AFTER every try/finally in
//     build.mjs — i.e. after the staging cleanup and the lock release — and only through the strict
//     shouldRecordBuild gate. Written earlier it outlives a late failure and lets build-smoke pass on
//     a build that exited non-zero.
//  C. The version-GC grace comes from the tested resolver, not an inline constant.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { parse } from "npm:acorn";

// deno-lint-ignore no-explicit-any
type Node = any;

function parseModule(relativeToRepo: string): { program: Node; source: string } {
  const source = Deno.readTextFileSync(new URL(`../${relativeToRepo}`, import.meta.url));
  const program = parse(source, { ecmaVersion: "latest", sourceType: "module", locations: true });
  return { program, source };
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

const where = (node: Node) => `line ${node.loc.start.line}`;

const isIdent = (node: Node, name: string) => node?.type === "Identifier" && node.name === name;

/** The property name of `Promise.<name>` / `Promise["<name>"]`, else null. */
function promiseMember(node: Node): string | null {
  if (node?.type !== "MemberExpression" || !isIdent(node.object, "Promise")) return null;
  if (!node.computed && node.property.type === "Identifier") return node.property.name;
  if (node.computed && node.property.type === "Literal") return String(node.property.value);
  return "<computed>";
}

/** Violations of rule A inside `scope`: any use of the global Promise other than `new Promise(...)`
 *  and the settled/constructor-style statics, including aliasing it (`const P = Promise`). */
function earlyRejectingUses(scope: Node): string[] {
  const allowedStatics = new Set(["allSettled", "resolve", "reject", "withResolvers"]);
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

Deno.test("build discipline A: build.mjs has no Promise.all/race/any — every fan-out settles before a failure can reach the staging rollback", () => {
  const { program } = parseModule("build.mjs");
  assertEquals(earlyRejectingUses(program), [], "build.mjs must fan out through settleAll");

  // settleAll is the REAL helper: imported from the tested module, not shadowed by a local binding.
  const imports = program.body.filter((n: Node) => n.type === "ImportDeclaration");
  const fromHelper = imports.find((n: Node) => n.source.value === "./scripts/lib/build-concurrency.mjs");
  assert(fromHelper, "build.mjs must import ./scripts/lib/build-concurrency.mjs");
  const importedNames = fromHelper.specifiers.map((s: Node) => s.imported.name);
  assert(importedNames.includes("settleAll"), "build.mjs must import settleAll from the tested module");
  const localSettleAllDeclarations = [...walk(program)].filter((n) =>
    (n.type === "FunctionDeclaration" || n.type === "VariableDeclarator") && isIdent(n.id, "settleAll")
  );
  assertEquals(localSettleAllDeclarations.length, 0, "settleAll must not be redefined locally in build.mjs");
  const calls = [...walk(program)].filter((n) => n.type === "CallExpression" && isIdent(n.callee, "settleAll"));
  assert(calls.length >= 1, "build.mjs must actually call settleAll (an import is not a call site)");
});

Deno.test("build discipline A: package-archive.mjs's stage writer (copyInventoryToStage) settles too", () => {
  const { program } = parseModule("scripts/package-archive.mjs");
  const writer = program.body.find((n: Node) => n.type === "FunctionDeclaration" && n.id?.name === "copyInventoryToStage");
  assert(writer, "copyInventoryToStage must exist (it writes into the private staging directory the finally removes)");
  assertEquals(earlyRejectingUses(writer), [], "copyInventoryToStage must not use Promise.all/race/any");
  const calls = [...walk(writer)].filter((n) => n.type === "CallExpression" && isIdent(n.callee, "settleAll"));
  assert(calls.length >= 1, "copyInventoryToStage must call settleAll");
  const imported = program.body.some((n: Node) =>
    n.type === "ImportDeclaration" && n.source.value === "./lib/build-concurrency.mjs" &&
    n.specifiers.some((s: Node) => s.imported?.name === "settleAll")
  );
  assert(imported, "package-archive.mjs must import settleAll from ./lib/build-concurrency.mjs");
});

Deno.test("build discipline B: the serial-build-once record is written only after every try/finally, through shouldRecordBuild", () => {
  const { program } = parseModule("build.mjs");
  const body: Node[] = program.body;

  const literalSites = [...walk(program)].filter((n) => n.type === "Literal" && n.value === "serial-build-once");
  assertEquals(literalSites.length, 1, "exactly one writer of the serial-build-once record (a second one could skip the gate)");

  const owner = body.findIndex((statement) => [...walk(statement)].some((n) => n === literalSites[0]));
  assert(owner >= 0, "the record write must be a top-level statement of build.mjs");
  const statement = body[owner];
  assertEquals(statement.type, "IfStatement", `the record write must be guarded by an if (found a ${statement.type} at ${where(statement)})`);
  const gated = [...walk(statement.test)].some((n) => n.type === "CallExpression" && isIdent(n.callee, "shouldRecordBuild"));
  assert(gated, `the record write at ${where(statement)} must be gated by shouldRecordBuild(...)`);

  const lastTry = body.reduce((last, s, i) => (s.type === "TryStatement" ? i : last), -1);
  assert(lastTry >= 0, "build.mjs must still have its try/finally finalizers");
  assert(
    owner > lastTry,
    `the record write (${where(statement)}) must come AFTER the last top-level try/finally (${where(body[lastTry])}): ` +
      `the staging cleanup and the lock release are its last fatal steps`,
  );
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
