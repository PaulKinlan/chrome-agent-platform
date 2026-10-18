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
// falsifier below plants the pre-fix shape in a synthetic source and shows the guard reds on it, so the
// check is not "the file happens to contain the right words today".
//
// It is deliberately a RULE over every suite in scripts/ and tests/, not a snapshot of one file, so the
// same defect added to a new suite is caught by existing machinery instead of by the next review.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Blank out comments and string CONTENTS so brace matching counts code, not prose or JSON (7g1fp, 3ce48).
 *
 * A template literal is NOT blanked wholesale. `${ ... }` is executable code - the reviewer's case was a
 * real second `openCdp(...)` spelled inside an interpolation, which the first version of this helper hid,
 * so a connect that could throw and skip its reap was invisible to the census. Interpolations are scanned
 * as code (recursively, so nested templates work), and only the literal text around them is blanked.
 *
 * Output keeps the input length exactly, so every index into it addresses the raw source and the
 * file:line in a failure message points at the line a human must read.
 */
function codeOnly(source: string): string {
  type Mode = { kind: "code"; braceDepth: number } | { kind: "template" };
  const modes: Mode[] = [{ kind: "code", braceDepth: 0 }];
  let out = "";
  let i = 0;
  const template = () => modes[modes.length - 1].kind === "template";
  // Regex-literal disambiguation (ke0n9): `/` starts a REGEX where an expression cannot end, and a regex
  // body may contain `}` and `/` that are not code. Without this, `/${}/.test("}")` inside an
  // interpolation closed the interpolation early and blanked the live code after it.
  let lastSignificant = "";
  const regexFollows = () => lastSignificant === "" || "([{,;:=!&|?+-*%<>~^".includes(lastSignificant);
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (!template() && ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") { out += " "; i++; }
      continue;
    }
    if (!template() && ch === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) { out += " "; i++; }
      if (i < source.length) { out += "  "; i += 2; }
      continue;
    }
    if (!template() && ch === "/" && regexFollows()) {
      // Blank the regex BODY (it is a pattern, not code) but keep the delimiters, so a `}` or a nested
      // `/` inside a character class cannot end an interpolation or start a comment.
      out += "/";
      i++;
      let inClass = false;
      while (i < source.length) {
        const c = source[i];
        if (c === "\\") { out += "  "; i += 2; continue; }
        if (c === "[") { inClass = true; out += "["; i++; continue; }
        if (c === "]") { inClass = false; out += "]"; i++; continue; }
        if (c === "/" && !inClass) { out += "/"; i++; break; }
        if (c === "\n") { out += "\n"; i++; break; }
        out += " ";
        i++;
      }
      while (i < source.length && /[a-z]/i.test(source[i])) { out += source[i]; i++; }
      lastSignificant = "/";
      continue;
    }
    if (template()) {
      if (ch === "\\") { out += source.slice(i, i + 2); i += 2; continue; }
      if (ch === "$" && next === "{") {
        // Real code starts here: opened for the tokeniser, not blanked.
        modes.push({ kind: "code", braceDepth: 0 });
        out += "${";
        i += 2;
        continue;
      }
      if (ch === "`") { modes.pop(); out += "`"; i++; continue; }
      out += ch === "\n" ? "\n" : " ";
      i++;
      continue;
    }
    const top = modes[modes.length - 1] as { kind: "code"; braceDepth: number };
    if (ch === "`") { modes.push({ kind: "template" }); out += "`"; i++; continue; }
    if ((ch === '"' || ch === "'") ) {
      const quote = ch;
      out += quote;
      i++;
      while (i < source.length) {
        if (source[i] === "\\") { out += "  "; i += 2; continue; }
        if (source[i] === quote) { out += quote; i++; break; }
        out += source[i] === "\n" ? "\n" : " ";
        i++;
      }
      continue;
    }
    if (ch === "{") {
      top.braceDepth++;
      out += ch;
      lastSignificant = ch;
      i++;
      continue;
    }
    if (ch === "}") {
      top.braceDepth--;
      lastSignificant = ch;
      if (modes.length > 1 && top.braceDepth < 0) {
        modes.pop();
        out += "}";
        i++;
        continue;
      }
      out += ch;
      i++;
      continue;
    }
    if (ch === "`") { lastSignificant = "`"; }
    if (!/\s/.test(ch)) lastSignificant = ch;
    out += ch;
    i++;
  }
  return out;
}

type Block = { start: number; end: number; hasFinally: boolean; finallyBody: string };

/** The index of the `}` that closes the block opened at `open`, on the comment/string-blanked source. */
function matchBrace(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Every `try` block with its full extent: the try body PLUS its catch clauses and its finally.
 *
 * The suite's shape is `try { ... } catch (e) { ... } finally { reap }`, so looking for `} finally`
 * immediately after the try body finds nothing - the catch sits in between. That miss would have made
 * this guard silently pass over the very shape it was written for, which is why the falsifier below
 * pins both the pre-fix shape AND a try whose finally does not reap.
 */
function tryBlocks(rawSource: string): Block[] {
  // Same length as the original, so every index below still points at the real file.
  const code = codeOnly(rawSource);
  const blocks: Block[] = [];
  const re = /(^|[^\w.$])try\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(code)) !== null) {
    const open = code.indexOf("{", match.index + match[0].length - 1);
    const close = matchBrace(code, open);
    if (close === -1) continue;
    let cursor = close + 1;
    let end = close;
    let hasFinally = false;
    let finallyBody = "";
    for (;;) {
      const rest = code.slice(cursor);
      const clause = /^\s*(catch\s*(?:\([^)]*\))?\s*\{|finally\s*\{)/.exec(rest);
      if (!clause) break;
      const clauseOpen = code.indexOf("{", cursor + clause[0].length - 1);
      const clauseClose = matchBrace(code, clauseOpen);
      if (clauseClose === -1) break;
      if (clause[1].startsWith("finally")) {
        hasFinally = true;
        finallyBody = code.slice(clauseOpen, clauseClose + 1);
      }
      end = clauseClose;
      cursor = clauseClose + 1;
    }
    blocks.push({ start: open, end, hasFinally, finallyBody });
  }
  return blocks;
}

/**
 * EVERY real (non-comment, non-string) `openCdp(` CALL in the source, in order (d36q4, 7g1fp).
 *
 * The first version returned only the first call, so a suite with two launches where the SECOND connect
 * sat outside its reaping try was admitted. Walking every call site fixed that and introduced the mirror
 * error the reviewer then found: detection skipped `//` lines but not `/* ... *​/` blocks, so a connect
 * MENTIONED in a doc comment was judged as a real one and a valid suite was falsely refused.
 *
 * So the scan runs over `codeOnly`, which blanks comments AND string bodies in place (same length), and
 * the indices it returns still address the raw source. A call spelled inside a string or a comment is not
 * a call; the one shape this cannot see is a call inside a template interpolation, which no suite in this
 * repo uses and which would have to be spelled `\`${${CONNECT}(x)}\``.
 */
function cdpCallIndices(source: string): number[] {
  const code = codeOnly(source);
  const re = new RegExp(`\\b${CONNECT}\\s*\\(`, "g");
  const found: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(code)) !== null) found.push(match.index);
  return found;
}

/** True when `cdpCall` sits inside a try whose `finally` reaps the browser. */
function connectInsideReapingTry(source: string, cdpCall: number): boolean {
  return tryBlocks(source).some((block) =>
    cdpCall > block.start && cdpCall < block.end && block.hasFinally &&
    /reapLeaderAndSettle\s*\(/.test(block.finallyBody)
  );
}

// The repo contract (tests/chrome-test-contract.test.ts) forbids a real-Chrome LAUNCH in tests/ except in
// chrome-profile-location.test.ts. The fixtures below DESCRIBE suites - they never run one - so the
// identifiers are assembled at runtime and this file cannot read as a launcher to that guard.
const LAUNCH = "launch" + "Chrome";
const CONNECT = "open" + "Cdp";

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
    if (!new RegExp(`${LAUNCH}\\s*\\(`).test(source) || !/reapLeaderAndSettle\s*\(/.test(source)) continue;
    population++;
    const cdpCalls = cdpCallIndices(source);
    // WHAT THIS RULE DOES NOT COVER, said out loud (o6sqn): a connect made through a local helper
    // (`const { cdp } = await connect(url)` / `new Cdp(ws)` in the journey scripts) is not an
    // `openCdp(...)` CALL, so it is not judged here - those files' reap order is pinned by
    // tests/jjsz-lifeline-runner-exit.test.ts. This guard is about the call shape kafr4 broke, and it
    // walks the tree so a NEW file with that shape is caught instead of having to be listed.
    if (cdpCalls.length === 0) continue;
    judged++;
    for (const cdpCall of cdpCalls) {
      const line = source.slice(0, cdpCall).split("\n").length;
      assert(
        connectInsideReapingTry(source, cdpCall),
        `${relative}:${line}: ${CONNECT}() must be called inside the try whose finally reaps the browser ` +
          `(kafr4) - a connect that throws outside it skips the reap and leaves a real Chrome to the lifeline`,
      );
    }
  }
  // Two floors, answering two questions. `population` is the walk's reach over files that launch AND reap
  // (six today); if it collapses, discovery broke. `judged` is the files whose connect this rule can SEE
  // (one today, scripts/security-suite.ts); if it hits zero the rule applies to nothing and this test
  // would otherwise pass vacuously.
  assert(population >= 4, `the walk found only ${population} launch+reap file(s): discovery has drifted`);
  assert(judged >= 1, `the rule judged no file at all: it has stopped applying to the call shape it guards`);
});

Deno.test("kafr4: security-suite.ts specifically reaps on a connect failure (the case that was broken)", async () => {
  const source = await Deno.readTextFile(`${ROOT}scripts/security-suite.ts`);
  const cdpCalls = cdpCallIndices(source);
  assert(cdpCalls.length > 0, "security-suite.ts opens a CDP connection");
  const cdpCall = cdpCalls[0];
  const reaping = tryBlocks(source).filter((b) => b.hasFinally && /reapLeaderAndSettle\s*\(/.test(b.finallyBody));
  assertEquals(reaping.length, 1, "exactly one try/finally reaps the suite's browser");
  assert(cdpCall > reaping[0].start && cdpCall < reaping[0].end,
    "the connect is inside the reaping try, not before it");
  assert(/connected\?\.close\(\)/.test(reaping[0].finallyBody),
    "the finally tolerates having no connection to close, which is the connect-failed path");
});

Deno.test("kafr4 falsification: the PRE-FIX shape (connect before the try) reds the guard", () => {
  const broken = `
    const chrome = await ${LAUNCH}({});
    const cdp = await ${CONNECT}(chrome.wsUrl);
    try {
      await cdp.eval("x");
    } finally {
      await reapLeaderAndSettle(chrome.proc);
    }
  `;
  const cdpCall = cdpCallIndices(broken)[0] ?? -1;
  assert(cdpCall !== -1, "the falsifier has a call to find");
  assertEquals(connectInsideReapingTry(broken, cdpCall), false,
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
      await reapLeaderAndSettle(chrome.proc);
    }
  `;
  assertEquals(connectInsideReapingTry(fixed, cdpCallIndices(fixed)[0] ?? -1), true,
    "and the fixed shape is admitted, so the guard is not simply refusing everything");
});

Deno.test("ke0n9: a regex literal's } and / do not end the interpolation or start a comment", () => {
  // The reviewer's shape: a valid TypeScript template whose interpolation tests `/[}]/` (or `/${}/`) before
  // a real connect. Read as plain text, the `}` inside the pattern closed the interpolation early and every
  // live call after it was blanked - the census stayed green while a connect sat outside a reaping try.
  const withRegex = `
    const first = await ${LAUNCH}({});
    const guard = \`validate: \${/[}]/.test("}") && await ${CONNECT}(second.wsUrl)} done\`;
    try {
      await cdp.eval(guard);
    } finally {
      await reapLeaderAndSettle(first.proc);
    }
  `;
  const calls = cdpCallIndices(withRegex);
  assertEquals(calls.length, 1, "the connect after the regex literal is still LIVE code and is a call site");
  assertEquals(connectInsideReapingTry(withRegex, calls[0]), false,
    "and it sits before the try whose finally reaps, which is the leak the regex blind spot hid");
  // Division must not be mistaken for a regex: `a / b` leaves the following code intact.
  const division = `const half = total / count;\nconst cdp = await ${CONNECT}(url);\n`;
  assertEquals(cdpCallIndices(division).length, 1,
    "a division sign does not start a regex, so the connect after it is still seen");
});

Deno.test("3ce48: a real connect inside a template interpolation IS a call site", () => {
  // The reviewer's case: `${...}` is executable, so a second connect spelled there can throw and skip its
  // reap. The helper must see it, report it, and the census must refuse the file.
  const interpolated = `
    const first = await ${LAUNCH}({});
    try {
      const cdp = await ${CONNECT}(first.wsUrl);
      const label = \`phase two: \${await ${CONNECT}(second.wsUrl)} connected\`;
      await cdp.eval(label);
    } finally {
      await reapLeaderAndSettle(first.proc);
    }
  `;
  const calls = cdpCallIndices(interpolated);
  assertEquals(calls.length, 2, "the interpolation is code: both connects are call sites");
  assertEquals(connectInsideReapingTry(interpolated, calls[0]), true);
  assertEquals(connectInsideReapingTry(interpolated, calls[1]), true,
    "spelled inside the try body it IS guarded, so it is admitted - the finding was that it was invisible");

  // The leaked-browser shape: the same interpolation BEFORE the try, where a rejection skips the reap.
  const beforeTheTry = `
    const first = await ${LAUNCH}({});
    const label = \`phase two: \${await ${CONNECT}(second.wsUrl)} connected\`;
    try {
      await cdp.eval(label);
    } finally {
      await reapLeaderAndSettle(first.proc);
    }
  `;
  const before = cdpCallIndices(beforeTheTry);
  assertEquals(before.length, 1, "the pre-try interpolation is a call site");
  assertEquals(connectInsideReapingTry(beforeTheTry, before[0]), false,
    "and a connect spelled there skips the reap, which is the leak the helper used to hide");
  // A template with no interpolation is still just text: it must not create phantom call sites.
  const prose = "const note = \`call ${CONNECT}(fake.wsUrl) by hand\`;";
  assertEquals(cdpCallIndices(prose).length, 0, "template TEXT is not code");
});

Deno.test("7g1fp: a connect MENTIONED in a block comment or a string is not a connect", () => {
  const safe = `
    const first = await ${LAUNCH}({});
    try {
      const cdp = await ${CONNECT}(first.wsUrl);
      /**
       * Historical shape, do not use: this used to be
       *   const cdp2 = await ${CONNECT}(second.wsUrl);
       * before the reaping try.
       */
      const note = "call ${CONNECT}(fake.wsUrl) only inside the try";
      await cdp.eval(note);
    } finally {
      await reapLeaderAndSettle(first.proc);
    }
  `;
  const calls = cdpCallIndices(safe);
  assertEquals(calls.length, 1, "only the real call is a call site - not the block comment and not the string");
  assertEquals(connectInsideReapingTry(safe, calls[0]), true,
    "and the file is admitted, which the //-only filter got wrong in the reviewer's reproduction");
});

Deno.test("d36q4 falsification: a SECOND connect outside its reaping try is not hidden by a good first one", () => {
  // The reviewer's shape (d36q4): phase 1 connects inside its reaping try, phase 2 launches again and
  // connects before ITS try. Judging only the first call site admitted this, which is why the census now
  // walks every connect.
  const twoPhase = `
    const first = await ${LAUNCH}({});
    try {
      const cdp = await ${CONNECT}(first.wsUrl);
      await cdp.eval("a");
    } finally {
      await reapLeaderAndSettle(first.proc);
    }
    const second = await ${LAUNCH}({});
    const cdp2 = await ${CONNECT}(second.wsUrl);
    try {
      await cdp2.eval("b");
    } finally {
      await reapLeaderAndSettle(second.proc);
    }
  `;
  const calls = cdpCallIndices(twoPhase);
  assertEquals(calls.length, 2, "the falsifier has two connects to judge");
  assertEquals(connectInsideReapingTry(twoPhase, calls[0]), true,
    "the first connect is inside its reaping try, so it must be admitted");
  assertEquals(connectInsideReapingTry(twoPhase, calls[1]), false,
    "and the second is NOT, which the one-call-per-file census could not see");
});

Deno.test("kafr4 falsification: a try without the reap in its finally does not license the connect", () => {
  // The nearest-looking shape that is still wrong: the connect inside a try whose finally closes the
  // connection but never reaps the process.
  const shape = `
    const chrome = await ${LAUNCH}({});
    try {
      const cdp = await ${CONNECT}(chrome.wsUrl);
      await cdp.eval("x");
    } finally {
      cdp.close();
    }
  `;
  assertEquals(connectInsideReapingTry(shape, cdpCallIndices(shape)[0] ?? -1), false,
    "the reap is what makes the finally sufficient, not the presence of any finally");
});
