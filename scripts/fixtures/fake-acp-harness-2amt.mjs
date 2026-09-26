// scripts/fixtures/fake-acp-harness-2amt.mjs — a minimal ACP adapter for the browser-tool drive.
//
// chrome-agent-platform-2amt. NOT a harness (no registry entry needed: the registry guard looks at
// scripts/*.ts): this is a fixture the drive points `acp-bridge --adapter` at, so the END-TO-END
// drive can keep the real bridge, the real extension client and real Chrome while substituting only
// the model. What it does is what a model would do:
//   1. on the first prompt, CHECK it was told about the browser tools (the declaration the bridge
//      injects) — a harness that is not told cannot call anything;
//   2. call list_tabs over browser/call_tool;
//   3. choose the two most recent tabs FROM THAT RESULT, not from outside;
//   4. call group_tabs with a title and colour, and record the answer;
//   5. answer the prompt.
//
// chrome-agent-platform-wfo5 EXTENDS the drive past those two tools. Before wfo5 only THREE of 135
// browser tools were callable by a harness, so steps 2-4 above proved the proxy works for the three
// that already worked and said nothing about the other 132. The drive now also calls:
//   open_tab            — a MUTATION previously refused by the allow-list; the tab is then asserted
//                         through Chrome's own tabs.query in the service worker, not from this
//                         fixture's own say-so;
//   read_page           — a READ through chrome.scripting on that tab;
//   capture_screenshot  — a large/binary payload over the same JSON-RPC channel (list_tabs never
//                         exercised one);
//   get_system_memory   — needs NO browser-control grant, so a failure there isolates the PROXY
//                         from the permission machinery;
//   close_tab           — a GATED tool, asserted to come back as a bounded approval refusal rather
//                         than a silent mutation. That is the safety half of wfo5 and it needs
//                         browser evidence too, not only a unit test.
// Every one of those is recorded verbatim so the drive can assert on the REAL reply.
//
// NODE APIs ONLY, deliberately: the bridge spawns adapters with node (an earlier version of this
// fixture used Deno.stdin/stdout and died instantly with "adapter for harness \"pi\" exited").
import { writeFileSync } from "node:fs";

const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
// The drive passes the path through the bridge's environment (the bridge spawns `node <adapter>`,
// so there is no argv slot for it).
const reportPath = process.env.CAP_2AMT_REPORT || process.argv[2] || "./fake-acp-harness-2amt.report.json";
const report = {
  sawDeclaration: false,
  listTabs: null,
  groupTabs: null,
  events: [],
  // wfo5: the newly-permitted calls, each recorded whole.
  wfo5: { declaredCount: 0, openTab: null, readPage: null, screenshot: null, systemMemory: null, closeForeignTab: null },
};
const pending = new Map(); // id -> resolve
let promptId = null;
let sessionId = null;
let buffer = "";

process.stdin.on("data", async (chunk) => {
  buffer += chunk.toString("utf8");
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const resolve = pending.get(msg.id);
      pending.delete(msg.id);
      // RESOLVE WITH THE RESULT, not the envelope: a JSON-RPC response is {jsonrpc, id, result} and
      // reading `.tabs` off the whole message yields undefined for both the payload and the error,
      // so list_tabs looked like a success with no tabs (measured while building this drive).
      resolve(msg.result !== undefined ? msg.result : { error: msg.error ?? "no result in the response" });
      continue;
    }

    if (msg.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { protocolVersion: 1, agentInfo: { name: "fake-harness-2amt", version: "0.0.1" }, agentCapabilities: {} },
      });
    } else if (msg.method === "session/new" || msg.method === "session/load") {
      sessionId = "s-2amt-fake";
      send({ jsonrpc: "2.0", id: msg.id, result: { sessionId } });
    } else if (msg.method === "session/prompt") {
      promptId = msg.id;
      const text = (msg.params?.prompt ?? []).map((b) => (b && b.text) || "").join("\n");
      report.sawDeclaration = /browser\/call_tool/.test(text) && /list_tabs/.test(text) && /group_tabs/.test(text);
      // wfo5: how many tools the harness was actually TOLD about. Before wfo5 this was 3; the
      // drive asserts it is now the whole toolset, because a tool the harness is never told about
      // is not available to it in any useful sense.
      report.wfo5.declaredCount = (text.match(/^- [a-z_]+\(/gm) || []).length;
      const callTool = (name, args) =>
        new Promise((resolve) => {
          const id = "tool-" + name + "-" + Math.random().toString(16).slice(2);
          pending.set(id, resolve);
          send({ jsonrpc: "2.0", id, method: "browser/call_tool", params: { name, args } });
        });

      const listed = await callTool("list_tabs", {});
      report.listTabs = {
        count: listed && listed.count,
        ids: Array.isArray(listed && listed.tabs) ? listed.tabs.map((t) => t.id) : null,
        error: (listed && listed.error) || null,
      };
      const ids = (report.listTabs.ids || []).slice(-2);
      const grouped = await callTool("group_tabs", { tabIds: ids, title: "2amt drive", color: "blue" });
      report.groupTabs = { requested: ids, result: grouped || null };

      // ── wfo5: the newly-permitted tools, in a real browser, over the real proxy ──────────────
      // The property every one of these asserts is the SAME: the reply must not be
      // 'is not permitted for harness execution'. That string was the only answer 132 of these
      // tools could give before this change, so its absence is the thing being proven.
      const OPENED = "https://example.com/?wfo5=opened";
      report.wfo5.openTab = await callTool("open_tab", { url: OPENED });
      const openedTabId = report.wfo5.openTab && report.wfo5.openTab.tabId;

      // WAIT FOR THE NAVIGATION TO COMMIT before reading the page.
      //
      // MEASURED (first run of this drive: 19 passed / 2 failed): open_tab returns as soon as the
      // tab EXISTS, and a brand-new tab has an empty `url` until the navigation commits. read_page
      // and capture_screenshot both derive the origin from that url, so they refused with
      // "cannot read the page: the tab's address could not be read" and "only available on http(s)
      // pages" — the tools behaving correctly on a tab that had no address yet. That was MY drive's
      // bug, not a product defect, and the fix is to wait rather than to weaken the assertion.
      //
      // Polled through list_tabs — the proxy itself — rather than slept: a fixed sleep is a race on
      // a loaded box, and polling additionally proves the tool chain answers repeatedly within one
      // turn. Bounded at ~10s so a genuinely broken navigation still fails the drive instead of
      // hanging it.
      let openedUrl = null;
      for (let attempt = 0; attempt < 40; attempt++) {
        const tabs = await callTool("list_tabs", {});
        const mine = (Array.isArray(tabs && tabs.tabs) ? tabs.tabs : [])
          .find((t) => t && (openedTabId ? t.id === openedTabId : String(t.url ?? "").includes("wfo5=opened")));
        if (mine && String(mine.url ?? "").startsWith("http")) { openedUrl = mine.url; break; }
        await new Promise((r) => setTimeout(r, 250));
      }
      report.wfo5.openedUrlSettled = openedUrl;

      // Read THAT tab (the one this run opened), not an arbitrary one.
      report.wfo5.readPage = await callTool("read_page", openedTabId ? { tabId: openedTabId } : {});
      const shot = await callTool("capture_screenshot", openedTabId ? { tabId: openedTabId } : {});
      // The data URL is megabytes; keep the SHAPE, not the bytes — the drive asserts on width/
      // height/bytes, and carrying the payload through a JSON report file would prove nothing extra.
      report.wfo5.screenshot = shot && typeof shot === "object"
        ? {
          ok: shot.ok === true,
          error: shot.error || null,
          width: shot.width ?? null,
          height: shot.height ?? null,
          bytes: shot.bytes ?? null,
          hasImage: typeof shot.screenshot === "string" && shot.screenshot.startsWith("data:image/"),
        }
        : { error: "no reply" };

      // No grant, no host permission: this one isolates the PROXY from the permission machinery.
      report.wfo5.systemMemory = await callTool("get_system_memory", {});

      // A GATED tool. The tab below was opened by the DRIVE, not by this run's toolset, so it is
      // "foreign" and must take the destructive approval path — which, for a harness principal,
      // is a bounded refusal rather than a mutation.
      const foreign = (report.listTabs.ids || [])[0];
      report.wfo5.closeForeignTab = foreign
        ? { tabId: foreign, result: await callTool("close_tab", { tabId: foreign }) }
        : { tabId: null, result: { error: "no foreign tab to try" } };

      try {
        writeFileSync(reportPath, JSON.stringify(report, null, 2));
      } catch {
        /* the drive will report a missing report */
      }
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "grouped " + ids.length + " tabs" } },
        },
      });
      send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
      promptId = null;
    } else if (msg.method === "session/cancel") {
      if (promptId !== null) {
        send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "cancelled" } });
        promptId = null;
      }
    }
  }
});
