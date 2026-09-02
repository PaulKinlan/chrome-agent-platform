// scripts/agent-role-preview.ts — the hub agent list keeps a long role readable.
//
// Owner report (2026-08-25): "The agent list on the ntp page doesn't have a
// truncated role/description, it contains pretty much all of the description
// and it looks terrible." An earlier fix truncated the SIDEBAR list and missed
// the main Named agents panel, so a 334-character role rendered as a five-line
// paragraph and grew the row to 111px.
//
// The row now clamps to two lines while keeping the full role in the DOM (screen
// readers still get all of it) and on hover. This runs on a clean profile.
// Run: npm run test:role-preview
import { launchChrome } from "./lib/chrome-launch.ts";
const EXT = new URL("../extension", import.meta.url).pathname;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail: unknown = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  ok ? pass++ : fail++;
};

const LONG_ROLE =
  "A meticulous research assistant that reads long-form technical documentation, " +
  "extracts the concrete claims, checks each one against primary sources, flags " +
  "anything unsupported, and writes a short briefing with citations. It prefers " +
  "primary sources over summaries, never invents a reference, and always states " +
  "what it could not verify.";

const profile = await Deno.makeTempDir({ prefix: "cap-role-preview-" });
// The shared launcher: kernel-assigned debugging port, the endpoint read from
// this child's own stderr — never a probe of a named port.
const chrome = await launchChrome({ extension: EXT, profile, windowSize: "1440,1600" });
const proc = chrome.proc;
const port = chrome.port;

try {
  let sw = null;
  for (let i = 0; i < 60 && !sw; i++) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    sw = targets.find((t: any) => t.type === "service_worker");
    if (!sw) await sleep(300);
  }
  if (!sw) throw new Error("extension service worker never appeared");
  const extId = sw.url.split("/")[2];

  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?chrome-extension://${extId}/ntp/ntp.html`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const evaluate = (expression: string) =>
    new Promise<any>((resolve) => {
      const mid = ++id;
      const handler = (e: MessageEvent) => {
        const j = JSON.parse(e.data);
        if (j.id === mid) { ws.removeEventListener("message", handler); resolve(j.result?.result?.value); }
      };
      ws.addEventListener("message", handler);
      ws.send(JSON.stringify({ id: mid, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
    });
  await sleep(3000);

  await evaluate(`chrome.runtime.sendMessage({ type: "named-agent.create", name: "Role Clamp", role: ${JSON.stringify(LONG_ROLE)} })`);
  // The hub re-renders on the registry broadcast; no reload needed.
  let present = false;
  for (let i = 0; i < 40 && !present; i++) {
    await sleep(250);
    present = await evaluate(
      `[...document.querySelectorAll('#named-agents capability-row')].some((r) => (r.getAttribute('name') || '').includes('Role Clamp'))`,
    ) === true;
  }
  check("the new named agent appears in the hub list", present === true);

  const row = await evaluate(`(() => {
    const r = [...document.querySelectorAll('#named-agents capability-row')]
      .find((x) => (x.getAttribute('name') || '').includes('Role Clamp'));
    if (!r) return { found: false };
    const desc = r.shadowRoot?.querySelector('.desc');
    if (!desc) return { found: true, desc: false };
    const lh = parseFloat(getComputedStyle(desc).lineHeight) || 16;
    return {
      found: true, desc: true,
      attrLen: (r.getAttribute('description') || '').length,
      domLen: (desc.textContent || '').length,
      titleLen: (desc.getAttribute('title') || '').length,
      lines: Math.round(desc.getBoundingClientRect().height / lh),
      rowHeight: Math.round(r.getBoundingClientRect().height),
      clipped: desc.scrollHeight > desc.clientHeight + 1,
    };
  })()`);

  check("a long role renders at most two lines", row?.found === true && row?.lines <= 2, row);
  check("a long role does not inflate the row past 90px", typeof row?.rowHeight === "number" && row.rowHeight <= 90, { rowHeight: row?.rowHeight });
  check("the clamp is actually clipping the overflow", row?.clipped === true, { clipped: row?.clipped });
  // Clamped, never truncated away: the full role must remain in the DOM so a
  // screen reader still reads it, and be reachable on hover.
  check("the FULL role stays in the DOM", row?.domLen === row?.attrLen && row?.attrLen > 200, { attrLen: row?.attrLen, domLen: row?.domLen });
  check("the full role is available on hover", row?.titleLen === row?.attrLen, { titleLen: row?.titleLen, attrLen: row?.attrLen });

  // The sidebar list keeps its own (already-correct) short preview.
  const sidebar = await evaluate(`(() => {
    const el = [...document.querySelectorAll('.a-role')].find((e) => (e.textContent || '').includes('meticulous'));
    return el ? { shown: el.textContent.length } : null;
  })()`);
  check("the sidebar preview stays short too", sidebar != null && sidebar.shown <= 96, sidebar);
} finally {
  proc.kill();
  await proc.status;
  await Deno.remove(profile, { recursive: true }).catch(() => {});
}

console.log(`\nagent role preview: ${pass}/${pass + fail} passed`);
Deno.exit(fail ? 1 : 0);
