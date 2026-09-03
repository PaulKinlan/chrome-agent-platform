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
  regrantFsGrantAccess,
  listFsGrantEntries,
  readFsGrantFile,
  writeFsGrantFile,
  scanFsGrantManifest,
  searchFsGrantFiles,
  watchFsGrant,
  unwatchFsGrant,
  getActiveFsWatchers,
  cleanRelativePath,
  MAX_FS_LIST_ENTRIES,
  MAX_FS_PATH_DEPTH,
  MAX_FS_READ_BYTES,
  MAX_FS_TEXT_DECODE_BYTES,
  MAX_FS_WRITE_BYTES,
  MAX_FS_SCAN_ENTRIES,
  MAX_FS_SCAN_BYTES,
  MAX_FS_SEARCH_RESULTS,
  MAX_FS_SEARCH_SCANNED,
  computeSha256,
} from "../extension/lib/fs-grants.js";
import {
  SETTINGS_SECTIONS,
  OPTIONS_PRODUCT_HASHES,
  normalizeSettingsSectionId,
} from "../extension/lib/pure.js";
import { createFsGrantRoutes } from "../extension/background/routes/fs-grants.js";
import {
  canonicalField,
  canonicalOperationTarget,
  canonicalRecord,
  canonicalScalar,
  payloadDigest,
} from "../extension/lib/owner-approval.js";

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

Deno.test("routes/fs-grants.js: every fs-grant route is registered through the module and gated to owner-options / extension; the SW keeps no inline copy", async () => {
  const sw = await Deno.readTextFile(
    new URL("../extension/background/service-worker.js", import.meta.url),
  );
  const routesSrc = await Deno.readTextFile(
    new URL("../extension/background/routes/fs-grants.js", import.meta.url),
  );
  for (const route of ["list", "get", "remove", "list-entries", "search", "read-file", "write-file", "scan", "grep", "write-file-approved"]) {
    assert(
      routesSrc.includes(`async "fs-grant.${route}"`),
      `routes/fs-grants.js must register fs-grant.${route}`,
    );
    assertEquals(
      sw.includes(`async "fs-grant.${route}"`),
      false,
      `service-worker.js must not keep an inline fs-grant.${route} handler (the module is the single source)`,
    );
  }
  assert(
    sw.includes("const fsGrantRoutes = createFsGrantRoutes({") && /mergeRouteMaps\([\s\S]*?fsGrantRoutes,/.test(sw),
    "service worker must compose the fs-grant routes from createFsGrantRoutes",
  );
  // Principal gating (owner-options or extension) lives in the module.
  assert(
    routesSrc.includes('const OWNER_SURFACES = new Set(["owner-options", "extension"]);'),
    "routes/fs-grants.js must gate fs-grant routes against non-extension / non-owner callers",
  );
  // The model's write path is the approved route and only that route.
  assert(
    routesSrc.includes('if (context?.principal !== "model") {'),
    "fs-grant.write-file-approved must accept only the model principal",
  );
  const routes: any = createFsGrantRoutes({
    securityEvent: () => {},
    requireOwnerApproval: async () => ({ ok: false }),
    canonicalOperationTarget: () => "",
    payloadFields: () => ({}),
    lineDiffSummary: () => ({ added: 0, removed: 0 }),
  });
  for (const route of ["list", "remove", "list-entries", "search", "read-file", "write-file", "scan", "grep"]) {
    const res = await routes[`fs-grant.${route}`]({ grantId: "fsg_x", query: "x", relativePath: "x" }, { principal: "model" });
    assertEquals(res?.ok, false, `fs-grant.${route} must refuse the model principal`);
    assert(String(res?.error).includes("restricted to extension surfaces"));
  }
});

Deno.test("cleanRelativePath: normalizes paths and rejects traversal attacks (..) and leading slash", () => {
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

  let absoluteThrown = false;
  try {
    cleanRelativePath("/etc/passwd");
  } catch (err: any) {
    absoluteThrown = true;
    assert(err.message.includes("invalid_path_absolute"));
  }
  assertEquals(absoluteThrown, true, "leading / absolute path must throw");
});

Deno.test("regrantFsGrantAccess: prompt -> requestPermission -> granted updates store timestamp", async () => {
  let requestedMode = "";
  const mockHandle = {
    kind: "directory",
    name: "resumed-folder",
    queryPermission: async () => "prompt",
    requestPermission: async ({ mode }: { mode: string }) => {
      requestedMode = mode;
      return "granted";
    },
  };

  await saveFsGrant({
    grantId: "fsg_regrant_ok",
    handle: mockHandle,
    name: "resumed-folder",
    mode: "readwrite",
    createdAt: 1000,
    lastUsedAt: 1000,
  });

  const res = await regrantFsGrantAccess("fsg_regrant_ok", { isTrusted: true });
  assertEquals(res.ok, true);
  assertEquals(res.status, "granted");
  assertEquals(requestedMode, "readwrite", "requestPermission must receive grant access mode");

  const updated = await getFsGrant("fsg_regrant_ok");
  assert(updated);
  assert(updated.lastUsedAt > 1000, "lastUsedAt must be updated upon successful re-grant");
});

Deno.test("regrantFsGrantAccess: prompt -> requestPermission -> denied returns denied status", async () => {
  const mockHandle = {
    kind: "directory",
    name: "denied-folder",
    queryPermission: async () => "prompt",
    requestPermission: async () => "denied",
  };

  await saveFsGrant({
    grantId: "fsg_regrant_denied",
    handle: mockHandle,
    name: "denied-folder",
  });

  const res = await regrantFsGrantAccess("fsg_regrant_denied", { isTrusted: true });
  assertEquals(res.ok, true);
  assertEquals(res.status, "denied");
});

Deno.test("regrantFsGrantAccess: requires owner gesture (untrusted click rejected)", async () => {
  const mockHandle = {
    kind: "directory",
    name: "gesture-test",
    requestPermission: async () => "granted",
  };

  await saveFsGrant({
    grantId: "fsg_gesture_test",
    handle: mockHandle,
    name: "gesture-test",
  });

  const res = await regrantFsGrantAccess("fsg_gesture_test", { isTrusted: false });
  assertEquals(res.ok, false);
  assertEquals(res.error, "owner_gesture_required");
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

Deno.test("searchFsGrantFiles: recursively matches names, bounds results, and reports lapsed permission", async () => {
  const matchingFile = (name: string, size = 12, type = "text/plain") => ({
    kind: "file",
    name,
    getFile: async () => ({ name, size, type, lastModified: 1700000000000 }),
  });
  const nested = {
    kind: "directory",
    name: "notes",
    values: async function* () {
      yield matchingFile("unique-fs-search-report.md", 37, "text/markdown");
      yield matchingFile("other.bin", 8, "application/octet-stream");
    },
  };
  const root = {
    kind: "directory",
    name: "search-root",
    queryPermission: async () => "granted",
    values: async function* () { yield nested; },
  };
  const lapsed = {
    kind: "directory",
    name: "search-lapsed",
    queryPermission: async () => "prompt",
  };
  await saveFsGrant({ grantId: "fsg_search_root", handle: root, name: root.name });
  await saveFsGrant({ grantId: "fsg_search_lapsed", handle: lapsed, name: lapsed.name });
  await saveFsGrant({
    grantId: "fsg_search_other_task",
    handle: {
      kind: "directory",
      name: "private-task-folder",
      queryPermission: async () => "granted",
      values: async function* () { yield matchingFile("unique-fs-search-private.txt"); },
    },
    name: "private-task-folder",
    scope: { taskId: "different-task" },
  });

  const res = await searchFsGrantFiles("unique-fs-search", { limit: 50 });
  assertEquals(res.ok, true);
  assertEquals(res.files.length, 1, "a task-scoped handle must not leak into global composer search");
  assertEquals(res.files[0], {
    grantId: "fsg_search_root",
    folderName: "search-root",
    relativePath: "notes/unique-fs-search-report.md",
    name: "unique-fs-search-report.md",
    size: 37,
    type: "text/markdown",
    lastModified: 1700000000000,
  });
  assert(res.permissionIssues.some((issue) => issue.grantId === "fsg_search_lapsed" && issue.status === "prompt"));
  assertEquals(MAX_FS_SEARCH_RESULTS, 50);
  assertEquals(MAX_FS_SEARCH_SCANNED, 5000);

  const capped = await searchFsGrantFiles("", { limit: 1 });
  assertEquals(capped.files.length, 1);
  assertEquals(capped.truncated, true);
});

Deno.test("readFsGrantFile: reads text with SHA-256 digest — complete content whatever the size (no fs_file_too_large read refusal)", async () => {
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

  const res: any = await readFsGrantFile("fsg_read_test", { asText: true });
  assertEquals(res.ok, true);
  assertEquals(res.name, "greeting.txt");
  assertEquals(res.size, fileBytes.byteLength);
  assertEquals(res.content, fileContent);
  assert(typeof res.sha256 === "string" && res.sha256.length === 64, "must include 64-char SHA-256 hex digest");

  // A read is never refused on size alone (the legacy maxBytes bound was a
  // caller-side transport knob — a 2000-byte default once refused a 9080-byte
  // README with fs_file_too_large). A tiny bound must not truncate or refuse:
  // the complete content comes back and the caller pages with offset/length.
  const notCapped: any = await readFsGrantFile("fsg_read_test", { asText: true, maxBytes: 2 });
  assertEquals(notCapped.ok, true, `size alone must never refuse a handle-backed read: ${JSON.stringify(notCapped)}`);
  assertEquals(notCapped.content, fileContent);
});

Deno.test("readFsGrantFile: the owner repro shape — a 9080-byte file reads completely even past maxBytes 2000", async () => {
  // chrome-agent-platform-jb0a: read_file on cairn-gateway/README.md (9080
  // bytes) was refused with fs_file_too_large at maxBytes 2000. The read is
  // local; size is irrelevant to it, so the COMPLETE file must come back.
  const head = "cairn-gateway/README.md\n";
  const reproText = head + "x".repeat(9080 - head.length);
  const reproBytes = new TextEncoder().encode(reproText);
  assertEquals(reproBytes.byteLength, 9080, "fixture must reproduce the exact 9080-byte shape");

  const mockFileHandle = {
    kind: "file",
    name: "README.md",
    queryPermission: async () => "granted",
    getFile: async () => ({
      name: "README.md",
      size: reproBytes.byteLength,
      lastModified: 1700000000000,
      arrayBuffer: async () => reproBytes.buffer.slice(reproBytes.byteOffset, reproBytes.byteOffset + reproBytes.byteLength),
    }),
  };
  await saveFsGrant({ grantId: "fsg_read_repro", handle: mockFileHandle, name: "README.md", kind: "file" });

  const whole: any = await readFsGrantFile("fsg_read_repro", { asText: true, maxBytes: 2000 });
  assertEquals(whole.ok, true, `the 9080-byte README must read, not be refused: ${JSON.stringify(whole)}`);
  assertEquals(whole.size, 9080);
  assertEquals(whole.content, reproText, "the COMPLETE 9080 bytes come back — no truncation, no fs_file_too_large");
  assert(typeof whole.sha256 === "string" && whole.sha256.length === 64, "whole-file read stays digest-pinned");
  assertEquals(whole.start, undefined, "a whole-file read carries no window markers");
  assertEquals(whole.end, undefined);
});

Deno.test("readFsGrantFile: a multi-MB file reads fully via offset/length chunking — windowed reads are never size-refused", async () => {
  // A >10 MiB file pages through offset/length windows of any size; each
  // window is digest-pinned and reports { start, end, size } so the caller can
  // walk to EOF. size alone must never produce a refusal.
  const chunk = 1024 * 1024;
  const total = 10 * 1024 * 1024 + 123; // just past the single-read ceiling
  const bigBytes = new TextEncoder().encode("y".repeat(total));
  const view = (b: Uint8Array, s: number, e: number) => ({
    arrayBuffer: async () => b.subarray(s, e).slice().buffer,
  });
  const mockFileHandle = {
    kind: "file",
    name: "big.log",
    queryPermission: async () => "granted",
    getFile: async () => ({
      name: "big.log",
      size: bigBytes.byteLength,
      lastModified: 1700000000000,
      arrayBuffer: async () => bigBytes.subarray(0, bigBytes.byteLength).slice().buffer,
      slice: (s: number, e: number) => view(bigBytes, s, e),
    }),
  };
  await saveFsGrant({ grantId: "fsg_read_big", handle: mockFileHandle, name: "big.log", kind: "file" });

  const wholeFileRead: any = await readFsGrantFile("fsg_read_big", { asText: true });
  assertEquals(wholeFileRead.ok, true, "a whole-file read above any ceiling is never a refusal or a notice");
  assertEquals(
    wholeFileRead.content,
    "y".repeat(total),
    "over-ceiling whole reads return the COMPLETE content — no guidance placeholder may ever stand in for requested bytes",
  );
  assertEquals(wholeFileRead.size, total);
  assertEquals(wholeFileRead.truncated, false, "nothing was withheld, so truncated:false is truthful");
  assert(
    typeof wholeFileRead.sha256 === "string" && wholeFileRead.sha256.length === 64,
    "the whole-file read is digest-pinned over its real content",
  );

  const pieces: string[] = [];
  for (let offset = 0; offset < total; offset += chunk) {
    const res: any = await readFsGrantFile("fsg_read_big", { asText: true, offset, length: chunk });
    assertEquals(res.ok, true, `window at ${offset} must read: ${JSON.stringify(res)}`);
    assertEquals(res.start, offset);
    assertEquals(res.end, Math.min(total, offset + chunk));
    assertEquals(res.size, total);
    assertEquals(res.content, "y".repeat(res.end - offset), "window content matches the byte range");
    assert(typeof res.sha256 === "string" && res.sha256.length === 64, "every window is digest-pinned");
    pieces.push(res.content);
  }
  assertEquals(pieces.join("").length, total, "chunked reads reassemble the whole file");

  // A single window larger than the old text-decode ceiling (2 MiB) delivers
  // its complete content too — the ceiling lived in the reader and is gone;
  // only the tool's transport cap (MAX_FS_READ_BYTES per window) remains.
  const wideLen = MAX_FS_TEXT_DECODE_BYTES + 1;
  const wide: any = await readFsGrantFile("fsg_read_big", { asText: true, offset: 0, length: wideLen });
  assertEquals(wide.ok, true, `a ${wideLen}-byte window must read: ${JSON.stringify(wide)}`);
  assertEquals(wide.start, 0);
  assertEquals(wide.end, wideLen);
  assertEquals(wide.content, "y".repeat(wideLen), "an over-2 MiB window returns its complete content, never a notice");
  assertEquals(wide.truncated, false);
  assert(typeof wide.sha256 === "string" && wide.sha256.length === 64, "the wide window is digest-pinned");
});

Deno.test("readFsGrantFile: byte windows that split multi-byte UTF-8 characters return whole characters, never fs_file_not_text", async () => {
  // P1-2 falsification: the old code decoded each arbitrary byte window with a
  // fatal TextDecoder, so any window edge landing inside a multi-byte sequence
  // (a continuation byte alone, or a truncated lead) failed valid text as
  // fs_file_not_text. The reader now aligns windows to whole characters and
  // reports the actual byte span in start/end; content must byte-exactly match
  // the disclosed span (whole characters only — no replacement, no dropped
  // bytes). RED pre-fix: every continuation-byte window returned fs_file_not_text.
  const fileText = "é€5 — 日本語 ☃\nfin";
  const bytes = new TextEncoder().encode(fileText);
  const mockFileHandle = {
    kind: "file",
    name: "multibyte.txt",
    queryPermission: async () => "granted",
    getFile: async () => ({
      name: "multibyte.txt",
      size: bytes.byteLength,
      lastModified: 1700000000000,
      arrayBuffer: async () => bytes.subarray(0, bytes.byteLength).slice().buffer,
      slice: (s: number, e: number) => ({ arrayBuffer: async () => bytes.subarray(s, e).slice().buffer }),
    }),
  };
  await saveFsGrant({ grantId: "fsg_read_mb", handle: mockFileHandle, name: "multibyte.txt", kind: "file" });
  const eqBytes = (a: Uint8Array, b: Uint8Array) => {
    if (a.byteLength !== b.byteLength) return false;
    for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
    return true;
  };
  try {
    // Every single-byte window in the file must succeed (valid UTF-8 text) and
    // must come back as exactly the whole characters covering that byte.
    for (let off = 0; off < bytes.byteLength; off++) {
      const r: any = await readFsGrantFile("fsg_read_mb", { asText: true, offset: off, length: 1 });
      assertEquals(r.ok, true, `1-byte window at byte ${off} must not fail valid text: ${JSON.stringify(r)}`);
      assertEquals(r.size, bytes.byteLength);
      assert(r.start <= off && r.end > off && r.end <= bytes.byteLength, `span ${r.start}..${r.end} covers byte ${off}`);
      assert(
        eqBytes(new TextEncoder().encode(r.content), bytes.subarray(r.start, r.end)),
        `content at ${r.start}..${r.end} is exactly those whole characters: ${JSON.stringify(r.content)}`,
      );
      assert(
        typeof r.sha256 === "string" && r.sha256.length === 64,
        "the returned span is digest-pinned",
      );
    }

    // A pager that follows res.end walks whole characters: no gaps, no
    // overlaps, and the pieces reassemble the complete text.
    const pieces: string[] = [];
    let pos = 0;
    while (pos < bytes.byteLength) {
      const r: any = await readFsGrantFile("fsg_read_mb", { asText: true, offset: pos, length: 5 });
      assertEquals(r.ok, true, `paged window at ${pos} must read: ${JSON.stringify(r)}`);
      assertEquals(r.start, pos, "following res.end always lands on a character boundary");
      assert(eqBytes(new TextEncoder().encode(r.content), bytes.subarray(r.start, r.end)), "each page is whole characters");
      pieces.push(r.content);
      if (r.end <= pos) break; // defensive: an empty page must not spin
      pos = r.end;
    }
    assertEquals(pieces.join(""), fileText, "pages reassemble the complete text");

    // Literal split shapes on the leading é (bytes c3 a9): a window that
    // starts on the continuation byte and one that ends on the lead byte both
    // resolve to the whole character with the honest span.
    const tail: any = await readFsGrantFile("fsg_read_mb", { asText: true, offset: 1, length: 1 });
    assertEquals(tail.ok, true);
    assertEquals(tail.start, 0);
    assertEquals(tail.end, 2);
    assertEquals(tail.content, "é");
    const leadOnly: any = await readFsGrantFile("fsg_read_mb", { asText: true, offset: 0, length: 1 });
    assertEquals(leadOnly.ok, true);
    assertEquals(leadOnly.start, 0);
    assertEquals(leadOnly.end, 2);
    assertEquals(leadOnly.content, "é");
  } finally {
    await deleteFsGrant("fsg_read_mb");
  }
});

Deno.test("readFsGrantFile: mislabelled .txt binary bytes fail closed instead of becoming replacement text", async () => {
  for (const [grantId, bytes] of [
    ["fsg_binary_utf8", new Uint8Array([0x66, 0x6f, 0x80])],
    ["fsg_binary_control", new Uint8Array([0x66, 0x00, 0x6f])],
  ] as const) {
    await saveFsGrant({
      grantId,
      name: "mislabelled.txt",
      kind: "file",
      handle: {
        kind: "file",
        name: "mislabelled.txt",
        queryPermission: async () => "granted",
        getFile: async () => ({
          name: "mislabelled.txt",
          size: bytes.byteLength,
          arrayBuffer: async () => bytes.buffer,
        }),
      },
    });
    const res: any = await readFsGrantFile(grantId, { asText: true });
    assertEquals(res.ok, false);
    assertEquals(res.error, "fs_file_not_text");
  }
});

Deno.test("writeFsGrantFile: mode gate blocks write on read-only grant", async () => {
  const mockHandle = {
    kind: "directory",
    name: "ro-folder",
    queryPermission: async () => "granted",
  };

  await saveFsGrant({
    grantId: "fsg_ro_write",
    handle: mockHandle,
    name: "ro-folder",
    mode: "read",
  });

  const res = await writeFsGrantFile("fsg_ro_write", {
    relativePath: "test.txt",
    content: "hello",
  });
  assertEquals(res.ok, false);
  assertEquals(res.error, "fs_write_permission_denied");
});

Deno.test("writeFsGrantFile: writes content to readwrite grant and computes SHA-256", async () => {
  let writtenBytes: Uint8Array | null = null;
  let closed = false;

  const mockWritable = {
    write: async (b: Uint8Array) => {
      writtenBytes = b;
    },
    close: async () => {
      closed = true;
    },
  };

  const mockFileHandle = {
    kind: "file",
    name: "notes.txt",
    createWritable: async () => mockWritable,
  };

  const mockDirHandle = {
    kind: "directory",
    name: "rw-project",
    queryPermission: async () => "granted",
    getFileHandle: async (name: string, { create }: { create?: boolean } = {}) => {
      assertEquals(name, "notes.txt");
      assertEquals(create, true);
      return mockFileHandle;
    },
  };

  await saveFsGrant({
    grantId: "fsg_rw_write",
    handle: mockDirHandle,
    name: "rw-project",
    mode: "readwrite",
  });

  const res = await writeFsGrantFile("fsg_rw_write", {
    relativePath: "notes.txt",
    content: "Project notes data",
  });

  assertEquals(res.ok, true);
  assertEquals(res.written, true);
  assertEquals(res.name, "notes.txt");
  assertEquals(res.size, 18);
  assert(writtenBytes);
  assertEquals(closed, true);
  assert(typeof res.sha256 === "string" && res.sha256.length === 64);
});

Deno.test("writeFsGrantFile: enforces MAX_FS_WRITE_BYTES size cap", async () => {
  const mockDirHandle = {
    kind: "directory",
    name: "rw-project",
    queryPermission: async () => "granted",
  };

  await saveFsGrant({
    grantId: "fsg_rw_oversized",
    handle: mockDirHandle,
    name: "rw-project",
    mode: "readwrite",
  });

  const oversized = new Uint8Array(MAX_FS_WRITE_BYTES + 1024);
  const res = await writeFsGrantFile("fsg_rw_oversized", {
    relativePath: "big.bin",
    content: oversized,
  });

  assertEquals(res.ok, false);
  assertEquals(res.error, "fs_file_too_large");
});

Deno.test("scanFsGrantManifest: recursively scans directories with depth and entry bounds", async () => {
  const mockSubDir = {
    kind: "directory",
    name: "sub",
    values: async function* () {
      yield {
        kind: "file",
        name: "subfile.txt",
        getFile: async () => ({ size: 50, lastModified: 1700000000000 }),
      };
    },
  };

  const mockRootDir = {
    kind: "directory",
    name: "root",
    queryPermission: async () => "granted",
    values: async function* () {
      yield {
        kind: "file",
        name: "rootfile.txt",
        getFile: async () => ({ size: 100, lastModified: 1700000000000 }),
      };
      yield mockSubDir;
    },
  };

  await saveFsGrant({
    grantId: "fsg_scan_test",
    handle: mockRootDir,
    name: "root",
  });

  const res = await scanFsGrantManifest("fsg_scan_test");
  assertEquals(res.ok, true);
  assertEquals(res.entries?.length, 3);
  assertEquals(res.entries?.[0].path, "rootfile.txt");
  assertEquals(res.entries?.[1].path, "sub");
  assertEquals(res.entries?.[2].path, "sub/subfile.txt");
  assertEquals(res.truncated, false);
});

Deno.test("watchFsGrant: FileSystemObserver primary path delivers events and unwatch disconnects", async () => {
  let observerCallback: any = null;
  let observedHandle: any = null;
  let observedOptions: any = null;
  let disconnected = false;

  class MockFileSystemObserver {
    constructor(cb: any) {
      observerCallback = cb;
    }
    observe(handle: any, options: any) {
      observedHandle = handle;
      observedOptions = options;
    }
    unobserve() {}
    disconnect() {
      disconnected = true;
    }
  }

  const mockDirHandle = {
    kind: "directory",
    name: "watched-folder",
    queryPermission: async () => "granted",
  };

  await saveFsGrant({
    grantId: "fsg_watch_obs",
    handle: mockDirHandle,
    name: "watched-folder",
  });

  const fakeScope: any = { FileSystemObserver: MockFileSystemObserver };
  const deliveredEvents: any[] = [];

  const watchRes = await watchFsGrant(
    "fsg_watch_obs",
    (e) => {
      deliveredEvents.push(e);
    },
    { scope: fakeScope },
  );

  assertEquals(watchRes.ok, true);
  assertEquals(watchRes.type, "observer");
  assertEquals(observedHandle, mockDirHandle);
  assertEquals(observedOptions?.recursive, true);

  // Trigger platform callback
  observerCallback([
    {
      type: "modified",
      relativePathComponents: ["src", "app.js"],
    },
  ]);

  assertEquals(deliveredEvents.length, 1);
  assertEquals(deliveredEvents[0].grantId, "fsg_watch_obs");
  assertEquals(deliveredEvents[0].type, "modified");
  assertEquals(deliveredEvents[0].path, "src/app.js");

  // Verify unwatch
  assert(watchRes.unwatch);
  watchRes.unwatch();
  assertEquals(disconnected, true);
});

Deno.test("watchFsGrant: revocation automatically tears down active watcher", async () => {
  let disconnected = false;
  class MockFileSystemObserver {
    constructor() {}
    observe() {}
    disconnect() {
      disconnected = true;
    }
  }

  const mockDirHandle = {
    kind: "directory",
    name: "revoke-watch-folder",
    queryPermission: async () => "granted",
  };

  await saveFsGrant({
    grantId: "fsg_revoke_watch",
    handle: mockDirHandle,
    name: "revoke-watch-folder",
  });

  const fakeScope: any = { FileSystemObserver: MockFileSystemObserver };
  await watchFsGrant("fsg_revoke_watch", () => {}, { scope: fakeScope });

  assert(getActiveFsWatchers().includes("fsg_revoke_watch"));

  // Delete grant -> must tear down watcher
  await deleteFsGrant("fsg_revoke_watch");

  assertEquals(disconnected, true, "revocation must disconnect active observer");
  assertEquals(getActiveFsWatchers().includes("fsg_revoke_watch"), false);
});

Deno.test("options.js: wires renderLocalFolders and renders empty state or grant cards with re-grant and file viewer", async () => {
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
  assert(
    optionsJs.includes("Re-grant access"),
    "options.js must render Re-grant access button for prompt grants",
  );
  assert(
    optionsJs.includes("regrantFsGrantAccess"),
    "options.js must invoke regrantFsGrantAccess",
  );
  assert(
    optionsJs.includes("mountGrantBrowser"),
    "options.js must mount the folder-tree browser drawer (lib/folder-browser.js)",
  );
  const browserJs = await Deno.readTextFile(
    new URL("../extension/lib/folder-browser.js", import.meta.url),
  );
  assert(
    browserJs.includes("fs-file-viewer"),
    "lib/folder-browser.js must render the non-blocking inline file viewer",
  );
  assertEquals(
    optionsJs.includes("prompt("),
    false,
    "options.js must NOT use window.prompt for file viewing (N-2 modernization)",
  );
});

// ── CAP-FB-20260830-LOCAL-FILE-EDIT-TOOLS-01: the model's ONLY write path ────
// The model principal never reaches the raw `fs-grant.write-file` route. Its
// write path is `fs-grant.write-file-approved`, which fails closed on every
// boundary (grant, mode, path, size, binary) BEFORE staging the owner's diff
// card, binds the approval digest to the exact new content, writes only after
// Approve, and leaves the bytes untouched on Deny.
//
// Falsification: allow `principal:"model"` on the raw `fs-grant.write-file`
// route and "the model principal cannot call the raw route directly" goes RED.

const TYPO_TEXT = "Known local filesytem context from the browser KAT.\n";
const FIXED_TEXT = "Known local filesystem context from the browser KAT.\n";

// A functional in-memory directory handle whose files can be written through
// the native createWritable() shape, so the routes exercise the REAL
// readFsGrantFile / writeFsGrantFile paths end to end.
function memoryWriteFixture(files: Record<string, Uint8Array | string>) {
  const store = new Map<string, Uint8Array>();
  for (const [name, body] of Object.entries(files)) {
    store.set(name, typeof body === "string" ? new TextEncoder().encode(body) : body);
  }
  const writes: Array<{ name: string; bytes: Uint8Array }> = [];
  const fileHandleFor = (name: string) => ({
    kind: "file",
    name,
    getFile: async () => {
      const bytes = store.get(name)!;
      return {
        name,
        size: bytes.byteLength,
        lastModified: 1700000000000,
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      };
    },
    createWritable: async () => {
      let pending: Uint8Array | null = null;
      return {
        write: async (b: Uint8Array) => { pending = b; },
        close: async () => {
          if (pending) {
            store.set(name, new Uint8Array(pending));
            writes.push({ name, bytes: new Uint8Array(pending) });
          }
        },
      };
    },
  });
  const dir = {
    kind: "directory",
    name: "rw-project",
    queryPermission: async () => "granted",
    getDirectoryHandle: async (_name: string) => { throw new Error("NotFoundError"); },
    getFileHandle: async (name: string, opts: { create?: boolean } = {}) => {
      if (!store.has(name)) {
        if (!opts.create) throw new Error("NotFoundError");
        store.set(name, new Uint8Array(0));
      }
      return fileHandleFor(name);
    },
  };
  const sha = async (name: string) => {
    const b = store.get(name)!;
    return await computeSha256(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  };
  return { dir, store, writes, sha };
}

// A naive line diff for the stub deps: the real routes take the shipped diff
// core; the counts here only have to be right for one-line fixtures.
function naiveLineDiff(oldText: string, newText: string) {
  const a = String(oldText ?? "").split("\n");
  const b = String(newText ?? "").split("\n");
  return {
    added: b.filter((l) => !a.includes(l)).length,
    removed: a.filter((l) => !b.includes(l)).length,
    hunks: [],
  };
}

function fsRouteDeps(overrides: Record<string, unknown> = {}) {
  const events: Array<{ kind: string; message: string }> = [];
  const approvals: any[] = [];
  const deps: any = {
    securityEvent: (kind: string, message: string) => { events.push({ kind, message }); },
    requireOwnerApproval: async (context: any, action: string, target: string, payload: any, detail: any, stagedDetail: any) => {
      approvals.push({ context, action, target, payload, detail, stagedDetail });
      return { ok: true };
    },
    canonicalOperationTarget,
    payloadFields: (entries: Array<[string, unknown]>) =>
      canonicalRecord(...entries.map(([name, value]) => canonicalField(name, canonicalScalar(value)))),
    lineDiffSummary: naiveLineDiff,
    ...overrides,
  };
  return { deps, events, approvals, routes: createFsGrantRoutes(deps) as any };
}

const MODEL = { principal: "model", executionId: "exec:write-test", onApprovalEvent: () => {} };

Deno.test("fs-grant.write-file-approved: refuses a path outside the grant, a binary file, a lapsed/read-only/missing grant, and content over MAX_FS_WRITE_BYTES BEFORE staging any approval", async () => {
  const fx = memoryWriteFixture({ "notes.txt": TYPO_TEXT, "blob.bin": new Uint8Array([0x66, 0x00, 0x80]) });
  const grantId = `fsg_wa_bounds_${crypto.randomUUID()}`;
  await saveFsGrant({ grantId, handle: fx.dir, name: "rw-project", mode: "readwrite" });
  const roGrant = `fsg_wa_ro_${crypto.randomUUID()}`;
  await saveFsGrant({ grantId: roGrant, handle: fx.dir, name: "ro-project", mode: "read" });
  const lapsed = `fsg_wa_lapsed_${crypto.randomUUID()}`;
  await saveFsGrant({ grantId: lapsed, handle: { ...fx.dir, queryPermission: async () => "prompt" }, name: "lapsed", mode: "readwrite" });
  const { routes, approvals } = fsRouteDeps();
  const route = routes["fs-grant.write-file-approved"];
  assert(typeof route === "function", "the approved write route is registered");
  try {
    const cases: Array<[string, any, string]> = [
      ["traversal", { grantId, relativePath: "../escape.txt", content: "x" }, "invalid_path_traversal"],
      ["absolute", { grantId, relativePath: "/etc/passwd", content: "x" }, "invalid_path_absolute"],
      ["directory (no file name)", { grantId, relativePath: "", content: "x" }, "invalid_file_path"],
      ["binary file", { grantId, relativePath: "blob.bin", content: "text over binary" }, "fs_file_not_text"],
      ["oversized", { grantId, relativePath: "notes.txt", content: "a".repeat(MAX_FS_WRITE_BYTES + 1) }, "fs_file_too_large"],
      ["read-only grant", { grantId: roGrant, relativePath: "notes.txt", content: FIXED_TEXT }, "fs_write_permission_denied"],
      ["lapsed grant", { grantId: lapsed, relativePath: "notes.txt", content: FIXED_TEXT }, "fs_permission_lapsed"],
      ["missing grant", { grantId: `fsg_absent_${crypto.randomUUID()}`, relativePath: "notes.txt", content: FIXED_TEXT }, "grant_not_found"],
      ["non-string content", { grantId, relativePath: "notes.txt", content: 42 }, "invalid_content"],
    ];
    for (const [label, body, code] of cases) {
      const res = await route(body, MODEL);
      assertEquals(res?.ok, false, `${label}: must fail closed`);
      assert(String(res?.error ?? "").startsWith(code), `${label}: expected ${code}, got ${JSON.stringify(res)}`);
    }
    assertEquals(approvals.length, 0, "no boundary failure may reach the approval gate (nothing is staged)");
    assertEquals(fx.writes.length, 0, "nothing was written");
    assertEquals(new TextDecoder().decode(fx.store.get("notes.txt")!), TYPO_TEXT);
  } finally {
    await deleteFsGrant(grantId);
    await deleteFsGrant(roGrant);
    await deleteFsGrant(lapsed);
  }
});

Deno.test("fs-grant.write-file: the model principal cannot call the raw route directly (only the approved route, which pays the card)", async () => {
  const fx = memoryWriteFixture({ "notes.txt": TYPO_TEXT });
  const grantId = `fsg_raw_${crypto.randomUUID()}`;
  await saveFsGrant({ grantId, handle: fx.dir, name: "rw-project", mode: "readwrite" });
  const { routes, approvals, events } = fsRouteDeps();
  try {
    for (const principal of ["model", "page", "content-script", undefined]) {
      const res = await routes["fs-grant.write-file"]({ grantId, relativePath: "notes.txt", content: "pwned" }, { principal });
      assertEquals(res?.ok, false, `raw write-file must refuse principal ${String(principal)}`);
      assert(String(res?.error ?? "").includes("restricted to extension surfaces"), JSON.stringify(res));
    }
    assertEquals(fx.writes.length, 0, "the raw route never wrote for a non-owner principal");
    assertEquals(new TextDecoder().decode(fx.store.get("notes.txt")!), TYPO_TEXT);
    assert(events.some((e) => e.kind === "blocked-action" && /write-file denied for principal model/.test(e.message)), "the refusal is audited");
    // The approved route is the model's path and nobody else's: a page sender
    // or an owner surface cannot drive it (the owner surfaces have the raw route).
    for (const principal of ["page", "content-script", "extension", "owner-options", undefined]) {
      const res = await routes["fs-grant.write-file-approved"]({ grantId, relativePath: "notes.txt", content: FIXED_TEXT }, { principal });
      assertEquals(res?.ok, false, `approved route must refuse principal ${String(principal)}`);
    }
    assertEquals(approvals.length, 0, "a non-model principal never reaches the approval gate");
    // Control: the owner surface's raw route still writes (Settings' own path).
    const owner = await routes["fs-grant.write-file"]({ grantId, relativePath: "notes.txt", content: FIXED_TEXT }, { principal: "owner-options" });
    assertEquals(owner?.ok, true);
    assertEquals(fx.writes.length, 1);
  } finally {
    await deleteFsGrant(grantId);
  }
});

Deno.test("fs-grant.write-file-approved: Deny leaves the file bytes unchanged (sha256) and the card was staged with the on-disk bytes as before", async () => {
  const fx = memoryWriteFixture({ "notes.txt": TYPO_TEXT });
  const grantId = `fsg_deny_${crypto.randomUUID()}`;
  await saveFsGrant({ grantId, handle: fx.dir, name: "rw-project", mode: "readwrite" });
  const { routes, approvals } = fsRouteDeps({
    requireOwnerApproval: async (context: any, action: string, target: string, payload: any, detail: any, stagedDetail: any) => {
      approvals.push({ context, action, target, payload, detail, stagedDetail });
      return { ok: false, approvalDenied: true, error: "The owner denied fs.write; the action was not performed." };
    },
  });
  try {
    const before = await fx.sha("notes.txt");
    const res = await routes["fs-grant.write-file-approved"]({ grantId, relativePath: "notes.txt", content: FIXED_TEXT }, MODEL);
    assertEquals(res?.ok, false);
    assertEquals(res?.approvalDenied, true);
    assertEquals(await fx.sha("notes.txt"), before, "Deny: the bytes on disk are byte-identical");
    assertEquals(fx.writes.length, 0);
    assertEquals(approvals.length, 1, "exactly one approval was requested");
    const a = approvals[0];
    assertEquals(a.action, "fs.write");
    assertEquals(a.context.principal, "model");
    assert(a.target.startsWith("fs:"), `target is the fs kind: ${a.target}`);
    assertEquals(a.target, canonicalOperationTarget("fs", { grantId, path: "notes.txt" }));
    assertEquals(a.detail, undefined, "no model-facing detail (the bodies stay behind the owner gate)");
    assertEquals(a.stagedDetail.kind, "fs.write");
    assertEquals(a.stagedDetail.name, "notes.txt");
    assertEquals(a.stagedDetail.oldContent, TYPO_TEXT, "before = the bytes on disk");
    assertEquals(a.stagedDetail.newContent, FIXED_TEXT, "after = the exact proposed content");
    assertEquals(a.stagedDetail.added, 1);
    assertEquals(a.stagedDetail.removed, 1);
  } finally {
    await deleteFsGrant(grantId);
  }
});

Deno.test("fs-grant.write-file-approved: Approve writes exactly the approved bytes and reports size, sha256, +added -removed; a new file stages an empty before", async () => {
  const fx = memoryWriteFixture({ "notes.txt": TYPO_TEXT });
  const grantId = `fsg_approve_${crypto.randomUUID()}`;
  await saveFsGrant({ grantId, handle: fx.dir, name: "rw-project", mode: "readwrite" });
  const { routes, approvals } = fsRouteDeps();
  try {
    const res = await routes["fs-grant.write-file-approved"]({ grantId, relativePath: "notes.txt", content: FIXED_TEXT }, MODEL);
    assertEquals(res?.ok, true, JSON.stringify(res));
    assertEquals(res.written, true);
    assertEquals(res.path, "notes.txt");
    assertEquals(res.size, new TextEncoder().encode(FIXED_TEXT).byteLength);
    assertEquals(res.added, 1);
    assertEquals(res.removed, 1);
    assertEquals(res.sha256, await computeSha256(new TextEncoder().encode(FIXED_TEXT).buffer));
    assertEquals(new TextDecoder().decode(fx.store.get("notes.txt")!), FIXED_TEXT);
    assertEquals(fx.writes.length, 1);
    // No file content in the model-facing result beyond what it sent.
    assertEquals("content" in res, false);
    assertEquals("oldContent" in res, false);

    const created = await routes["fs-grant.write-file-approved"]({ grantId, relativePath: "new.txt", content: "fresh\n" }, MODEL);
    assertEquals(created?.ok, true, JSON.stringify(created));
    assertEquals(approvals[1].stagedDetail.oldContent, "", "a new file stages an empty before");
    assertEquals(approvals[1].stagedDetail.added, 1);
    assertEquals(approvals[1].stagedDetail.removed, 0);
    assertEquals(new TextDecoder().decode(fx.store.get("new.txt")!), "fresh\n");
  } finally {
    await deleteFsGrant(grantId);
  }
});

Deno.test("fs-grant.write-file-approved: the approval payload is digest-bound to the exact new content (same target, different digest)", async () => {
  const fx = memoryWriteFixture({ "notes.txt": TYPO_TEXT });
  const grantId = `fsg_digest_${crypto.randomUUID()}`;
  await saveFsGrant({ grantId, handle: fx.dir, name: "rw-project", mode: "readwrite" });
  // Deny every time so the on-disk "before" is identical across the three calls.
  const { routes, approvals } = fsRouteDeps({
    requireOwnerApproval: async (context: any, action: string, target: string, payload: any, detail: any, stagedDetail: any) => {
      approvals.push({ context, action, target, payload, detail, stagedDetail });
      return { ok: false, approvalDenied: true, error: "denied" };
    },
  });
  try {
    await routes["fs-grant.write-file-approved"]({ grantId, relativePath: "notes.txt", content: FIXED_TEXT }, MODEL);
    await routes["fs-grant.write-file-approved"]({ grantId, relativePath: "notes.txt", content: FIXED_TEXT + "extra\n" }, MODEL);
    await routes["fs-grant.write-file-approved"]({ grantId, relativePath: "notes.txt", content: FIXED_TEXT }, MODEL);
    assertEquals(approvals.length, 3);
    assertEquals(approvals[0].target, approvals[1].target, "one file = one target");
    const d0 = await payloadDigest(approvals[0].payload);
    const d1 = await payloadDigest(approvals[1].payload);
    const d2 = await payloadDigest(approvals[2].payload);
    assert(d0 !== d1, "different content must produce a different approval digest");
    assertEquals(d0, d2, "the same content produces the same digest (an approval can be consumed by its exact retry)");
  } finally {
    await deleteFsGrant(grantId);
  }
});

Deno.test("fs-grant.write-file-approved: a file that changed while the card was pending is refused after Approve (nothing written)", async () => {
  const fx = memoryWriteFixture({ "notes.txt": TYPO_TEXT });
  const grantId = `fsg_changed_${crypto.randomUUID()}`;
  await saveFsGrant({ grantId, handle: fx.dir, name: "rw-project", mode: "readwrite" });
  const { routes } = fsRouteDeps({
    requireOwnerApproval: async () => {
      // Another writer changes the file while the owner is looking at the card.
      fx.store.set("notes.txt", new TextEncoder().encode("someone else wrote this\n"));
      return { ok: true };
    },
  });
  try {
    const res = await routes["fs-grant.write-file-approved"]({ grantId, relativePath: "notes.txt", content: FIXED_TEXT }, MODEL);
    assertEquals(res?.ok, false);
    assertEquals(res?.error, "fs_file_changed");
    assertEquals(fx.writes.length, 0, "the approved diff no longer matched the disk: nothing was written");
    assertEquals(new TextDecoder().decode(fx.store.get("notes.txt")!), "someone else wrote this\n");
  } finally {
    await deleteFsGrant(grantId);
  }
});
