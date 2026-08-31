// Tests for the STRICT slash-command + @-mention tokenizers
// (extension/shared/command-parser.js) — the round-2 review's free-text
// false-positive fix: a "/" command is ONLY a command in strict command
// position (the very start of the input, a whitespace-free token up to the
// caret); ordinary prose, URLs, and leading-space "/…" text must NEVER parse
// as commands. Mentions stay legal anywhere a fresh token begins.

import {
  parseMentionToken,
  parseSlashCommand,
} from "../extension/shared/command-parser.js";
import { assertEquals } from "jsr:@std/assert@1";

Deno.test("parseSlashCommand: a command in strict position parses", () => {
  assertEquals(parseSlashCommand("/agent:pr", 9), {
    start: 0,
    end: 9,
    ns: "agent",
    arg: "pr",
    hasColon: true,
  });
  assertEquals(parseSlashCommand("/s", 2), {
    start: 0,
    end: 2,
    ns: "s",
    arg: "",
    hasColon: false,
  });
  assertEquals(parseSlashCommand("/agent:", 7)?.hasColon, true);
  assertEquals(parseSlashCommand("/agent:", 7)?.arg, "");
  assertEquals(parseSlashCommand("/", 1), {
    start: 0,
    end: 1,
    ns: "",
    arg: "",
    hasColon: false,
  });
  // The namespace match is case-insensitive; the arg keeps its case.
  assertEquals(parseSlashCommand("/AGENT:Pr", 9)?.ns, "agent");
  assertEquals(parseSlashCommand("/AGENT:Pr", 9)?.arg, "Pr");
  // The canonical ref form (a colon inside the arg) is preserved.
  assertEquals(parseSlashCommand("/agent:named:reader", 19)?.arg, "named:reader");
});

Deno.test("parseSlashCommand: a SECOND command after a resolved reference parses (CAP-FB-20260831-MULTI-SLASH-COMMANDS-01)", () => {
  // The composer records the resolved reference's end; the parser gates on it.
  const SKILL_END = "/skill:screenshot-annotate".length; // 26
  const resolvedEnds = new Set([SKILL_END]);
  // Paul's exact repro: /skill:x resolves to a reference, then /tabs:y is typed.
  const seq = parseSlashCommand("/skill:screenshot-annotate /tabs:y", "/skill:screenshot-annotate /tabs:y".length, resolvedEnds);
  assertEquals(seq, {
    start: SKILL_END + 1,
    end: "/skill:screenshot-annotate /tabs:y".length,
    ns: "tabs",
    arg: "y",
    hasColon: true,
  });
  // Caret inside the SECOND token's arg selects it with the correct start/end.
  const mid = parseSlashCommand("/skill:x /tabs:y", "/skill:x /tabs:".length, new Set(["/skill:x".length]));
  assertEquals(mid?.ns, "tabs");
  assertEquals(mid?.start, "/skill:x ".length);
  assertEquals(mid?.end, "/skill:x /tabs:".length);
  assertEquals(mid?.arg, "");
  // A bare second command after a space parses too (no colon yet).
  const bare = parseSlashCommand("/skill:x /tabs", "/skill:x /tabs".length, new Set(["/skill:x".length]));
  assertEquals(bare?.ns, "tabs");
  assertEquals(bare?.hasColon, false);
  // The FIRST command still parses at position 0 (boundaries are irrelevant there).
  assertEquals(parseSlashCommand("/skill:screenshot-annotate /tabs:y", "/skill:scre".length, resolvedEnds)?.ns, "skill");
});

Deno.test("parseSlashCommand: boundary space matrix — zero or one literal space only (r2 P1)", () => {
  const refEnd = "/skill:x".length; // 8
  const ends = new Set([refEnd]);
  // ZERO spaces: the slash directly abuts the resolved reference → command.
  const zero = parseSlashCommand("/skill:x/tabs:y", "/skill:x/tabs:y".length, ends);
  assertEquals(zero?.ns, "tabs");
  assertEquals(zero?.start, refEnd);
  // ONE space: the canonical "boundary + single space + slash" → command.
  const one = parseSlashCommand("/skill:x /tabs:y", "/skill:x /tabs:y".length, ends);
  assertEquals(one?.ns, "tabs");
  assertEquals(one?.start, refEnd + 1);
  // TWO spaces: must NOT be a command position.
  assertEquals(parseSlashCommand("/skill:x  /tabs:y", "/skill:x  /tabs:y".length, ends), null);
  // A TAB (not a literal space) after the boundary: NOT a command position.
  assertEquals(parseSlashCommand("/skill:x\t/tabs:y", "/skill:x\t/tabs:y".length, ends), null);
  // A NEWLINE after the boundary: NOT a command position.
  assertEquals(parseSlashCommand("/skill:x\n/tabs:y", "/skill:x\n/tabs:y".length, ends), null);
  // Two spaces with the caret mid-token: still not a command.
  assertEquals(parseSlashCommand("/skill:x  /ta", "/skill:x  /ta".length, ends), null);
});

Deno.test("parseSlashCommand: a resolved /agent reference establishes a boundary too (r2 P1)", () => {
  // /agent:named:reader resolves to its canonical ref; a following /skill must
  // open. The reference text is "/agent:named:reader" (19 chars).
  const agentEnd = "/agent:named:reader".length;
  const ends = new Set([agentEnd]);
  const next = parseSlashCommand("/agent:named:reader /skill:x", "/agent:named:reader /skill:x".length, ends);
  assertEquals(next?.ns, "skill");
  assertEquals(next?.start, agentEnd + 1);
  // Zero spaces after the agent reference also works.
  const nextZero = parseSlashCommand("/agent:named:reader/skill:x", "/agent:named:reader/skill:x".length, ends);
  assertEquals(nextZero?.ns, "skill");
  assertEquals(nextZero?.start, agentEnd);
  // Two spaces after the agent reference: NOT a command.
  assertEquals(parseSlashCommand("/agent:named:reader  /skill:x", "/agent:named:reader  /skill:x".length, ends), null);
});

Deno.test("parseSlashCommand: a mid-prose slash NOT after a resolved boundary NEVER parses", () => {
  // The reviewer blocker: ordinary prose mentioning a slash-command name must
  // NOT open the UI — a post-whitespace slash is only a command when the token
  // before the whitespace ends at a RECORDED resolved-reference boundary.
  // No boundaries at all → all of these stay text (the original strict guard).
  assertEquals(parseSlashCommand("please inspect /agent:pr", 24), null);
  assertEquals(parseSlashCommand("see https://example.com/agent:foo", 33), null);
  assertEquals(parseSlashCommand("inspect/agent:pr", 16), null);
  assertEquals(parseSlashCommand(" /agent:x", 9), null);
  assertEquals(parseSlashCommand("do /notacommand:x now", 21), null);
  assertEquals(parseSlashCommand("/agent:reader summarise this", 28), null);
  assertEquals(parseSlashCommand("", 0), null);
  assertEquals(parseSlashCommand("hello", 5), null);
  // A boundary recorded ELSEWHERE does not qualify a mid-prose slash.
  const elsewhere = new Set([5]);
  assertEquals(parseSlashCommand("please inspect /tabs:y", "please inspect /tabs:y".length, elsewhere), null);
  // A boundary at the WRONG position (not where the preceding token ends).
  const wrongEnd = new Set([3]);
  assertEquals(parseSlashCommand("/skill:x /tabs:y", "/skill:x /tabs:y".length, wrongEnd), null);
  // A leading-space token with a boundary present elsewhere still stays text.
  assertEquals(parseSlashCommand(" /tabs:y", " /tabs:y".length, new Set([1])), null);
});

Deno.test("parseSlashCommand: the caret bounds the parse (mid-token edit)", () => {
  const text = "/agent:reader summarise";
  // Caret inside the token → the token up to the caret parses.
  assertEquals(parseSlashCommand(text, 9)?.arg, "re");
  assertEquals(parseSlashCommand(text, 9)?.end, 9);
  // Caret past the space → not a command (the token already ended).
  assertEquals(parseSlashCommand(text, 14), null);
  // A caret beyond the text length is clamped.
  assertEquals(parseSlashCommand("/s", 99)?.ns, "s");
});

Deno.test("parseMentionToken: mentions parse anywhere a fresh token begins", () => {
  assertEquals(parseMentionToken("hello @rea", 10), { start: 6, end: 10, query: "rea" });
  assertEquals(parseMentionToken("@re", 3), { start: 0, end: 3, query: "re" });
  // After a /agent command token + a space, an @ mention still opens — the
  // mixed slash/mention flow (a targeted task can mention agents inline).
  assertEquals(parseMentionToken("/agent:named:reader summarise @pr", 33), {
    start: 30,
    end: 33,
    query: "pr",
  });
  // An @ inside a token (an email) is not a mention.
  assertEquals(parseMentionToken("mail a@b.co", 11), null);
  // No @ at the caret → null.
  assertEquals(parseMentionToken("hello", 5), null);
});
