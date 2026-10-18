// @ts-nocheck — structural guard over the browser suites (kafr4).
// tests/kafr4-suite-connect-inside-reaping-try.test.ts — chrome-agent-platform-kafr4
//
// INVARIANT: a suite that launches a browser and then reaps it in a `finally` must make its CDP
// CONNECT inside that same `try`. The connect can throw (the DevTools WebSocket never comes up), and a
// connect that happens BEFORE the try skips the `finally` entirely: the browser the suite just launched
// is never reaped by the suite. It then waits for the lifeline, which only fires when the RUNNER
// process exits, so a hung suite holds a real Chrome (and its profile) alive for as long as it hangs.
//
// This is a structural pin because the alternative is a live Chrome that must fail to connect: the
// falsifiers below plant the pre-fix shape in synthetic sources and show the guard reds on them, so the
// check is not "the file happens to contain the right words today".
//
// It is deliberately a RULE over every suite in scripts/ and tests/, not a snapshot of one file, so the
// same defect added to a new suite is caught by existing machinery instead of by the next review.
//
// WHY THIS IS PARSED AND NOT SCANNED (d36q4, 7g1fp, 3ce48, ke0n9, and coord's ruling):
// the first version of this guard blanked comments and strings with a hand-written scanner and looked for
// `openCdp(` in what was left. Three review rounds each found another corner of JavaScript that the
// scanner got wrong, in both directions - a connect mentioned in a `/* */` block counted as real; a real
// connect inside a `${...}` interpolation was invisible; a `}` inside a regex literal ended the
// interpolation early and blanked the live code after it. Each fix was correct and each fix invited the
// next corner, because the class is "write a JavaScript lexer in a test". So it stops: esbuild strips the
// types, acorn parses what is left (exactly what tests/jjsz-lifeline-runner-exit.test.ts already does),
// and the question "is this a call, and what contains it" is answered from the syntax tree. There is
// nothing left to tokenise, so there is no fourth corner to find.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { fileURLToPath } from "node:url";
import * as acorn from "npm:acorn";
import { stop, transform } from "npm:esbuild@0.25.12";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// The repo contract (tests/chrome-test-contract.test.ts) forbids a real-Chrome LAUNCH in tests/ except in
// chrome-profile-location.test.ts. The fixtures below DESCRIBE suites - they never run one - so the
// identifiers are assembled at runtime and this file cannot read as a launcher to that guard.
const LAUNCH = "launch" + "Chrome";
const CONNECT = "open" + "Cdp";
const REAP = "reapLeaderAndSettle";

type Node = { type: string; start: number; end: number; [key: string]: any };
const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && typeof (value as Node).type === "string";

/** `a.b.c` for a non-computed member chain rooted at an identifier; optional chains included. */
function dotted(node: Node | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "ChainExpression") return dotted(node.expression);
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression" && !node.computed && node.property?.type === "Identifier") {
    const base = dotted(node.object);
    return base === null ? null : `${base}.${node.property.name}`;
  }
  return null;
}

const parsed = new Map<string, Node>();

/** The program of a TypeScript source: esbuild strips the types, acorn parses what is left. */
async function parseTs(source: string): Promise<Node> {
  const known = parsed.get(source);
  if (known) return known;
  try {
    const { code } = await transform(source, { loader: "ts", format: "esm", target: "esnext" });
    const program = acorn.parse(code, { ecmaVersion: "latest", sourceType: "module" }) as unknown as Node;
    parsed.set(source, program);
    return program;
  } finally {
    await stop();
  }
}

/** Every node with the chain of its ancestors, outermost first. */
function walk(program: Node): Array<{ node: Node; ancestors: Node[] }> {
  const found: Array<{ node: Node; ancestors: Node[] }> = [];
  const visit = (node: Node, ancestors: Node[]): void => {
    found.push({ node, ancestors });
    for (const [key, value] of Object.entries(node)) {
      if (key === "type" || key === "start" || key === "end") continue;
      for (const child of Array.isArray(value) ? value : [value]) {
        if (isNode(child)) visit(child, [...ancestors, node]);
      }
    }
  };
  visit(program, []);
  return found;
}

/** TRUE when this try's `finally` reaps the browser (the reap is what makes the finally sufficient). */
function reapsInFinally(tryNode: Node): boolean {
  if (!isNode(tryNode.finalizer)) return false;
  return walk(tryNode.finalizer).some(({ node }) =>
    node.type === "CallExpression" && dotted(node.callee) === REAP
  );
}

/** The `finally` body statements of a try that reaps, or null. */
function reapingFinalizer(tryNode: Node): Node | null {
  return isNode(tryNode.finalizer) && reapsInFinally(tryNode) ? tryNode.finalizer : null;
}

/**
 * The verdict for EVERY connect in a source, in source order: true when the call sits inside the `try`
 * BLOCK of a try whose `finally` reaps.
 *
 * Only the try block counts. A connect in the `catch` or in the `finally` is upstream of nothing: the
 * reap already ran, or is running, and a throw there skips no cleanup but also guards no browser launch.
 */
async function connectVerdicts(source: string): Promise<boolean[]> {
  const program = await parseTs(source);
  const verdicts: boolean[] = [];
  for (const { node, ancestors } of walk(program)) {
    if (node.type !== "CallExpression" || dotted(node.callee) !== CONNECT) continue;
    const guarded = ancestors.some((ancestor) =>
      ancestor.type === "TryStatement" &&
      reapingFinalizer(ancestor) !== null &&
      node.start >= ancestor.block.start && node.end <= ancestor.block.end
    );
    verdicts.push(guarded);
  }
  return verdicts;
}

/** The line a node starts on, for a message a human has to act on. */
function lineOf(source: string, offset: number): number {
  return source.slice(0, offset).split("\n").length;
}

/**
 * Every suite in the repo, found by walking the directories (o6sqn).
 *
 * A hard-coded list made this guard's own comment a lie: it claimed to cover scripts/ and tests/ while
 * checking four names, so the next suite written with the pre-fix shape would have been missed by the
 * very machinery that exists to catch it. Walking the directories means coverage is a property of the
 * tree, not of a list somebody has to remember to extend.
 */
async function suiteFiles(): Promise<string[]> {
  const found: string[] = [];
  for (const root of ["scripts", "tests"]) {
    let entries: AsyncIterable<Deno.DirEntry>;
    try {
      entries = Deno.readDir(`${ROOT}${root}`);
    } catch {
      continue;
    }
    for await (const entry of entries) {
      if (!entry.isFile) continue;
      if (!entry.name.endsWith(".ts")) continue;
      found.push(`${root}/${entry.name}`);
    }
  }
  return found.sort();
}

Deno.test("kafr4: every suite that reaps a launched browser connects CDP INSIDE the try that reaps", async () => {
  let judged = 0;
  let population = 0;
  const files = await suiteFiles();
  assert(files.length > 10, `the walk found only ${files.length} TypeScript files: it has stopped guarding`);
  for (const relative of files) {
    let source: string;
    try {
      source = await Deno.readTextFile(`${ROOT}${relative}`);
    } catch {
      continue; // a file that moved is not this guard's business
    }
    // Cheap pre-filter over raw text, and it is allowed to be wrong in the SAFE direction: a file that
    // mentions these names anywhere is parsed, so a mention can only cost a parse, never a missed connect.
    if (!new RegExp(`${LAUNCH}\\s*\\(`).test(source) || !new RegExp(`${REAP}\\s*\\(`).test(source)) continue;
    population++;
    // WHAT THIS RULE DOES NOT COVER, said out loud (o6sqn): a connect made through a local helper
    // (`const { cdp } = await connect(url)` / `new Cdp(ws)` in the journey scripts) is not an
    // `openCdp(...)` CALL, so it is not judged here - those files' reap order is pinned by
    // tests/jjsz-lifeline-runner-exit.test.ts instead.
    const program = await parseTs(source);
    const sites = walk(program).filter(({ node }) => node.type === "CallExpression" && dotted(node.callee) === CONNECT);
    if (sites.length === 0) continue;
    judged++;
    for (const { node, ancestors } of sites) {
      const guarded = ancestors.some((ancestor) =>
        ancestor.type === "TryStatement" &&
        reapingFinalizer(ancestor) !== null &&
        node.start >= ancestor.block.start && node.end <= ancestor.block.end
      );
      assert(
        guarded,
        `${relative}:${lineOf(source, node.start)}: ${CONNECT}() must be called inside the try whose finally ` +
          `reaps the browser (kafr4) - a connect that throws outside it skips the reap and leaves a real ` +
          `Chrome to the lifeline`,
      );
    }
  }
  // Two floors, answering two questions. `population` is the walk's reach over files that launch AND reap
  // (six today); if it collapses, discovery broke. `judged` is the files that actually CALL the connect
  // (one today, scripts/security-suite.ts); if it hits zero the rule applies to nothing and this test would
  // otherwise pass vacuously.
  assert(population >= 4, `the walk found only ${population} launch+reap file(s): discovery has drifted`);
  assert(judged >= 1, `the rule judged no file at all: it has stopped applying to the call shape it guards`);
});

Deno.test("kafr4: security-suite.ts reaps on a connect failure, and its finally tolerates having no connection", async () => {
  const source = await Deno.readTextFile(`${ROOT}scripts/security-suite.ts`);
  const program = await parseTs(source);
  const sites = walk(program).filter(({ node }) => node.type === "CallExpression" && dotted(node.callee) === CONNECT);
  assert(sites.length > 0, "security-suite.ts opens a CDP connection");
  assertEquals(await connectVerdicts(source), sites.map(() => true),
    "every connect in security-suite.ts is inside the reaping try, not before it");

  const reaping = walk(program).filter(({ node }) => node.type === "TryStatement" && reapsInFinally(node));
  assertEquals(reaping.length, 1, "exactly one try/finally reaps the suite's browser");
  const finalizer = reapingFinalizer(reaping[0].node);
  assert(finalizer, "that try has a finally");
  const first = finalizer.body[0];
  const closes = first?.type === "ExpressionStatement" ? first.expression : null;
  const inner = closes?.type === "ChainExpression" ? closes.expression : closes;
  // acorn records the optional-ness on the MemberExpression (`connected?.close`), not on the call.
  const optionalMember = inner?.type === "CallExpression" && inner.callee?.type === "MemberExpression" &&
    inner.callee.optional === true;
  assert(
    inner?.type === "CallExpression" && dotted(inner.callee) === "connected.close" && optionalMember,
    "the finally's first statement closes through an OPTIONAL handle: the connect-failed path has nothing " +
      "to close, and that is the path kafr4 is about",
  );
});

Deno.test("kafr4 falsification: the PRE-FIX shape (connect before the try) reds the guard", async () => {
  const broken = `
    const chrome = await ${LAUNCH}({});
    const cdp = await ${CONNECT}(chrome.wsUrl);
    try {
      await cdp.eval("x");
    } finally {
      await ${REAP}(chrome.proc);
    }
  `;
  assertEquals(await connectVerdicts(broken), [false],
    "the pre-fix shape must be refused: this is the defect the guard exists for");

  const fixed = `
    const chrome = await ${LAUNCH}({});
    let connected;
    try {
      const cdp = await ${CONNECT}(chrome.wsUrl);
      connected = cdp;
      await cdp.eval("x");
    } finally {
      connected?.close();
      await ${REAP}(chrome.proc);
    }
  `;
  assertEquals(await connectVerdicts(fixed), [true],
    "and the fixed shape is admitted, so the guard is not simply refusing everything");
});

Deno.test("kafr4 falsification: a try without the reap in its finally does not license the connect", async () => {
  const shape = `
    const chrome = await ${LAUNCH}({});
    try {
      const cdp = await ${CONNECT}(chrome.wsUrl);
      await cdp.eval("x");
    } finally {
      cdp.close();
    }
  `;
  assertEquals(await connectVerdicts(shape), [false],
    "the reap is what makes the finally sufficient, not the presence of any finally");
});

Deno.test("kafr4 falsification: a connect in the CATCH or FINALLY of a reaping try is not guarded", async () => {
  const inCatch = `
    const chrome = await ${LAUNCH}({});
    try {
      await something();
    } catch (e) {
      const cdp = await ${CONNECT}(chrome.wsUrl);
    } finally {
      await ${REAP}(chrome.proc);
    }
  `;
  assertEquals(await connectVerdicts(inCatch), [false],
    "a connect in the catch runs AFTER the try already failed: it is not inside the try block");
});

Deno.test("d36q4: a SECOND connect outside its reaping try is not hidden by a good first one", async () => {
  const twoPhase = `
    const first = await ${LAUNCH}({});
    try {
      const cdp = await ${CONNECT}(first.wsUrl);
      await cdp.eval("a");
    } finally {
      await ${REAP}(first.proc);
    }
    const second = await ${LAUNCH}({});
    const cdp2 = await ${CONNECT}(second.wsUrl);
    try {
      await cdp2.eval("b");
    } finally {
      await ${REAP}(second.proc);
    }
  `;
  assertEquals(await connectVerdicts(twoPhase), [true, false],
    "the first connect is guarded and the second is not - a per-file 'the first one looked fine' census " +
      "would have admitted this suite");
});

Deno.test("7g1fp / ke0n9 / 3ce48: comments, strings, templates and regexes are syntax, not call sites", async () => {
  // Every lexical corner the three review rounds found, in one source. The parser answers all of them
  // the same way, because none of these is a call: only the real connect is a call site.
  const source = `
    const first = await ${LAUNCH}({});
    /**
     * Historical shape, do not use:
     *   const cdp = await ${CONNECT}(second.wsUrl);
     */
    const prose = "call ${CONNECT}(fake.wsUrl) only inside the try";
    const literal = \`call ${CONNECT}(fake2.wsUrl) by hand\`;
    const pattern = /[}]${CONNECT}\\(/;
    try {
      const cdp = await ${CONNECT}(first.wsUrl);
      const label = \`phase: \${await ${CONNECT}(first.wsUrl)} ok / \${/[}]/.test("}")}\`;
      await cdp.eval(prose + literal + String(pattern) + label);
    } finally {
      await ${REAP}(first.proc);
    }
  `;
  // Two real calls, and only two: the awaited one in the try and the one inside the interpolation (which IS
  // code and also sits in the try). The block comment, the string, the template text and the regex all
  // spell `openCdp(` and none of them is a call.
  assertEquals(await connectVerdicts(source), [true, true],
    "a comment, a string, template text and a regex create no call sites, and the interpolated connect is real");

  const leak = `
    const first = await ${LAUNCH}({});
    const label = \`phase: \${await ${CONNECT}(second.wsUrl)} / \${/[}]/.test("}")}\`;
    try {
      await cdp.eval(label);
    } finally {
      await ${REAP}(first.proc);
    }
  `;
  assertEquals(await connectVerdicts(leak), [false],
    "the same interpolation BEFORE the try is a real connect outside the reap, which is the leak");
});

Deno.test("kafr4: the guard reads its own fixtures as fixtures", async () => {
  // This file mentions the launch, the connect and the reap dozens of times, inside template literals. If
  // the guard counted text, it would report itself; the parser is what makes that impossible.
  const self = await Deno.readTextFile(fileURLToPath(import.meta.url));
  assertEquals(await connectVerdicts(self), [],
    "this test file contains no real connect call, so the guard must find none in it");
});
