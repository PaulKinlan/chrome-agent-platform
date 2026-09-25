// tests/agent-share-import.test.ts
// chrome-agent-platform-pu7n [CAP-FB-20260830-AGENT-SHARING-01]
//
// The done definition, driven in a REAL loaded extension on one profile:
//   Share — the agent view header's Share button downloads <slug>.agent.json
//   built by the card library (name/role/skills/schedule/avatar; never memory,
//   keys, provider config, or context-file bodies).
//   Import — the create dialog's Import agent accepts that file, shows the
//   validated name/role/skills for confirmation, and Create commits a record
//   whose card fields EQUAL the exported card's.
// @ts-nocheck

import { fileURLToPath } from "node:url";
import { assert, assertEquals } from "jsr:@std/assert@1";
import { launchChrome, waitForServiceWorker } from "../scripts/lib/chrome-launch.ts";
import { chromeProfileDir } from "../scripts/lib/chrome-profile-dir.ts";
import { resolveChromeForTesting } from "../scripts/lib/chrome-for-testing.ts";
import { durableDir } from "../scripts/lib/durable-root.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const EXT = `${ROOT}/extension`;
const CHROME_FOR_TESTING = resolveChromeForTesting();

Deno.test({
  name: "pu7n: share downloads a card and importing it recreates the agent (export → import equivalence)",
  ignore: CHROME_FOR_TESTING === null,
  fn: async () => {
    const profile = chromeProfileDir("agent-share-import");
    // Download evidence lands on DURABLE storage (durable-root guard: a tmpfs
    // dir is not evidence), unique per process so concurrent lanes never share
    // a root (the p15i convention).
    const downloads = durableDir("pu7n-downloads", `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await Deno.mkdir(downloads, { recursive: true });
    const launched = await launchChrome({
      binary: CHROME_FOR_TESTING,
      args: [
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--silent-debugger-extension-api",
        `--disable-extensions-except=${EXT}`,
        `--load-extension=${EXT}`,
        "--remote-allow-origins=*",
        `--user-data-dir=${profile}`,
        "about:blank",
      ],
    });

    const ws = new WebSocket(launched.wsUrl);
    await new Promise((r) => (ws.onopen = r));
    let id = 0;
    const pending = new Map();
    const send = (method: string, params: any = {}, sessionId?: string) =>
      new Promise<any>((res) => {
        const mid = ++id;
        pending.set(String(mid), res);
        ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
      });
    ws.onmessage = (m: MessageEvent) => {
      const j = JSON.parse(m.data);
      if (j.id && pending.has(String(j.id))) {
        pending.get(String(j.id))(j);
        pending.delete(String(j.id));
      }
    };

    try {
      const sw = await waitForServiceWorker(send, {
        timeoutMs: 10000,
        match: (t: any) => t.type === "service_worker" && String(t.url).includes("dist/background"),
      });
      assert(sw, "Service worker must be running");
      const extId = new URL(sw.url).host;

      // Route downloads to a durable temp dir so the Share click can be read.
      await send("Browser.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: downloads,
      });

      const { result: { targetId } } = await send("Target.createTarget", { url: `chrome-extension://${extId}/ntp/ntp.html` });
      const { result: { sessionId } } = await send("Target.attachToTarget", { targetId, flatten: true });
      await send("Runtime.enable", {}, sessionId);
      await send("Page.enable", {}, sessionId);

      const ev = async (expr: string) => {
        const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
        if (r.result?.exceptionDetails) {
          throw new Error(`evaluate threw: ${String(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text)}`);
        }
        return r.result?.result?.value;
      };
      await new Promise((r) => setTimeout(r, 1500));

      // 1. Seed the agent that will be shared.
      const made = await ev(`new Promise((resolve) => chrome.runtime.sendMessage({
        type: "named-agent.create",
        name: "Share Pilot",
        role: "Round-trip tester"
      }, resolve))`);
      assertEquals(made?.ok, true, "Named agent creation must succeed");
      const sourceId = made.agent?.id ?? null;
      assert(typeof sourceId === "string" && sourceId, "the created agent has an id");

      // 2. Open its surface via the real hub row; the Share button must unhide.
      await send("Page.navigate", { url: `chrome-extension://${extId}/ntp/ntp.html` }, sessionId);
      await new Promise((r) => setTimeout(r, 1500));
      const opened = await ev(`(() => {
        const picker = document.querySelector("#named-agents agent-picker");
        const rows = [...(picker?.shadowRoot?.querySelectorAll(".opt") ?? [])];
        const row = rows.find((r) => (r.querySelector(".name")?.textContent || "") === "Share Pilot");
        if (!row) return false;
        row.click();
        return true;
      })()`);
      assertEquals(opened, true, "Agent row must be found and opened");
      await new Promise((r) => setTimeout(r, 1200));
      assertEquals(await ev(`document.getElementById("share-agent")?.hidden`), false, "the Share button is offered on a named agent's view header");

      // 3. Share via a real click; the card downloads to the temp dir.
      await ev(`document.getElementById("share-agent").click()`);
      let cardFile = null;
      for (let t = 0; t < 40 && !cardFile; t++) {
        await new Promise((r) => setTimeout(r, 250));
        for await (const ent of Deno.readDir(downloads)) {
          if (ent.name.endsWith(".agent.json")) cardFile = `${downloads}/${ent.name}`;
        }
      }
      assert(cardFile !== null, "the Share click must download a .agent.json card");
      const cardText = await Deno.readTextFile(cardFile);
      const card = JSON.parse(cardText);
      assertEquals(card.name, "Share Pilot", "the card carries the agent's name");
      assertEquals(card.role, "Round-trip tester", "the card carries the agent's role");
      // The content contract: no memory, keys, provider config, or context bodies.
      const forbidden = Object.keys(card).filter((k) => /memory|key|apikey|provider|contextfile/i.test(k));
      assertEquals(forbidden, [], "the card carries no memory/key/provider/context fields");

      // One profile plays both sides: the SOURCE agent is deleted after the
      // export (the store gates a same-name re-create behind owner approval —
      // a profile B would never have the name at all).
      const removed = await ev(`new Promise((resolve) => chrome.runtime.sendMessage({ type: "named-agent.delete", id: ${JSON.stringify(sourceId)} }, (res) => resolve(res)))`);
      assertEquals(removed?.ok, true, "the source agent must be deletable");

      // 4. Import: open the create dialog via the real rail button and inject
      // the SAME downloaded card through the real file input.
      await ev(`document.getElementById("new-agent").click()`);
      await new Promise((r) => setTimeout(r, 800));
      const injected = await ev(`(() => {
        const dialog = document.querySelector("body > agent-dialog:last-of-type");
        if (!dialog) return "no dialog";
        const input = [...dialog.querySelectorAll(".agent-config-footer input[type=file]")]
          .find((i) => (i.getAttribute("accept") || "").includes("agent.json") || (i.getAttribute("accept") || "").includes("json"));
        if (!input) return "no import input";
        const dt = new DataTransfer();
        dt.items.add(new File([${JSON.stringify(cardText)}], ${JSON.stringify(cardFile.split("/").pop())}, { type: "application/json" }));
        input.files = dt.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return "injected";
      })()`);
      assertEquals(injected, "injected", "the create dialog must offer an import file input");
      await new Promise((r) => setTimeout(r, 800));

      // 5. The dialog shows the validated fields for confirmation BEFORE create.
      const prefill = await ev(`(() => {
        const dialog = document.querySelector("body > agent-dialog:last-of-type");
        const note = dialog?.querySelector(".agent-config-import-note");
        const name = [...dialog.querySelectorAll("input")].find((i) => i.value === "Share Pilot");
        return { note: note?.textContent ?? null, noteShown: note?.style?.display !== "none", nameFilled: !!name };
      })()`);
      assertEquals(prefill.nameFilled, true, "the name field is prefilled from the card");
      assertEquals(prefill.noteShown, true, "the import confirmation is shown");
      assert(String(prefill.note).includes("Share Pilot"), "the confirmation names the imported agent");

      // 6. Create commits; the new record's card fields equal the exported card's.
      const clicked = await ev(`(() => {
        const dialog = document.querySelector("body > agent-dialog:last-of-type");
        const btn = [...dialog.querySelectorAll(".agent-config-footer button")].find((b) => b.textContent?.trim() === "Create agent");
        if (!btn) return false;
        btn.click();
        return true;
      })()`);
      assertEquals(clicked, true, "the create button must be present");
      await new Promise((r) => setTimeout(r, 1500));

      const list = await ev(`new Promise((resolve) => chrome.runtime.sendMessage({ type: "named-agent.list" }, (res) => resolve(res?.agents ?? [])))`);
      const shares = (list ?? []).filter((a) => a.name === "Share Pilot");
      // The store held ZERO before Create (the source was deleted after export);
      // a slug id may be reused by the fresh record, so the record identity is
      // "exactly one Share Pilot that did not exist before", not an id diff.
      assertEquals(shares.length, 1, "exactly one imported agent exists after Create");
      const imported = shares[0];
      assertEquals(imported.role, card.role, "imported role equals the exported card's role");
      assertEquals(imported.skills ?? [], card.skills ?? [], "imported skills equal the exported card's skills");
    } finally {
      ws.close();
      try { launched.proc.kill("SIGKILL"); } catch { /* gone */ }
      try { await launched.proc.status; } catch { /* reaped */ }
      await Deno.remove(downloads, { recursive: true }).catch(() => {});
    }
  },
});
