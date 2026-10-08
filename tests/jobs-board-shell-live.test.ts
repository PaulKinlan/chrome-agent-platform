import { assert, assertThrows } from "jsr:@std/assert@1";

function assertLiveBoardShell(source: string) {
  const body = source.slice(source.indexOf("function renderJobsBoard() {"), source.indexOf("// LIVE timeline (", source.indexOf("function renderJobsBoard() {")));
  assert(body.includes('jobsBoardEl.addEventListener("jobs-change", syncJobsBoardShell)'),
    "every board paint (including trailing refresh) must update the hub hint");
  assert(body.includes('hint.textContent = jobsBoardEl.summary'),
    "jobs-change handler must reflect the live board summary");
  const reconnect = source.slice(source.indexOf('if (ev.type === "disconnect") {'),
    source.indexOf('if (["tool-call", "tool-result"', source.indexOf('if (ev.type === "disconnect") {')));
  assert(reconnect.indexOf('invalidateRpcCache("board.")') >= 0 &&
    reconnect.indexOf('invalidateRpcCache("board.")') < reconnect.indexOf("renderJobsBoard()"),
    "a lost progress-port event must invalidate the board before reconnect refresh");
  const boardEvent = source.slice(source.indexOf('if (typeof ev.type === "string" && ev.type.startsWith("board-"))'),
    source.indexOf("// A settled job's result", source.indexOf('if (typeof ev.type === "string" && ev.type.startsWith("board-"))')));
  assert(boardEvent.indexOf('handleBroadcastEvent(ev.type)') >= 0 &&
    boardEvent.indexOf('handleBroadcastEvent(ev.type)') < boardEvent.indexOf('renderJobsBoard()'),
    "board progress must invalidate before the ambient subscriber renders (the generic subscriber runs later)");
}

Deno.test("NTP Jobs hint follows every jobs-change paint; reconnect evicts pre-disconnect board cache", async () => {
  const source = await Deno.readTextFile(new URL("../extension/ntp/ntp.js", import.meta.url));
  assertLiveBoardShell(source);
  const staleHint = source.replace('jobsBoardEl.addEventListener("jobs-change", syncJobsBoardShell);', '/* no live hint */');
  assert(staleHint !== source);
  assertThrows(() => assertLiveBoardShell(staleHint), Error, "every board paint");
  const staleReconnect = source.replace('invalidateRpcCache("board.");', '/* missed cache */');
  assert(staleReconnect !== source);
  assertThrows(() => assertLiveBoardShell(staleReconnect), Error, "lost progress-port event");
  const staleEvent = source.replace('      handleBroadcastEvent(ev.type);\n      refreshBoard();',
    '      refreshBoard();');
  assert(staleEvent !== source);
  assertThrows(() => assertLiveBoardShell(staleEvent), Error, "board progress must invalidate before");
});
