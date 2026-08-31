// Composer slash-command audit + Chrome-backed picker contracts.
import {
  COMMAND_NAMESPACES,
  loadComposerCommandItems,
  resolveComposerCommandSelection,
} from "../extension/shared/composer-commands.js";
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";

Deno.test("composer command audit removes obsolete commands and exposes the useful registry", () => {
  assertEquals(COMMAND_NAMESPACES.map((item) => item.id), [
    "skill",
    "agent",
    "tabs",
    "artifacts",
    "bookmarks",
    "history",
    "files",
    "folder",
    "remember",
  ]);
  for (const id of ["tabs", "artifacts", "bookmarks", "history", "agent"]) {
    assert(
      COMMAND_NAMESPACES.find((item) => item.id === id)?.direct,
      `/${id} must open directly`,
    );
  }
  for (const removed of ["theme", "focus", "schedule", "model", "downloads"]) {
    assert(
      !COMMAND_NAMESPACES.some((item) => item.id === removed),
      `/${removed} must stay absent`,
    );
  }
});

Deno.test("/folder lists granted directories, filters by query, and excludes files/lapsed grants", async () => {
  const calls: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const runtimeSend = async (type: string, payload?: Record<string, unknown>) => {
    calls.push({ type, payload });
    if (type === "fs-grant.list") {
      return {
        ok: true,
        grants: [
          { grantId: "fsg_docs", name: "Documents", kind: "directory", status: "granted" },
          { grantId: "fsg_pics", name: "Photos", kind: "directory", status: "granted" },
          { grantId: "fsg_lapsed", name: "Old Drive", kind: "directory", status: "prompt" },
          { grantId: "fsg_file", name: "notes.txt", kind: "file", status: "granted" },
        ],
      };
    }
    return { ok: false, error: `unexpected ${type}` };
  };
  const all = await loadComposerCommandItems("folder", "", { runtimeSend });
  assertEquals(calls[0].type, "fs-grant.list");
  const folderRows = all.filter((item) => item.kind === "local-folder");
  assertEquals(folderRows.map((item) => item.label), ["Documents", "Photos"]);
  assertEquals(folderRows[0].grantId, "fsg_docs");
  assertEquals(folderRows[0].folderName, "Documents");
  // Files and lapsed grants are NOT folder rows; the lapsed grant surfaces an honest recovery row.
  assert(all.some((item) => item.kind === "files-action" && /Old Drive/.test(item.label)), "lapsed grant must surface a recovery row");
  assert(!all.some((item) => item.label === "notes.txt"), "files must not appear as folders");
  // Query filtering goes through the same loader with the query as the search arg.
  const filtered = await loadComposerCommandItems("folder", "photo", { runtimeSend });
  assertEquals(calls[1].type, "fs-grant.list");
  assert(filtered.every((item) => /photo/i.test(item.label + " " + (item.description ?? "")) || item.kind === "files-action"), "filtered rows match the query");
});

Deno.test("/folder with no grants shows the Settings recovery row and a runtime failure is honest", async () => {
  const empty = await loadComposerCommandItems("folder", "", {
    runtimeSend: async () => ({ ok: true, grants: [] }),
  });
  assert(empty.some((item) => item.label === "No granted folders" && item.kind === "files-action"), "empty state must offer Settings");
  const failed = await loadComposerCommandItems("folder", "", {
    runtimeSend: async () => ({ ok: false, error: "nope" }),
  });
  assert(failed.some((item) => /unavailable/.test(item.label)), "runtime failure must be surfaced");
});

Deno.test("/tabs lists every window, searches title/url, and resolves an agent-readable tab attachment", async () => {
  let query: unknown = null;
  const chromeApi = {
    tabs: {
      query: (value: unknown) => {
        query = value;
        return Promise.resolve([
          {
            id: 11,
            windowId: 1,
            title: "Alpha brief",
            url: "https://alpha.example/",
          },
          {
            id: 22,
            windowId: 2,
            title: "Beta notes",
            url: "https://beta.example/path",
          },
        ]);
      },
    },
  };
  const all = await loadComposerCommandItems("tabs", "", { chromeApi });
  assertEquals(query, {});
  assertEquals(all.map((item) => item.attachment?.windowId), [1, 2]);
  const filtered = await loadComposerCommandItems("tabs", "beta.example", {
    chromeApi,
  });
  assertEquals(filtered.length, 1);
  const picked = await resolveComposerCommandSelection(filtered[0]);
  assertEquals(picked?.text, "/tabs:22");
  assertEquals(picked?.attachment, {
    name: "Beta notes",
    url: "https://beta.example/path",
    type: "tab",
    size: 0,
    kind: "tab",
    tabId: 22,
    windowId: 2,
  });
});

Deno.test("/artifacts searches the whole library and inserts the fetched artifact body", async () => {
  const calls: Array<[string, Record<string, unknown> | undefined]> = [];
  const runtimeSend = (type: string, payload?: Record<string, unknown>) => {
    calls.push([type, payload]);
    if (type === "asset.list") {
      return Promise.resolve({
        assets: [
          {
            id: "a1",
            name: "Quarterly report",
            type: "text",
            origin: "https://work.example",
          },
          { id: "a2", name: "Chart", type: "image", origin: "master" },
        ],
      });
    }
    return Promise.resolve({
      ok: true,
      asset: {
        id: "a1",
        name: "Quarterly report",
        type: "text",
        origin: "https://work.example",
        size: 13,
        content: "Report body ✓",
      },
    });
  };
  const items = await loadComposerCommandItems("artifacts", "quarter", {
    runtimeSend,
  });
  assertEquals(calls[0], ["asset.list", { origin: "all" }]);
  assertEquals(items.length, 1);
  const picked = await resolveComposerCommandSelection(items[0], {
    runtimeSend,
  });
  assertEquals(calls[1], ["asset.get", {
    origin: "https://work.example",
    id: "a1",
  }]);
  assertEquals(picked?.text, "/artifact:a1");
  assertEquals(picked?.attachment?.kind, "artifact");
  assertMatch(picked?.attachment?.dataURL ?? "", /^data:text\/plain;base64,/);
});

Deno.test("/bookmarks lists recent links, searches Chrome bookmarks, and inserts link context", async () => {
  const calls: string[] = [];
  const rows = [
    { id: "folder", title: "Folder" },
    {
      id: "b1",
      title: "Chrome APIs",
      url: "https://developer.chrome.com/docs/extensions/reference/api",
    },
  ];
  const chromeApi = {
    permissions: { contains: () => Promise.resolve(true) },
    bookmarks: {
      getRecent: (_max: number) => {
        calls.push("recent");
        return Promise.resolve(rows);
      },
      search: (query: string) => {
        calls.push(`search:${query}`);
        return Promise.resolve(rows);
      },
    },
  };
  const recent = await loadComposerCommandItems("bookmarks", "", { chromeApi });
  assertEquals(recent.length, 1);
  const searched = await loadComposerCommandItems("bookmarks", "Chrome", {
    chromeApi,
  });
  assertEquals(calls, ["recent", "search:Chrome"]);
  const picked = await resolveComposerCommandSelection(searched[0]);
  assertEquals(
    picked?.text,
    "Bookmark: https://developer.chrome.com/docs/extensions/reference/api",
  );
  assertEquals(picked?.attachment?.url, rows[1].url);
});

Deno.test("/history searches from the beginning of history and inserts link context", async () => {
  let query: Record<string, unknown> | null = null;
  const chromeApi = {
    permissions: { contains: () => Promise.resolve(true) },
    history: {
      search: (value: Record<string, unknown>) => {
        query = value;
        return Promise.resolve([
          {
            title: "Chrome history",
            url: "https://example.test/chrome",
            lastVisitTime: 42,
          },
          {
            title: "Other",
            url: "https://example.test/other",
            lastVisitTime: 21,
          },
        ]);
      },
    },
  };
  const items = await loadComposerCommandItems("history", "chrome", {
    chromeApi,
  });
  assertEquals(query, { text: "chrome", startTime: 0, maxResults: 100 });
  assertEquals(items.length, 1);
  const picked = await resolveComposerCommandSelection(items[0]);
  assertEquals(picked?.text, "History: https://example.test/chrome");
  assertEquals(picked?.attachment?.url, "https://example.test/chrome");
  assertEquals(picked?.attachment?.kind, "history");
});

Deno.test("/bookmarks and /history expose an honest Settings grant state when authority is absent", async () => {
  let apiCalls = 0;
  const chromeApi = {
    permissions: { contains: () => Promise.resolve(false) },
    bookmarks: { getRecent: () => { apiCalls++; return []; } },
    history: { search: () => { apiCalls++; return []; } },
  };
  const bookmarks = await loadComposerCommandItems("bookmarks", "", { chromeApi });
  const history = await loadComposerCommandItems("history", "", { chromeApi });
  assertEquals(apiCalls, 0, "Chrome data APIs must not run without their grants");
  assertEquals(bookmarks[0], {
    id: "capability:bookmarks",
    label: "Bookmarks unavailable",
    description: "Grant Bookmarks in Settings, then retry /bookmarks",
    kind: "capability",
    capability: "bookmarks",
  });
  assertEquals(history[0]?.description, "Grant History in Settings, then retry /history");
});

Deno.test("the live composer opens exact Chrome-deep commands and attaches picked context", async () => {
  const source = await Deno.readTextFile(
    new URL("../extension/shared/components.js", import.meta.url),
  );
  assertMatch(source, /item\.direct && item\.id === ns/);
  assertMatch(source, /resolveComposerCommandSelection\(item/);
  assertMatch(
    source,
    /if \(selection\.attachment\) this\._attachMedia\(selection\.attachment\)/,
  );
  assertMatch(source, /slash\?\.ns === "agent"/);
  assertMatch(source, /item\.kind === "capability"/);
  assertMatch(source, /openOptionsPage/);
});
