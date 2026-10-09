// verify-components-computed-font-size.ts
// Verifies in headless Chrome that all rendered components in extension/shared/components.js
// have computed font-size >= 12px across their shadow DOM trees and verifies presence of all target selectors.

import { fileURLToPath } from "node:url";
import { join, normalize } from "node:path";
import { launchChrome, openCdp, teardownChrome, type LaunchedChrome } from "./lib/chrome-launch.ts";
import { durableDir } from "./lib/durable-root.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DOCS = join(ROOT, "docs");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function serve(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const ac = new AbortController();
    const server = Deno.serve(
      {
        hostname: "127.0.0.1",
        port: 0,
        signal: ac.signal,
        onListen: ({ port, hostname }) => {
          resolve({
            url: `http://${hostname}:${port}`,
            close: async () => {
              ac.abort();
              await server.shutdown();
            },
          });
        },
      },
      async (req) => {
        const url = new URL(req.url);
        let pathname = decodeURIComponent(url.pathname);
        if (pathname === "/") pathname = "/components.html";
        const normalized = normalize(pathname);
        if (normalized.includes("..") || !normalized.startsWith("/")) {
          return new Response("forbidden", { status: 403 });
        }
        const safe = join(DOCS, normalized.slice(1));
        if (!safe.startsWith(DOCS)) {
          return new Response("forbidden", { status: 403 });
        }
        try {
          const body = await Deno.readFile(safe);
          const type = safe.endsWith(".js")
            ? "text/javascript"
            : safe.endsWith(".css")
            ? "text/css"
            : safe.endsWith(".html")
            ? "text/html"
            : "application/octet-stream";
          return new Response(body, {
            headers: { "content-type": `${type}; charset=utf-8` },
          });
        } catch {
          return new Response("not found", { status: 404 });
        }
      },
    );
  });
}

async function main() {
  let serverHandle: { url: string; close: () => Promise<void> } | null = null;
  let chromeHandle: LaunchedChrome | null = null;
  let cdpHandle: any = null;
  let tmpDir: string | null = null;
  let runError: Error | null = null;

  try {
    console.log("Starting static server...");
    serverHandle = await serve();
    console.log(`Server listening at ${serverHandle.url}`);

    tmpDir = await Deno.makeTempDir({ dir: durableDir("chrome-profiles"), prefix: "cap-font-check-" });
    console.log("Launching headless Chrome...");
    chromeHandle = await launchChrome({ profile: tmpDir, windowSize: "1440,900" });
    console.log(`Chrome launched on port ${chromeHandle.port}, connecting CDP...`);
    cdpHandle = await openCdp(chromeHandle.wsUrl);

    const send = async (method: string, params: unknown, sessionId?: string): Promise<any> =>
      (await cdpHandle.send(method, params, sessionId)).result;
    const evl = (s: string, expr: string): Promise<any> => cdpHandle.eval(s, expr);

    const t = await send("Target.createTarget", { url: `${serverHandle.url}/components.html` });
    const s = await send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
    await send("Runtime.enable", {}, s.sessionId);
    await sleep(2000);

    // Evaluate in the page: mount registered components and inspect all computed styles in shadow DOMs
    const evalResult = await evl(
      s.sessionId,
      `
      (async () => {
        const stage = document.createElement("div");
        stage.id = "computed-test-stage";
        document.body.appendChild(stage);

        // 1. theme-picker (.swatch .label)
        const themer = document.createElement("theme-picker");
        themer.setAttribute("theme", "sunlit");
        stage.appendChild(themer);

        // 2. site-agent-card (.status)
        const sac = document.createElement("site-agent-card");
        sac.setAttribute("origin", "https://example.com");
        sac.setAttribute("status", "Active");
        sac.setAttribute("tool-count", "3");
        stage.appendChild(sac);

        // 3. agent-template-card (.persona, .starter, .skill)
        const atc = document.createElement("agent-template-card");
        atc.setAttribute("name", "Specialist");
        atc.setAttribute("persona", "Helps with tasks");
        atc.setAttribute("starter", "");
        atc.setAttribute("skills", JSON.stringify(["reading-capture", "tables-queries"]));
        stage.appendChild(atc);

        // 4. artifact-card (.text, .type-badge)
        const artCard = document.createElement("artifact-card");
        artCard.setAttribute("type", "text");
        artCard.setAttribute("name", "sample.txt");
        artCard.preview = "Sample artifact text content";
        stage.appendChild(artCard);

        // 5. artifact-diff (.hh)
        const artDiff = document.createElement("artifact-diff");
        artDiff.setAttribute("diff", "--- a/f.txt\\n+++ b/f.txt\\n@@ -1 +1 @@\\n-old\\n+new");
        stage.appendChild(artDiff);

        // 6. table-preview (.col-type)
        const tbl = document.createElement("table-preview");
        tbl.setAttribute("table-json", JSON.stringify({
          columns: [{ name: "Column A", type: "text" }],
          rows: [["Value 1"]]
        }));
        stage.appendChild(tbl);

        // 7. artifact-quick-drawer (dt, dd)
        const drawer = document.createElement("artifact-quick-drawer");
        drawer.artifacts = [{ id: "art-1", name: "Report", kind: "html", bytes: 1024, updated: Date.now() }];
        stage.appendChild(drawer);
        drawer.open();

        // 8. code-block (.lang, .copy)
        const cb = document.createElement("code-block");
        cb.setAttribute("lang", "typescript");
        cb.textContent = "const x: number = 42;";
        stage.appendChild(cb);

        // 9. agent-identity (svg text)
        const ai = document.createElement("agent-identity");
        ai.setAttribute("name", "Researcher");
        stage.appendChild(ai);

        // 10. message-bubble (.msg-copy-btn)
        const mb = document.createElement("message-bubble");
        mb.setAttribute("role", "agent");
        mb.setAttribute("content", "Hello world");
        stage.appendChild(mb);

        // 11. screenshot-strip (.lbl)
        const strip = document.createElement("screenshot-strip");
        strip.setAttribute("shots", JSON.stringify([
          { url: "data:image/svg+xml,<svg xmlns=\\"http://www.w3.org/2000/svg\\" width=\\"96\\" height=\\"64\\"><rect width=\\"96\\" height=\\"64\\" fill=\\"%230e6e63\\"/></svg>", label: "Shot 1" }
        ]));
        stage.appendChild(strip);

        // 12. screenshot-thumb (figcaption)
        const thumb = document.createElement("screenshot-thumb");
        thumb.setAttribute("label", "Page View");
        thumb.setAttribute("size", "1280x720");
        stage.appendChild(thumb);

        // 13. agent-composer (.menu-footer, .agent-initial, .tab-picker .tp-url)
        const comp = document.createElement("agent-composer");
        stage.appendChild(comp);

        // 14. tool-receipt (.raw)
        const rcpt = document.createElement("tool-receipt");
        rcpt.setAttribute("tool", "browse_page");
        rcpt.setAttribute("status", "done");
        stage.appendChild(rcpt);

        // 15. next-run (.last)
        const nrw = document.createElement("next-run");
        nrw.setAttribute("at", String(Date.now() + 120000));
        nrw.setAttribute("last-status", "done");
        nrw.setAttribute("last-run", String(Date.now() - 60000));
        stage.appendChild(nrw);

        // 16. streaming-text (.src)
        const st = document.createElement("streaming-text");
        st.setAttribute("content", "Streamed text response");
        st.setAttribute("sources", JSON.stringify(["https://example.com"]));
        stage.appendChild(st);

        // 17. agent-picker (.sub, .meta, .current-badge)
        const ap = document.createElement("agent-picker");
        ap.setAttribute("current-agent-id", "ag-1");
        ap.setAttribute("agents", JSON.stringify([
          {
            id: "group-1",
            label: "Custom Agents",
            agents: [
              { id: "ag-1", kind: "named", name: "Alpha", description: "Primary agent" }
            ]
          }
        ]));
        stage.appendChild(ap);

        // 18. error-console (.console .src, .console .line-copy)
        const ec = document.createElement("error-console");
        ec.lines = [{ ts: Date.now(), level: "warn", src: "net", msg: "test warning" }];
        stage.appendChild(ec);

        // 19. security-shield (.badge)
        const ss = document.createElement("security-shield");
        ss.violations = [{ ts: Date.now(), kind: "fetch", msg: "blocked" }];
        stage.appendChild(ss);

        // 20. diagnostics-panel (.diag-error-time)
        const dp = document.createElement("diagnostics-panel");
        dp.data = { activeRuns: [], errors: [{ ts: Date.now(), level: "warn", msg: "diag warn" }], tools: {} };
        stage.appendChild(dp);

        // 21. activity-explorer (span.aex-agent, .aex-ts, .aex-count, .tt-raw, etc.)
        const aex = document.createElement("activity-explorer");
        aex.entries = [{ id: "e1", ts: Date.now(), kind: "task", agent: "Specialist", text: "Started audit" }];
        stage.appendChild(aex);

        // 22. action-ledger (.al-meta, .al-note, .al-done)
        const al = document.createElement("action-ledger");
        al.rows = [
          { id: "r1", ts: Date.now(), sentence: "Read settings", note: "manual", undone: true },
          { id: "r2", ts: Date.now(), sentence: "Applied fix", note: "auto", undone: false }
        ];
        stage.appendChild(al);

        // 23. agent-timeline (.tl-topic-count)
        const atl = document.createElement("agent-timeline");
        atl.setAttribute("group-by", "topic");
        atl.entries = [{ id: "t1", title: "Audit Task", topic: "Diagnostics", status: "completed", timestamp: Date.now() }];
        stage.appendChild(atl);

        // 24. jobs-board (.jb-meta, .jb-caret)
        const jb = document.createElement("jobs-board");
        jb.jobs = [{ id: "job-1", status: "open", description: "Audit dependencies", party: "bot" }];
        stage.appendChild(jb);

        // 25. system-prompt-editor (.spe-badge, .spe-meta code)
        const spe = document.createElement("system-prompt-editor");
        spe.setAttribute("scope-label", "Global");
        spe.describe = { scope: "global", systemPrompt: "Be helpful", layers: [{ name: "base", text: "core" }] };
        stage.appendChild(spe);

        // 26. tool-library (.source-tool-head .src, .avail, .chip, etc.)
        const tl = document.createElement("tool-library");
        tl.summary = {
          ok: true,
          mode: "shadow-metadata-only",
          bySource: { "extension-builtin": 5 },
          purposeFamilies: [{ id: "f1", label: "Family 1", line: "Desc 1" }],
          purposeGroups: { "g1": { family: "f1", label: "Group 1", line: "Group Desc" } },
          groupedRows: [{ purpose: "g1", toolId: "t1", name: "tool1", source: "extension-builtin", availability: "ready" }]
        };
        stage.appendChild(tl);

        // Allow components to render shadow DOMs
        await new Promise((r) => setTimeout(r, 600));

        // Required selector coverage check across the page
        const requiredSelectors = [
          { name: "theme-picker .swatch .label", sel: "theme-picker", inner: ".swatch .label" },
          { name: "site-agent-card .status", sel: "site-agent-card", inner: ".status" },
          { name: "agent-template-card .persona", sel: "agent-template-card", inner: ".persona" },
          { name: "agent-template-card .starter", sel: "agent-template-card", inner: ".starter" },
          { name: "artifact-card .text", sel: "artifact-card", inner: ".text" },
          { name: "artifact-card .type-badge", sel: "artifact-card", inner: ".type-badge" },
          { name: "artifact-diff .hh", sel: "artifact-diff", inner: ".hh" },
          { name: "table-preview .col-type", sel: "table-preview", inner: ".col-type" },
          { name: "artifact-quick-drawer dt", sel: "artifact-quick-drawer", inner: "dt" },
          { name: "artifact-quick-drawer dd", sel: "artifact-quick-drawer", inner: "dd" },
          { name: "code-block .lang", sel: "code-block", inner: ".lang" },
          { name: "code-block .copy", sel: "code-block", inner: ".copy" },
          { name: "agent-identity svg text", sel: "agent-identity", inner: "svg text" },
          { name: "screenshot-strip .lbl", sel: "screenshot-strip", inner: ".lbl" },
          { name: "screenshot-thumb figcaption", sel: "screenshot-thumb", inner: "figcaption" },
          { name: "next-run .last", sel: "next-run", inner: ".last" },
          { name: "streaming-text .src", sel: "streaming-text", inner: ".src" },
          { name: "agent-picker .sub", sel: "agent-picker", inner: ".sub" },
          { name: "agent-picker .current-badge", sel: "agent-picker", inner: ".current-badge" },
          { name: "action-ledger .al-meta", sel: "action-ledger", inner: ".al-meta" },
          { name: "action-ledger .al-done", sel: "action-ledger", inner: ".al-done" },
          { name: "agent-timeline .tl-topic-count", sel: "agent-timeline", inner: ".tl-topic-count" },
          { name: "jobs-board .jb-meta", sel: "jobs-board", inner: ".jb-meta" },
          { name: "system-prompt-editor .spe-badge", sel: "system-prompt-editor", inner: ".spe-badge" },
          { name: "system-prompt-editor .spe-meta code", sel: "system-prompt-editor", inner: ".spe-meta code" }
        ];

        const coverage = [];
        for (const req of requiredSelectors) {
          let found = false;
          let computedSize = null;
          for (const host of document.querySelectorAll(req.sel)) {
            const root = host.shadowRoot;
            if (root) {
              const el = root.querySelector(req.inner);
              if (el) {
                found = true;
                computedSize = parseFloat(window.getComputedStyle(el).fontSize);
                break;
              }
            }
          }
          coverage.push({ name: req.name, found, computedSize });
        }

        // Full traversal across every element in every shadow root
        const inspected = [];
        const violations = [];

        function walk(node, parentPath) {
          if (!node) return;
          const root = node.shadowRoot || (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? node : null);
          const children = root ? root.children : node.children;

          for (const el of children) {
            const tag = el.tagName.toLowerCase();
            const cls = el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\\s+/).join(".") : "";
            const currentPath = parentPath + " > " + tag + cls;

            const style = window.getComputedStyle(el);
            const fs = parseFloat(style.fontSize);

            const text = (el.textContent || "").trim();
            inspected.push({
              path: currentPath,
              fontSize: fs,
              text: text.slice(0, 40)
            });

            if (fs > 0 && fs < 11.99) {
              violations.push({
                path: currentPath,
                fontSize: fs,
                text: text.slice(0, 60)
              });
            }

            if (el.shadowRoot) {
              walk(el, currentPath);
            }
            if (el.children && el.children.length > 0) {
              walk(el, currentPath);
            }
          }
        }

        for (const el of document.querySelectorAll("*")) {
          if (el.shadowRoot) {
            const tag = el.tagName.toLowerCase();
            walk(el, tag);
          }
        }

        return {
          inspectedCount: inspected.length,
          violationsCount: violations.length,
          violations: violations.slice(0, 20),
          coverage,
          sample: inspected.filter(i => i.fontSize >= 12 && i.fontSize <= 13).slice(0, 15)
        };
      })()
      `,
    );

    console.log("Coverage check:", JSON.stringify(evalResult.coverage, null, 2));
    console.log(`Inspected elements: ${evalResult.inspectedCount}`);
    console.log(`Violations count: ${evalResult.violationsCount}`);

    const evidenceDir = durableDir("evidence", "dz3wi");
    const evidenceFile = join(evidenceDir, "computed-font-size.json");
    await Deno.writeTextFile(evidenceFile, JSON.stringify(evalResult, null, 2));

    const missingSelectors = evalResult.coverage.filter((c: any) => !c.found);
    if (missingSelectors.length > 0) {
      runError = new Error(`Required selectors not found in rendered DOM: ${missingSelectors.map((m: any) => m.name).join(", ")}`);
    } else if (evalResult.violationsCount > 0) {
      runError = new Error(`Found ${evalResult.violationsCount} computed font-size violations (< 12px)!`);
    } else {
      console.log(`PASS: All ${evalResult.inspectedCount} shadow-DOM elements computed at >= 12px across all covered components!`);
    }
  } catch (err) {
    runError = err instanceof Error ? err : new Error(String(err));
  } finally {
    if (cdpHandle) {
      try {
        await cdpHandle.close();
      } catch {}
    }
    if (chromeHandle) {
      try {
        await teardownChrome(chromeHandle);
      } catch {}
    }
    if (serverHandle) {
      try {
        await serverHandle.close();
      } catch {}
    }
    if (tmpDir) {
      try {
        await Deno.remove(tmpDir, { recursive: true });
      } catch {}
    }
  }

  if (runError) {
    throw runError;
  }
}

if (import.meta.main) {
  await main();
}
