// tests/persistent-fs-grants.test.ts — Persistent Local File System Access Grants Store KAT Suite.
// (CAP-FB-20260823-PERSISTENT-FS-ACCESS-01).

import { assert, assertEquals } from "jsr:@std/assert";
import { IDBFactory } from "fake-indexeddb";
import {
  saveFsGrant,
  getFsGrant,
  listFsGrants,
  deleteFsGrant,
  queryFsGrantStatus,
  serializeFsGrantSummary,
  wireLocalFolderPickers,
  listFsGrantEntries,
  readFsGrantFile,
  cleanRelativePath,
  MAX_FS_LIST_ENTRIES,
  MAX_FS_READ_BYTES,
  MAX_FS_TEXT_DECODE_BYTES,
} from "../extension/lib/fs-grants.js";
import {
  SETTINGS_SECTIONS,
  OPTIONS_PRODUCT_HASHES,
  normalizeSettingsSectionId,
} from "../extension/lib/pure.js";

// A structured-cloneable handle representation (mimics native FileSystemDirectoryHandle serialization)
function createCloneableHandle(name: string, kind = "directory") {
  return {
    kind,
    name,
  };
}

Deno.test("fs-grants: store round-trip with cloneable handle (save, get, list)", async () => {
  const fakeIdb = new IDBFactory();
  const mockHandle = createCloneableHandle("my-workspace-project");

  const saved = await saveFsGrant(
    {
      grantId: "fsg_test_123",
      handle: mockHandle,
      name: "my-workspace-project",
      kind: "directory",
      mode: "readwrite",
      scope: { taskId: "task_456" },
      createdAt: 1000,
      lastUsedAt: 2000,
    },
    { customIdb: fakeIdb },
  );

  assertEquals(saved.grantId, "fsg_test_123");
  assertEquals(saved.name, "my-workspace-project");
  assertEquals(saved.mode, "readwrite");
  assertEquals(saved.scope?.taskId, "task_456");

  const retrieved = await getFsGrant("fsg_test_123", { customIdb: fakeIdb });
  assert(retrieved, "grant must be retrievable from IDB");
  assertEquals(retrieved.grantId, "fsg_test_123");
  assertEquals(retrieved.name, "my-workspace-project");
  assertEquals(retrieved.kind, "directory");
  assertEquals(retrieved.mode, "readwrite");

  const allGrants = await listFsGrants({}, { customIdb: fakeIdb });
  assertEquals(allGrants.length, 1);
  assertEquals(allGrants[0].grantId, "fsg_test_123");
});

Deno.test("fs-grants: scope filtering returns matching task/agent or global grants", async () => {
  const fakeIdb = new IDBFactory();
  const handleA = createCloneableHandle("global-folder");
  const handleB = createCloneableHandle("task-folder");
  const handleC = createCloneableHandle("agent-folder");

  await saveFsGrant(
    { grantId: "fsg_global", handle: handleA, name: "global-folder", scope: null, lastUsedAt: 100 },
    { customIdb: fakeIdb },
  );
  await saveFsGrant(
    { grantId: "fsg_task", handle: handleB, name: "task-folder", scope: { taskId: "task_1" }, lastUsedAt: 200 },
    { customIdb: fakeIdb },
  );
  await saveFsGrant(
    { grantId: "fsg_agent", handle: handleC, name: "agent-folder", scope: { agentId: "agent_1" }, lastUsedAt: 300 },
    { customIdb: fakeIdb },
  );

  // Scoped to task_1 -> should see fsg_task AND fsg_global, but NOT fsg_agent
  const taskGrants = await listFsGrants({ scope: { taskId: "task_1" } }, { customIdb: fakeIdb });
  const taskIds = taskGrants.map((g: any) => g.grantId);
  assert(taskIds.includes("fsg_task"), "must include matching task grant");
  assert(taskIds.includes("fsg_global"), "must include global grant");
  assertEquals(taskIds.includes("fsg_agent"), false, "must not include other agent grant");

  // Scoped to agent_1 -> should see fsg_agent AND fsg_global
  const agentGrants = await listFsGrants({ scope: { agentId: "agent_1" } }, { customIdb: fakeIdb });
  const agentIds = agentGrants.map((g: any) => g.grantId);
  assert(agentIds.includes("fsg_agent"), "must include matching agent grant");
  assert(agentIds.includes("fsg_global"), "must include global grant");
  assertEquals(agentIds.includes("fsg_task"), false, "must not include task grant");
});

Deno.test("fs-grants: revoke truthfully removes grant record from store", async () => {
  const fakeIdb = new IDBFactory();
  const mockHandle = createCloneableHandle("to-be-revoked");

  await saveFsGrant(
    { grantId: "fsg_revokeme", handle: mockHandle, name: "to-be-revoked" },
    { customIdb: fakeIdb },
  );

  const beforeRevoke = await getFsGrant("fsg_revokeme", { customIdb: fakeIdb });
  assert(beforeRevoke, "grant must exist before revoke");

  const deleteResult = await deleteFsGrant("fsg_revokeme", { customIdb: fakeIdb });
  assertEquals(deleteResult.ok, true);
  assertEquals("deleted" in deleteResult && deleteResult.deleted, true);

  const afterRevoke = await getFsGrant("fsg_revokeme", { customIdb: fakeIdb });
  assertEquals(afterRevoke, null, "grant must be null after revoke");

  const remaining = await listFsGrants({}, { customIdb: fakeIdb });
  assertEquals(remaining.length, 0, "store must be empty after revoking sole grant");
});

Deno.test("fs-grants: queryFsGrantStatus reflects granted, prompt, denied faithfully", async () => {
  const grantedHandle = {
    kind: "directory",
    name: "granted-folder",
    queryPermission: async ({ mode = "read" }: { mode?: string } = {}) => "granted",
  };
  const promptHandle = {
    kind: "directory",
    name: "prompt-folder",
    queryPermission: async ({ mode = "read" }: { mode?: string } = {}) => "prompt",
  };
  const deniedHandle = {
    kind: "directory",
    name: "denied-folder",
    queryPermission: async ({ mode = "read" }: { mode?: string } = {}) => "denied",
  };

  const status1 = await queryFsGrantStatus({ handle: grantedHandle, mode: "read" });
  assertEquals(status1, "granted");

  const status2 = await queryFsGrantStatus({ handle: promptHandle, mode: "readwrite" });
  assertEquals(status2, "prompt");

  const status3 = await queryFsGrantStatus({ handle: deniedHandle, mode: "read" });
  assertEquals(status3, "denied");

  const status4 = await queryFsGrantStatus(null);
  assertEquals(status4, "prompt");
});

Deno.test("fs-grants: serializeFsGrantSummary strips handle object for safe IPC messaging", () => {
  const mockHandle = createCloneableHandle("test-folder");
  const record = {
    grantId: "fsg_abc",
    handle: mockHandle,
    name: "test-folder",
    kind: "directory" as const,
    mode: "readwrite" as const,
    scope: { taskId: "task_99" },
    createdAt: 1000,
    lastUsedAt: 2000,
  };

  const summary = serializeFsGrantSummary(record, "granted");
  assert(summary, "summary must not be null");
  assertEquals(summary.grantId, "fsg_abc");
  assertEquals(summary.name, "test-folder");
  assertEquals(summary.kind, "directory");
  assertEquals(summary.mode, "readwrite");
  assertEquals(summary.scope?.taskId, "task_99");
  assertEquals(summary.status, "granted");
  assertEquals("handle" in (summary as any), false, "summary must not leak raw handle across IPC");
});

Deno.test("pure: Settings sections and navigation include local-folders", () => {
  assert(SETTINGS_SECTIONS.includes("local-folders"), "SETTINGS_SECTIONS must include local-folders");
  assert(OPTIONS_PRODUCT_HASHES.has("#local-folders"), "OPTIONS_PRODUCT_HASHES must include #local-folders");
  assertEquals(normalizeSettingsSectionId("#local-folders"), "local-folders");
  assertEquals(normalizeSettingsSectionId("local-folders"), "local-folders");
});

Deno.test("options.html: contains local-folders nav item and panel with Tranche 2 picker toolbar", async () => {
  const html = await Deno.readTextFile(
    new URL("../extension/options/options.html", import.meta.url),
  );
  assert(html.includes('data-section="local-folders"'), "options.html must contain local-folders nav link");
  assert(html.includes('id="local-folders"'), "options.html must contain local-folders section panel");
  assert(html.includes('id="local-folders-list"'), "options.html must contain local-folders-list container");
  assert(html.includes('id="fs-add-directory-btn"'), "options.html must contain Add folder button");
  assert(html.includes('id="fs-add-file-btn"'), "options.html must contain Add file button");
  assert(html.includes('id="fs-pick-mode"'), "options.html must contain Access Mode selector");
  assert(html.includes('id="fs-picker-unsupported-notice"'), "options.html must contain unsupported environment notice");
});

Deno.test("wireLocalFolderPickers: feature-detects unavailable picker APIs truthfully", () => {
  const dirBtn = { disabled: false };
  const fileBtn = { disabled: false };
  const notice = { style: { display: "none" } };

  const fakeWin: any = {
    document: {
      getElementById: (id: string) => {
        if (id === "fs-add-directory-btn") return dirBtn;
        if (id === "fs-add-file-btn") return fileBtn;
        if (id === "fs-picker-unsupported-notice") return notice;
        return null;
      },
    },
    // showDirectoryPicker and showOpenFilePicker are absent
  };

  wireLocalFolderPickers({ win: fakeWin });

  assertEquals(notice.style.display, "inline-flex", "notice must be displayed when pickers unavailable");
  assertEquals(dirBtn.disabled, true, "directory button must be disabled");
  assertEquals(fileBtn.disabled, true, "file button must be disabled");
});

Deno.test("wireLocalFolderPickers: handles directory picking with chosen mode and saves grant", async () => {
  const fakeIdb = new IDBFactory();
  let clickHandler: any = null;

  const dirBtn: any = {
    disabled: false,
    addEventListener: (event: string, fn: any) => {
      if (event === "click") clickHandler = fn;
    },
  };
  const fileBtn: any = { disabled: false, addEventListener: () => {} };
  const modeSelect: any = { value: "readwrite" };
  const notice: any = { style: { display: "none" } };

  const mockHandle = {
    kind: "directory",
    name: "workspace-repo",
  };

  const fakeWin: any = {
    allowUntrustedEventsForTesting: true,
    document: {
      getElementById: (id: string) => {
        if (id === "fs-add-directory-btn") return dirBtn;
        if (id === "fs-add-file-btn") return fileBtn;
        if (id === "fs-pick-mode") return modeSelect;
        if (id === "fs-picker-unsupported-notice") return notice;
        return null;
      },
    },
    showDirectoryPicker: async ({ mode }: { mode: string }) => {
      assertEquals(mode, "readwrite", "picker must receive selected access mode");
      return mockHandle;
    },
  };

  let savedCalled = false;
  wireLocalFolderPickers({
    win: fakeWin,
    onSaved: () => {
      savedCalled = true;
    },
  });

  assertEquals(notice.style.display, "none");
  assertEquals(dirBtn.disabled, false);
  assert(clickHandler, "click handler must be attached");

  // Trigger click
  await clickHandler({ isTrusted: true });
  assertEquals(savedCalled, true, "onSaved callback must be invoked after picking");
});

Deno.test("wireLocalFolderPickers: cleanly ignores AbortError on user cancel", async () => {
  let clickHandler: any = null;
  const dirBtn: any = {
    disabled: false,
    addEventListener: (event: string, fn: any) => {
      if (event === "click") clickHandler = fn;
    },
  };
  const fakeWin: any = {
    allowUntrustedEventsForTesting: true,
    document: {
      getElementById: (id: string) => {
        if (id === "fs-add-directory-btn") return dirBtn;
        return null;
      },
    },
    showDirectoryPicker: async () => {
      const err = new Error("User cancelled");
      err.name = "AbortError";
      throw err;
    },
  };

  wireLocalFolderPickers({ win: fakeWin });
  assert(clickHandler);

  // Should not throw
  await clickHandler({ isTrusted: true });
});

Deno.test("wireLocalFolderPickers: handles file picking with chosen mode and saves file grant", async () => {
  let clickHandler: any = null;

  const dirBtn: any = { disabled: false, addEventListener: () => {} };
  const fileBtn: any = {
    disabled: false,
    addEventListener: (event: string, fn: any) => {
      if (event === "click") clickHandler = fn;
    },
  };
  const modeSelect: any = { value: "read" };
  const notice: any = { style: { display: "none" } };

  const mockFileHandle = {
    kind: "file",
    name: "dataset.csv",
  };

  const fakeWin: any = {
    allowUntrustedEventsForTesting: true,
    document: {
      getElementById: (id: string) => {
        if (id === "fs-add-directory-btn") return dirBtn;
        if (id === "fs-add-file-btn") return fileBtn;
        if (id === "fs-pick-mode") return modeSelect;
        if (id === "fs-picker-unsupported-notice") return notice;
        return null;
      },
    },
    showOpenFilePicker: async ({ multiple }: { multiple: boolean }) => {
      assertEquals(multiple, false);
      return [mockFileHandle];
    },
  };

  let savedGrant: any = null;
  wireLocalFolderPickers({
    win: fakeWin,
    onSaved: (g) => {
      savedGrant = g;
    },
  });

  assert(clickHandler);
  await clickHandler({ isTrusted: true });

  assert(savedGrant, "file grant must be saved");
  assertEquals(savedGrant.name, "dataset.csv");
  assertEquals(savedGrant.kind, "file");
  assertEquals(savedGrant.mode, "read");
});

Deno.test("wireLocalFolderPickers: untrusted click event is rejected without user activation", async () => {
  let clickHandler: any = null;

  const dirBtn: any = {
    disabled: false,
    addEventListener: (event: string, fn: any) => {
      if (event === "click") clickHandler = fn;
    },
  };

  const fakeWin: any = {
    allowUntrustedEventsForTesting: false,
    document: {
      getElementById: (id: string) => {
        if (id === "fs-add-directory-btn") return dirBtn;
        return null;
      },
    },
    showDirectoryPicker: async () => {
      throw new Error("Should never be called for untrusted click");
    },
  };

  let flashMsg = "";
  wireLocalFolderPickers({
    win: fakeWin,
    onFlash: (m) => {
      flashMsg = m;
    },
  });

  assert(clickHandler);
  await clickHandler({ isTrusted: false });

  assertEquals(flashMsg, "Folder picker requires a genuine user click.");
});

Deno.test("service-worker.js: fs-grant routes require owner-options or extension authority", async () => {
  const sw = await Deno.readTextFile(
    new URL("../extension/background/service-worker.js", import.meta.url),
  );

  assert(
    sw.includes('async "fs-grant.list"'),
    "service worker must register fs-grant.list route",
  );
  assert(
    sw.includes('async "fs-grant.get"'),
    "service worker must register fs-grant.get route",
  );
  assert(
    sw.includes('async "fs-grant.remove"'),
    "service worker must register fs-grant.remove route",
  );
  assert(
    sw.includes('async "fs-grant.list-entries"'),
    "service worker must register fs-grant.list-entries route",
  );
  assert(
    sw.includes('async "fs-grant.read-file"'),
    "service worker must register fs-grant.read-file route",
  );

  // Checks for principal gating (owner-options or extension)
  assert(
    sw.includes('context?.principal !== "owner-options" && context?.principal !== "extension"'),
    "service worker must gate fs-grant routes against non-extension / non-owner callers",
  );
});

Deno.test("cleanRelativePath: normalizes paths and rejects traversal attacks (..)", () => {
  assertEquals(cleanRelativePath(""), []);
  assertEquals(cleanRelativePath("foo/bar/baz"), ["foo", "bar", "baz"]);
  assertEquals(cleanRelativePath("foo/./bar//baz/"), ["foo", "bar", "baz"]);
  assertEquals(cleanRelativePath("foo\\bar\\baz"), ["foo", "bar", "baz"]);

  let traversalThrown = false;
  try {
    cleanRelativePath("../secret.txt");
  } catch (err: any) {
    traversalThrown = true;
    assert(err.message.includes("invalid_path_traversal"));
  }
  assertEquals(traversalThrown, true, "leading .. traversal must throw");

  let innerTraversalThrown = false;
  try {
    cleanRelativePath("docs/../../etc/passwd");
  } catch (err: any) {
    innerTraversalThrown = true;
    assert(err.message.includes("invalid_path_traversal"));
  }
  assertEquals(innerTraversalThrown, true, "inner .. traversal must throw");
});

Deno.test("listFsGrantEntries: enumerates directory entries with bounds and truncation", async () => {
  const mockFiles = [
    { name: "README.md", kind: "file" },
    { name: "package.json", kind: "file" },
    { name: "src", kind: "directory" },
  ];

  const mockDirHandle = {
    kind: "directory",
    name: "my-project",
    queryPermission: async () => "granted",
    values: async function* () {
      for (const f of mockFiles) yield f;
    },
  };

  await saveFsGrant(
    { grantId: "fsg_list_test", handle: mockDirHandle, name: "my-project" },
  );

  const res = await listFsGrantEntries("fsg_list_test", { limit: 2 });
  assertEquals(res.ok, true);
  assertEquals(res.entries?.length, 2);
  assertEquals(res.truncated, true);
  assertEquals(res.total, 3);
  assertEquals(res.entries?.[0].name, "README.md");
});

Deno.test("listFsGrantEntries: fails closed when permission has lapsed (prompt)", async () => {
  const mockDirHandle = {
    kind: "directory",
    name: "lapsed-project",
    queryPermission: async () => "prompt",
  };

  await saveFsGrant(
    { grantId: "fsg_lapsed_list", handle: mockDirHandle, name: "lapsed-project" },
  );

  const res = await listFsGrantEntries("fsg_lapsed_list", {});
  assertEquals(res.ok, false);
  assertEquals(res.error, "fs_permission_lapsed");
  assertEquals(res.status, "prompt");
});

Deno.test("readFsGrantFile: reads text with SHA-256 digest and enforces maxBytes bound", async () => {
  const fileContent = "Hello from local persistent filesystem!";
  const fileBytes = new TextEncoder().encode(fileContent);

  const mockFileHandle = {
    kind: "file",
    name: "greeting.txt",
    queryPermission: async () => "granted",
    getFile: async () => ({
      name: "greeting.txt",
      size: fileBytes.byteLength,
      lastModified: 1700000000000,
      arrayBuffer: async () => fileBytes.buffer,
    }),
  };

  await saveFsGrant(
    { grantId: "fsg_read_test", handle: mockFileHandle, name: "greeting.txt", kind: "file" },
  );

  const res = await readFsGrantFile("fsg_read_test", { asText: true });
  assertEquals(res.ok, true);
  assertEquals(res.name, "greeting.txt");
  assertEquals(res.size, fileBytes.byteLength);
  assertEquals(res.content, fileContent);
  assert(typeof res.sha256 === "string" && res.sha256.length === 64, "must include 64-char SHA-256 hex digest");

  // Test size cap refusal
  const cappedRes = await readFsGrantFile("fsg_read_test", { maxBytes: 10 });
  assertEquals(cappedRes.ok, false);
  assertEquals(cappedRes.error, "fs_file_too_large");
});

Deno.test("readFsGrantFile: fails closed on traversal attack and lapsed permission", async () => {
  const mockFileHandle = {
    kind: "file",
    name: "doc.txt",
    queryPermission: async () => "prompt",
    getFile: async () => ({ name: "doc.txt", size: 5, arrayBuffer: async () => new ArrayBuffer(5) }),
  };

  await saveFsGrant(
    { grantId: "fsg_lapsed_read", handle: mockFileHandle, name: "doc.txt", kind: "file" },
  );

  const res1 = await readFsGrantFile("fsg_lapsed_read", {});
  assertEquals(res1.ok, false);
  assertEquals(res1.error, "fs_permission_lapsed");

  // Traversal attack
  mockFileHandle.queryPermission = async () => "granted";
  const res2 = await readFsGrantFile("fsg_lapsed_read", { relativePath: "../outside.txt" });
  assertEquals(res2.ok, false);
  assert(res2.error?.includes("invalid_path_traversal"));
});

Deno.test("options.js: wires renderLocalFolders and renders empty state or grant cards", async () => {
  const optionsJs = await Deno.readTextFile(
    new URL("../extension/options/options.js", import.meta.url),
  );

  assert(
    optionsJs.includes("export async function renderLocalFolders"),
    "options.js must define and export renderLocalFolders",
  );
  assert(
    optionsJs.includes('if (sectionId === "local-folders") renderLocalFolders()'),
    "options.js must call renderLocalFolders on navigating to #local-folders",
  );
  assert(
    optionsJs.includes("await renderLocalFolders();"),
    "options.js must initialize local folders on page boot",
  );
  assert(
    optionsJs.includes("No local folder or file access has been granted"),
    "options.js must render truthful empty state when no grants exist",
  );
  assert(
    optionsJs.includes('type: "fs-grant.remove"'),
    "options.js must send fs-grant.remove when revoking",
  );
});
