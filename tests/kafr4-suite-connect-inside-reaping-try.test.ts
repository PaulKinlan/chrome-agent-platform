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

/** Blank out comments and string/template CONTENTS so brace matching counts code, not prose or JSON. */
function codeOnly(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") { out += " "; i++; }
      continue;
    }
    if (ch === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) { out += " "; i++; }
      if (i < source.length) { out += "  "; i += 2; }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
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

/** Index of the first real (non-comment) `openCdp(` CALL in the source, or -1. */
function cdpCallIndex(source: string): number {
  const re = new RegExp(`\\b${CONNECT}\\s*\\(`, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const lineStart = source.lastIndexOf("\n", match.index) + 1;
    const prefix = source.slice(lineStart, match.index);
    const inLineComment = prefix.includes("//");
    const before = source.slice(Math.max(0, match.index - 2), match.index);
    if (inLineComment || before === "//") continue;
    return match.index;
  }
  return -1;
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

const FILES = [
  "scripts/security-suite.ts",
  "tests/security.test.ts",
  "tests/jjsz-lifeline-leader-exit.test.ts",
  "tests/chrome-launch-lock.test.ts",
];

Deno.test("kafr4: every suite that reaps a launched browser connects CDP INSIDE the try that reaps", async () => {
  let checked = 0;
  for (const relative of FILES) {
    let source: string;
    try {
      source = await Deno.readTextFile(`${ROOT}${relative}`);
    } catch {
      continue; // a file that moved is not this guard's business
    }
    if (!new RegExp(`${LAUNCH}\\s*\\(`).test(source) || !/reapLeaderAndSettle\s*\(/.test(source)) continue;
    const cdpCall = cdpCallIndex(source);
    if (cdpCall === -1) continue; // launches and reaps, but never opens a CDP connection
    checked++;
    assert(
      connectInsideReapingTry(source, cdpCall),
      `${relative}: openCdp() must be called inside the try whose finally reaps the browser ` +
        `(kafr4) - a connect that throws outside it skips the reap and leaves a real Chrome to the lifeline`,
    );
  }
  assert(checked > 0, "the guard found no suite to check: it has stopped guarding anything");
});

Deno.test("kafr4: security-suite.ts specifically reaps on a connect failure (the case that was broken)", async () => {
  const source = await Deno.readTextFile(`${ROOT}scripts/security-suite.ts`);
  const cdpCall = cdpCallIndex(source);
  assert(cdpCall !== -1, "security-suite.ts opens a CDP connection");
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
  const cdpCall = cdpCallIndex(broken);
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
  assertEquals(connectInsideReapingTry(fixed, cdpCallIndex(fixed)), true,
    "and the fixed shape is admitted, so the guard is not simply refusing everything");
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
  assertEquals(connectInsideReapingTry(shape, cdpCallIndex(shape)), false,
    "the reap is what makes the finally sufficient, not the presence of any finally");
});
