// sidepanel-ux.test.ts — tests for bead chrome-agent-platform-d885.7
// [CAP-FB-20260928-SIDEPANEL-UX-01] Preserve tool cards/artifacts/approvals on Side Panel tab switches,
// add 1-click site tool enrollment, and fix narrow-width overflow.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { projectThreadWithRunLogs, projectThreadMessages } from "../extension/shared/conversation.js";

const read = (p: string) => Deno.readTextFile(new URL(p, new URL("../", import.meta.url)));
const html = await read("./extension/sidepanel/sidepanel.html");
const js = await read("./extension/sidepanel/sidepanel.js");

Deno.test("sidepanel UX: loadTabThread projects durable run logs so tool cards are preserved on tab switch", () => {
  // Source wiring
  assert(js.includes("projectThreadWithRunLogs"), "sidepanel.js must import and call projectThreadWithRunLogs");
  assert(js.includes('send("run.thread-logs"'), "sidepanel.js must query run.thread-logs for durable execution logs");
  assert(js.includes('send("thread.get"'), "sidepanel.js must query thread.get");
  assert(js.includes("Promise.all"), "loadTabThread must query thread.get and run.thread-logs in parallel");

  // Behavioral test: projectThreadWithRunLogs vs projectThreadMessages
  // When a thread has an assistant turn and its tool calls are in durable run logs (not yet in body),
  // projectThreadMessages would omit them, while projectThreadWithRunLogs projects the tool cards.
  const thread = {
    id: "thread-123",
    messages: [
      { role: "user", content: "Check this site" },
      { role: "assistant", content: "Site looks great!", executionId: "exec-1" },
    ],
  };

  const executions = [
    {
      executionId: "exec-1",
      phase: "terminal",
      terminal: { ok: true, summary: "Completed" },
      logs: [
        {
          type: "tool-call",
          tool: "read_page",
          args: { url: "https://example.com" },
          callId: "call-1",
        },
        {
          type: "tool-result",
          tool: "read_page",
          callId: "call-1",
          result: { title: "Example Domain" },
          ok: true,
        },
      ],
    },
  ];

  // Without run logs, projectThreadMessages returns only the user and assistant turns
  const basicMessages = projectThreadMessages(thread);
  assertEquals(basicMessages.length, 2);
  assertEquals(basicMessages.some((m: any) => m.role === "tool"), false);

  // With run logs, projectThreadWithRunLogs injects the tool card before the assistant message
  const projected = projectThreadWithRunLogs(thread, executions);
  assert(projected.messages.length >= 3, "projected messages must include tool card");
  const toolMsg = projected.messages.find((m: any) => m.role === "tool");
  assert(toolMsg != null, "tool message must be present in projected messages");
  assertEquals(toolMsg.toolName, "read_page");
});

Deno.test("sidepanel UX: PAGE_THREADS_KEY is persisted across session and hydrated from chrome.storage.session", () => {
  assert(js.includes('const PAGE_THREADS_KEY = "cap:sidepanel:page-threads"'), "PAGE_THREADS_KEY constant must match");
  assert(js.includes("function readPageThreads"), "readPageThreads must be defined");
  assert(js.includes("function writePageThreads"), "writePageThreads must be defined");
  assert(js.includes("chrome.storage?.session?.get"), "hydratePageThreads must query chrome.storage.session");
  assert(js.includes("chrome.storage?.session?.set"), "writePageThreads must mirror to chrome.storage.session");
});

Deno.test("sidepanel UX: history events open-tab, reuse, and approval-decision are wired on conversations", () => {
  assert(js.includes('addEventListener("open-tab"'), "open-tab listener must be wired");
  assert(js.includes('addEventListener("reuse"'), "reuse listener must be wired");
  assert(js.includes('addEventListener("approval-decision"'), "approval-decision listener must be wired");
  assert(js.includes("wireReplayApprovals(history)"), "wireConversationHistory must wire replay approvals");
  assert(js.includes("wireConversationHistory(pageHistory"), "pageHistory must wire history events");
  assert(js.includes("wireConversationHistory(historyEl"), "historyEl must wire history events");
});

Deno.test("sidepanel UX: unenrolled origins offer 1-click site tool enrollment", () => {
  assert(js.includes("enable-site-tools-btn"), "enable-site-tools-btn class must be created");
  assert(js.includes("Enable site tools"), "Enable site tools button text must be present");
  assert(js.includes('permissions: ["scripting"]'), "1-click enrollment must request scripting permission");
  assert(js.includes('send("agent.enroll-origin"'), "1-click enrollment must call agent.enroll-origin");
  assert(js.includes("chrome.tabs?.reload"), "1-click enrollment reloads the active tab");
  assert(html.includes(".enable-site-tools-btn"), "sidepanel.html must style enable-site-tools-btn");
});

Deno.test("sidepanel UX: tool chips render as interactive buttons with titles and prefill composer on click", () => {
  assert(js.includes('document.createElement("button")'), "tool-chip must be created as button element");
  assert(js.includes('chip.className = "tool-chip"'), "tool chip must have tool-chip class");
  assert(js.includes("t.description ?"), "tool chip title must incorporate description when present");
  assert(js.includes("pageComposer.value"), "tool chip click must update pageComposer value");
  assert(js.includes("pageComposer.focus"), "tool chip click must focus pageComposer");
  assert(html.includes(".tool-chip:hover"), "tool-chip must have hover styling");
});

Deno.test("sidepanel UX: 360px layout, dark-mode tokens, and typography polish", () => {
  // No legacy dark-mode ink bug: var(--ok, #1c7c33) replaced by var(--success)
  assert(!html.includes("var(--ok,#1c7c33)"), "var(--ok,#1c7c33) must be removed");
  assert(!html.includes("var(--ok, #1c7c33)"), "var(--ok, #1c7c33) must be removed");
  assert(html.includes("color:var(--success)"), "granted permissions status must use var(--success)");

  // .agent-bar-title styles
  assert(html.includes(".agent-bar-title"), "sidepanel.html must define .agent-bar-title");
  assert(html.includes("min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis;"), "agent-bar-title must clip overflow");

  // Fractional font sizes normalized
  assert(!html.includes("11.5px"), "11.5px must be normalized to 12px");
  assert(!html.includes("12.5px"), "12.5px must be normalized to 13px");

  // .agent-section-h typography
  assert(html.includes(".agent-section-h"), "sidepanel.html must declare .agent-section-h");
  assert(!html.includes("text-transform:uppercase; letter-spacing:.04em;"), "uppercase letter-spaced permissions heading must be normalized");
  assert(!html.includes("text-transform: uppercase; letter-spacing: 0.05em;"), "uppercase letter-spaced heading must be normalized");
});
