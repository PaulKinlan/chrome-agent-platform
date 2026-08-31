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
  const KNOWN = ["skill", "tabs", "agent", "files", "folder", "artifacts", "bookmarks", "history", "remember"];
  // Paul's exact repro: /skill:x resolves to a reference, then /tabs:y is typed.
  const seq = parseSlashCommand("/skill:screenshot-annotate /tabs:y", "/skill:screenshot-annotate /tabs:y".length, KNOWN);
  assertEquals(seq, {
    start: "/skill:screenshot-annotate ".length,
    end: "/skill:screenshot-annotate /tabs:y".length,
    ns: "tabs",
    arg: "y",
    hasColon: true,
  });
  // Caret inside the SECOND token's arg selects it with the correct start/end.
  const mid = parseSlashCommand("/skill:x /tabs:y", "/skill:x /tabs:".length, KNOWN);
  assertEquals(mid?.ns, "tabs");
  assertEquals(mid?.start, "/skill:x ".length);
  assertEquals(mid?.end, "/skill:x /tabs:".length);
  assertEquals(mid?.arg, "");
  // A bare second command after a space parses too (no colon yet).
  const bare = parseSlashCommand("/skill:x /tabs", "/skill:x /tabs".length, KNOWN);
  assertEquals(bare?.ns, "tabs");
  assertEquals(bare?.hasColon, false);
  // The FIRST command still parses at position 0.
  assertEquals(parseSlashCommand("/skill:screenshot-annotate /tabs:y", "/skill:scre".length, KNOWN)?.ns, "skill");
});

Deno.test("parseSlashCommand: free text / URLs / leading space / unknown ns NEVER parse", () => {
  const KNOWN = ["skill", "tabs", "agent", "files", "folder", "artifacts", "bookmarks", "history", "remember"];
  // A URL containing a slash-command-looking path is ordinary text (mid-word slash).
  assertEquals(parseSlashCommand("see https://example.com/agent:foo", 33, KNOWN), null);
  // A mid-word slash never opens the UI.
  assertEquals(parseSlashCommand("inspect/agent:pr", 16, KNOWN), null);
  // Even a leading-space "/agent" is not command position (nothing precedes it).
  assertEquals(parseSlashCommand(" /agent:x", 9, KNOWN), null);
  // An INVENTED namespace after whitespace stays text.
  assertEquals(parseSlashCommand("do /notacommand:x now", 21, KNOWN), null);
  // The token ends at the first whitespace — the task text after it is plain.
  assertEquals(parseSlashCommand("/agent:reader summarise this", 28, KNOWN), null);
  assertEquals(parseSlashCommand("", 0, KNOWN), null);
  assertEquals(parseSlashCommand("hello", 5, KNOWN), null);
  // Without a known-namespace set, a post-whitespace KNOWN command still parses
  // (the set only REFUSES unknown namespaces — it never rejects position 0).
  assertEquals(parseSlashCommand("/tabs:y", 6, KNOWN)?.ns, "tabs");
  // Position-0 unknown namespaces keep legacy behavior (namespace-list filter).
  assertEquals(parseSlashCommand("/notacommand:x", 14, KNOWN)?.ns, "notacommand");
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
