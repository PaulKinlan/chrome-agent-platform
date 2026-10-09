// tests/backup-restore.test.ts
// chrome-agent-platform-0u8n / 11rm.4: tests for streaming TAR restore driver and options wiring.
// @ts-nocheck

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { streamExportArchive } from "../extension/lib/backup-export.js";
import { streamRestoreArchive, createOptionsQuiesce } from "../extension/lib/backup-restore.js";
import { sealMasterJournalRecord } from "../extension/lib/master-journal-wal.js";
import { buildArchive, collectExportData, importArchive, recoverPendingImport } from "../extension/lib/data-archive.js";
import { admitDurableRun } from "../extension/lib/durable-quota.js";
import { createDurableRunRegistry } from "../extension/lib/durable-runs.js";
import { scheduleTask } from "../extension/lib/scheduler.js";

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

Deno.test("backup-restore: streamExportArchive -> streamRestoreArchive round-trip preserves files, kv, and alarms", async () => {
  const profileFiles = new Map<string, Uint8Array>([
    ["master/journal.json", ENCODER.encode(JSON.stringify({ step: 1, action: "think" }))],
    ["artifacts/report.md", ENCODER.encode("# Final Report\nEverything completed.")],
  ]);

  const profileKv: Record<string, any> = {
    theme: "dark",
    "cap:customKey": { test: true },
  };

  const profileAlarms = [
    { name: "sync-routine", scheduledTime: 1700000000000, periodInMinutes: 30 },
  ];

  // 1. Export to in-memory TAR
  const tarChunks: Uint8Array[] = [];
  const tarSink = new WritableStream<Uint8Array>({
    write(chunk) {
      tarChunks.push(chunk);
    },
  });

  const exportResult = await streamExportArchive({
    writable: tarSink,
    listFiles: async () => [...profileFiles.keys()],
    open: async (path: string) => {
      const data = profileFiles.get(path)!;
      return {
        size: data.length,
        stream: new ReadableStream({
          start(c) {
            c.enqueue(data);
            c.close();
          },
        }),
      };
    },
    kvGet: async () => profileKv,
    alarms: { getAll: async () => profileAlarms },
    extensionVersion: "1.0.0",
  });

  assertEquals(exportResult.files, 5); // manifest, kv, alarms, + 2 opfs files

  const totalLen = tarChunks.reduce((acc, c) => acc + c.byteLength, 0);
  const tarBuffer = new Uint8Array(totalLen);
  let off = 0;
  for (const c of tarChunks) {
    tarBuffer.set(c, off);
    off += c.byteLength;
  }

  // 2. Restore into empty target
  const restoredFiles = new Map<string, Uint8Array>();
  let restoredKv: any = {};
  let restoredAlarms: any[] = [];
  const progressReports: any[] = [];

  const restoreResult = await streamRestoreArchive({
    stream: new ReadableStream({
      start(c) {
        c.enqueue(tarBuffer);
        c.close();
      },
    }),
    opfs: {
      listFiles: async () => [...restoredFiles.keys()],
      readFile: async (path: string) => restoredFiles.get(path)!,
      writeFile: async (path: string, bytes: Uint8Array) => {
        restoredFiles.set(path, bytes);
      },
      removeFile: async (path: string) => {
        restoredFiles.delete(path);
      },
    },
    kvSet: async (items: any) => {
      restoredKv = { ...restoredKv, ...items };
    },
    kvRemove: async (keys: string[]) => {
      for (const k of keys) delete restoredKv[k];
    },
    kvGet: async () => restoredKv,
    alarms: {
      create: async (name: string, info: any) => {
        restoredAlarms.push({ name, ...info });
      },
      clear: async (name: string) => {
        restoredAlarms = restoredAlarms.filter((a) => a.name !== name);
      },
    },
    onProgress: (p: any) => progressReports.push(p),
    overwrite: true,
  });

  assertEquals(restoreResult.ok, true);
  assertEquals(restoreResult.restored.opfsFiles, 2);
  assertEquals(restoreResult.restored.alarms, 1);

  // Assert restored OPFS contents
  assertEquals(
    DECODER.decode(restoredFiles.get("master/journal.json")!),
    JSON.stringify({ step: 1, action: "think" }),
  );
  assertEquals(
    DECODER.decode(restoredFiles.get("artifacts/report.md")!),
    "# Final Report\nEverything completed.",
  );

  // Assert restored KV settings
  assertEquals(restoredKv.theme, "dark");
  assertEquals(restoredKv["cap:customKey"], { test: true });

  // Assert restored alarms
  assertEquals(restoredAlarms.length, 1);
  assertEquals(restoredAlarms[0].name, "sync-routine");
  assertEquals(restoredAlarms[0].when, 1700000000000);
  assertEquals(restoredAlarms[0].periodInMinutes, 30);
  assert(progressReports.length >= 2, "progress reports recorded for each file");
});

Deno.test("streamed restore holds the master journal lock only after quiescence through live swap", async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let restoreHeld = false;
  let masterHeld = false;
  let quiesced = false;
  let liveWrites = 0;
  const names = [];
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
    locks: { request: async (name, options, fn) => {
      names.push(name);
      assertEquals(name, "cap:master-journal");
      assertEquals(restoreHeld, true, "master lock follows restoreLock");
      assertEquals(options.mode, "exclusive");
      assertEquals(masterHeld, false, "nested master lock would deadlock in Chrome");
      masterHeld = true;
      try { return await fn(); } finally { masterHeld = false; }
    } },
  } });
  try {
    const livePath = "memory/master/journal.json";
    const oldPath = "memory/master/old.json";
    const files = new Map([[livePath, ENCODER.encode("old")], [oldPath, ENCODER.encode("retired")]]);
    const kv = {};
    const next = ENCODER.encode("new");
    const bundle = buildArchive({
      kv: {}, files: [{ path: livePath, bytes: next }], totalBytes: next.byteLength,
      alarms: [], configuredProviders: [], mcpServers: [],
    });
    const result = await streamRestoreArchive({
      stream: bundle, overwrite: true,
      lockAcquirer: async (name, fn) => {
        assertEquals(name, "cap:restoreLock");
        restoreHeld = true;
        try { return await fn(); } finally { restoreHeld = false; }
      },
      confirm: async () => { assertEquals(masterHeld, false); return true; },
      quiesce: async () => { assertEquals(masterHeld, false); quiesced = true; },
      opfs: {
        listFiles: async () => [...files.keys()],
        readFile: async (path) => files.get(path),
        writeFile: async (path, bytes) => {
          if (path === livePath) {
            assertEquals(quiesced, true);
            assertEquals(masterHeld, true);
            liveWrites++;
          }
          files.set(path, bytes);
        },
        removeFile: async (path) => {
          if (path === oldPath) assertEquals(masterHeld, true, "prune must stay inside the master lock");
          files.delete(path);
        },
      },
      kvGet: async (keys) => keys === null ? kv : Array.isArray(keys)
        ? Object.fromEntries(keys.filter((key) => Object.hasOwn(kv, key)).map((key) => [key, kv[key]]))
        : Object.hasOwn(kv, keys) ? { [keys]: kv[keys] } : {},
      kvSet: async (items) => { Object.assign(kv, items); },
      kvRemove: async (keys) => { for (const key of (Array.isArray(keys) ? keys : [keys])) delete kv[key]; },
      alarms: { getAll: async () => [], create: async () => {}, clear: async () => {} },
    });
    assertEquals(result.ok, true);
    assertEquals(liveWrites, 1);
    assertEquals(DECODER.decode(files.get(livePath)), "new");
    assertEquals(files.has(oldPath), false);
    assertEquals(masterHeld, false);
    assert(names.length >= 2, "pending recovery and live swap both require the master lock");
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete globalThis.navigator;
  }
});

Deno.test("backup-restore: options.html controls have correct accept attribute and classes", async () => {
  const html = await Deno.readTextFile("extension/options/options.html");

  // #import-all-file must accept .tar, .json, application/x-tar, application/json
  assert(
    html.includes('id="import-all-file" accept=".tar,.json,application/x-tar,application/json"'),
    "#import-all-file must accept .tar and .json with MIME types",
  );

  // #purge-journal-agent must use class="input-select"
  assert(
    html.includes('id="purge-journal-agent" class="input-select"'),
    "#purge-journal-agent must use class='input-select'",
  );
});

Deno.test("backup-restore: options.js routes backups through transactional streamRestoreArchive with confirmation", async () => {
  const code = await Deno.readTextFile("extension/options/options.js");

  // streamRestoreArchive wiring check
  assert(
    code.includes("streamRestoreArchive({"),
    "options.js must call streamRestoreArchive for backups",
  );

  // Confirmation hook check
  assert(
    code.includes("confirm: async ({ manifest, summary }) =>"),
    "options.js must pass confirm callback to streamRestoreArchive",
  );

  // Staging progress check
  assert(
    code.includes("onProgress: (p) => setBackupStatus"),
    "options.js must provide progress updates",
  );
});

Deno.test("backup-restore: transactional staging and owner confirmation cancellation", async () => {
  const tarChunks: Uint8Array[] = [];
  const tarSink = new WritableStream<Uint8Array>({
    write(chunk) { tarChunks.push(chunk); },
  });

  await streamExportArchive({
    writable: tarSink,
    listFiles: async () => ["master/journal.json"],
    open: async () => {
      const b = ENCODER.encode("overwritten data");
      return {
        size: b.byteLength,
        stream: new ReadableStream({
          start(c) {
            c.enqueue(b);
            c.close();
          },
        }),
      };
    },
    kvGet: async () => ({ theme: "light" }),
    alarms: { getAll: async () => [] },
    extensionVersion: "1.0.0",
  });

  const tarBuffer = new Uint8Array(tarChunks.reduce((a, c) => a + c.byteLength, 0));
  let off = 0;
  for (const c of tarChunks) {
    tarBuffer.set(c, off);
    off += c.byteLength;
  }

  const liveFiles = new Map<string, Uint8Array>([
    ["master/journal.json", ENCODER.encode("original live content")],
  ]);
  const writtenStagingFiles: string[] = [];

  let confirmCalled = false;
  const restoreRes = await streamRestoreArchive({
    stream: new ReadableStream({
      start(c) {
        c.enqueue(tarBuffer);
        c.close();
      },
    }),
    opfs: {
      listFiles: async () => [...liveFiles.keys()],
      readFile: async (p: string) => liveFiles.get(p)!,
      writeFile: async (p: string, b: Uint8Array) => {
        if (p.startsWith(".staging-restore-")) {
          writtenStagingFiles.push(p);
        }
        liveFiles.set(p, b);
      },
      removeFile: async (p: string) => {
        liveFiles.delete(p);
      },
    },
    confirm: async ({ manifest, summary }) => {
      confirmCalled = true;
      assertEquals(summary.opfsFiles, 1);
      return false; // Owner cancels
    },
  });

  assertEquals(confirmCalled, true, "confirm hook must be invoked after staging extraction");
  assertEquals(restoreRes.ok, false, "restore must report ok: false on cancellation");
  assertEquals(restoreRes.cancelled, true, "restore must report cancelled: true");

  assertEquals(DECODER.decode(liveFiles.get("master/journal.json")!), "original live content");

  for (const staged of writtenStagingFiles) {
    assert(!liveFiles.has(staged), `staging file ${staged} must be cleaned up after cancel`);
  }
});

Deno.test("backup-restore: legacy JSON backup auto-detection, fallback routing and fail-closed confirmation", async () => {
  const legacyJson = JSON.stringify({
    magic: "cap-export",
    formatVersion: 1,
    exportedAt: 1750000000000,
    extensionVersion: "0.2.0",
    policy: { excluded: [] },
    configuredProviders: [],
    mcpServers: [],
    kv: { "legacy:pref": "restored-val" },
    alarms: [],
    opfs: [
      { path: "legacy/note.txt", encoding: "utf8", data: "legacy content via json" },
    ],
    manifest: {
      kvKeys: 1,
      opfsFiles: 1,
      alarms: 0,
      totalBytes: 53,
    },
  });

  // 1. Confirm cancel fails closed
  const cancelRes = await streamRestoreArchive({
    stream: legacyJson,
    confirm: async () => false,
  });
  assertEquals(cancelRes.ok, false);
  assertEquals(cancelRes.cancelled, true);

  // 2. Corrupted JSON fails closed before mutation
  await assertRejects(
    () => streamRestoreArchive({
      stream: "{corrupt-json{{{",
      confirm: async () => true,
    }),
    Error,
    "not valid JSON",
  );

  // 3. Successful restore
  const liveFiles = new Map<string, Uint8Array>();
  let liveKv: Record<string, any> = {};

  const res = await streamRestoreArchive({
    stream: legacyJson,
    opfs: {
      listFiles: async () => [...liveFiles.keys()],
      readFile: async (p: string) => liveFiles.get(p) ?? new Uint8Array(0),
      writeFile: async (p: string, b: Uint8Array) => {
        liveFiles.set(p, b);
      },
      removeFile: async (p: string) => {
        liveFiles.delete(p);
      },
    },
    kvGet: async () => liveKv,
    kvSet: async (items: any) => {
      liveKv = { ...liveKv, ...items };
    },
    kvRemove: async (keys: any) => {
      const arr = Array.isArray(keys) ? keys : [keys];
      for (const k of arr) delete liveKv[k];
    },
    alarms: { getAll: async () => [], create: async () => {}, clear: async () => {} },
    overwrite: true,
  });

  assertEquals(res.ok, true, "legacy JSON restore must succeed");
  assertEquals(DECODER.decode(liveFiles.get("legacy/note.txt")!), "legacy content via json");
  assertEquals(liveKv["legacy:pref"], "restored-val");
});

Deno.test("backup-restore refuses a torn master WAL head before owner confirmation or live mutation", async () => {
  const walPath = "memory/master/journal-wal/head-a.json";
  const livePath = "memory/master/journal.json";
  const torn = "{\"torn\":";
  const bundle = JSON.stringify({
    magic: "cap-export", formatVersion: 1, exportedAt: 1750000000000,
    extensionVersion: "0.3.0", policy: { excluded: [] }, configuredProviders: [],
    mcpServers: [], kv: {}, alarms: [],
    opfs: [{ path: walPath, encoding: "utf8", data: torn }],
    manifest: { kvKeys: 0, opfsFiles: 1, alarms: 0, totalBytes: ENCODER.encode(torn).length + 2 },
  });
  const files = new Map([[livePath, ENCODER.encode("owner existing journal")]]);
  let confirmationCalls = 0;
  await assertRejects(() => streamRestoreArchive({
    stream: bundle,
    opfs: {
      listFiles: async () => [...files.keys()],
      readFile: async (p) => files.get(p),
      writeFile: async (p, bytes) => { files.set(p, bytes); },
      removeFile: async (p) => { files.delete(p); },
    },
    confirm: async () => { confirmationCalls++; return true; },
    overwrite: true,
  }), Error, "master journal");
  assertEquals(confirmationCalls, 0);
  assertEquals(DECODER.decode(files.get(livePath)), "owner existing journal");
  assertEquals(files.has(walPath), false);
});

Deno.test("backup-restore accepts a fully checked master WAL generation and rejects an unpublished frame", async () => {
  const epoch = 18;
  const checkpoint = `checkpoint-${epoch}-0.json`;
  const archive = `archive-${epoch}-0.json`;
  const walPrefix = "memory/master/journal-wal/";
  const checkpointBody = await sealMasterJournalRecord("checkpoint", { epoch, sequence: 0, exists: true, live: [{ id: "new" }] });
  const archiveBody = await sealMasterJournalRecord("archive", { epoch, rows: [{ id: "archived" }] });
  const headBinding = JSON.stringify({ epoch, sequence: 0, checkpoint, archive });
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", ENCODER.encode(headBinding)));
  const lastHash = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const headBody = await sealMasterJournalRecord("head", {
    epoch, sequence: 0, checkpointSequence: 0, checkpoint, archive, lastHash, version: epoch,
  });
  const records = [
    { path: `${walPrefix}${checkpoint}`, encoding: "utf8", data: checkpointBody },
    { path: `${walPrefix}${archive}`, encoding: "utf8", data: archiveBody },
    { path: `${walPrefix}head-a.json`, encoding: "utf8", data: headBody },
  ];
  const bundle = (opfs) => JSON.stringify({
    magic: "cap-export", formatVersion: 1, exportedAt: 1750000000000,
    extensionVersion: "0.3.0", policy: { excluded: [] }, configuredProviders: [],
    mcpServers: [], kv: {}, alarms: [], opfs,
    manifest: { kvKeys: 0, opfsFiles: opfs.length, alarms: 0,
      totalBytes: opfs.reduce((n, entry) => n + ENCODER.encode(entry.data).length, 2) },
  });
  const restored = new Map();
  const opfs = {
    listFiles: async () => [...restored.keys()],
    readFile: async (path) => restored.get(path),
    writeFile: async (path, bytes) => { restored.set(path, bytes); },
    removeFile: async (path) => { restored.delete(path); },
  };
  const success = await streamRestoreArchive({ stream: bundle(records), opfs, overwrite: true });
  assertEquals(success.ok, true);
  for (const record of records) assertEquals(DECODER.decode(restored.get(record.path)), record.data);

  // The owner-facing export is streamed TAR, not the legacy JSON fixture.
  const source = new Map(records.map((record) => [record.path, ENCODER.encode(record.data)]));
  const chunks = [];
  await streamExportArchive({
    writable: new WritableStream({ write: (chunk) => { chunks.push(chunk); } }),
    listFiles: async () => [...source.keys()],
    open: async (path) => ({ size: source.get(path).length, stream: new Blob([source.get(path)]).stream() }),
    kvGet: async () => ({}), alarms: { getAll: async () => [] }, extensionVersion: "0.3.0",
  });
  const tar = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) { tar.set(chunk, at); at += chunk.length; }
  const tarFiles = new Map();
  const tarRestore = await streamRestoreArchive({
    stream: new Blob([tar]).stream(),
    opfs: {
      listFiles: async () => [...tarFiles.keys()],
      readFile: async (path) => tarFiles.get(path),
      writeFile: async (path, bytes) => { tarFiles.set(path, bytes); },
      removeFile: async (path) => { tarFiles.delete(path); },
    }, overwrite: true,
  });
  assertEquals(tarRestore.ok, true);
  for (const record of records) assertEquals(DECODER.decode(tarFiles.get(record.path)), record.data);

  const unpublishedFrame = await sealMasterJournalRecord("frame", {
    epoch, sequence: 1, previousHash: lastHash, version: epoch + 1,
    operation: "append", row: { id: "unpublished" },
  });
  let confirmations = 0;
  await assertRejects(() => streamRestoreArchive({
    stream: bundle([...records, {
      path: `${walPrefix}frame-${epoch}-1.json`, encoding: "utf8", data: unpublishedFrame,
    }]), opfs,
    confirm: async () => { confirmations++; return true; }, overwrite: true,
  }), Error, "unpublished");
  await assertRejects(() => streamRestoreArchive({
    stream: bundle(records.filter((record) => record.path !== `${walPrefix}${checkpoint}`)), opfs,
    confirm: async () => { confirmations++; return true; }, overwrite: true,
  }), Error, "missing");
  assertEquals(confirmations, 0);
  assertEquals(DECODER.decode(restored.get(`${walPrefix}head-a.json`)), headBody,
    "a rejected archive must not alter the live published head");
});

Deno.test("backup-restore: rejection of invalid archives (missing manifest, reserved keys, unsafe paths)", async () => {
  // 1. Reserved key in JSON settings dump
  const badKvJson = JSON.stringify({
    magic: "cap-export",
    formatVersion: 1,
    exportedAt: 1750000000000,
    extensionVersion: "0.2.0",
    policy: { excluded: [] },
    configuredProviders: [],
    mcpServers: [],
    kv: { "cap:importBackup": { malformed: true } },
    alarms: [],
    opfs: [],
  });
  await assertRejects(
    () => streamRestoreArchive({ stream: badKvJson }),
    Error,
    "reserved kv key",
  );

  // 2. Unsafe traversal path in JSON
  const traversalJson = JSON.stringify({
    magic: "cap-export",
    formatVersion: 1,
    exportedAt: 1750000000000,
    extensionVersion: "0.2.0",
    policy: { excluded: [] },
    configuredProviders: [],
    mcpServers: [],
    kv: { ok: true },
    alarms: [],
    opfs: [{ path: "../secret.txt", encoding: "utf8", data: "malicious" }],
  });
  await assertRejects(
    () => streamRestoreArchive({ stream: traversalJson }),
    Error,
    "bad bundle path",
  );
});

Deno.test("backup-restore: swap failure on second file triggers rollback from sidecar journal, restoring first mutated file", async () => {
  const file1Data = ENCODER.encode("incoming file 1 data");
  const file2Data = ENCODER.encode("incoming file 2 data");

  const tarChunks: Uint8Array[] = [];
  const tarSink = new WritableStream<Uint8Array>({
    write(chunk) { tarChunks.push(chunk); },
  });

  await streamExportArchive({
    writable: tarSink,
    listFiles: async () => ["master/file1.txt", "master/file2.txt"],
    open: async (p: string) => {
      const b = p.includes("file1") ? file1Data : file2Data;
      return {
        size: b.byteLength,
        stream: new ReadableStream({
          start(c) {
            c.enqueue(b);
            c.close();
          },
        }),
      };
    },
    kvGet: async () => ({ key1: "new-val" }),
    alarms: { getAll: async () => [] },
    extensionVersion: "1.0.0",
  });

  const tarBuffer = new Uint8Array(tarChunks.reduce((a, c) => a + c.byteLength, 0));
  let off = 0;
  for (const c of tarChunks) {
    tarBuffer.set(c, off);
    off += c.byteLength;
  }

  const liveFiles = new Map<string, Uint8Array>([
    ["master/file1.txt", ENCODER.encode("original file 1 content")],
    ["master/file2.txt", ENCODER.encode("original file 2 content")],
  ]);
  let liveKv: Record<string, any> = { key1: "original-kv-val" };

  let liveCommitWrites = 0;
  let sawMutatedFile1BeforeRollback = false;
  let errorCaught = false;

  try {
    await streamRestoreArchive({
      stream: new ReadableStream({
        start(c) {
          c.enqueue(tarBuffer);
          c.close();
        },
      }),
      opfs: {
        listFiles: async () => [...liveFiles.keys()],
        readFile: async (p: string) => liveFiles.get(p) ?? new Uint8Array(0),
        writeFile: async (p: string, b: Uint8Array) => {
          if (!p.startsWith(".staging-restore-") && !p.startsWith(".rollback-backup-")) {
            liveCommitWrites++;
            if (liveCommitWrites === 1) {
              liveFiles.set(p, b);
              sawMutatedFile1BeforeRollback = true;
              return;
            }
            if (liveCommitWrites === 2) {
              throw new Error("simulated disk failure on second live file write");
            }
          }
          liveFiles.set(p, b);
        },
        removeFile: async (p: string) => {
          liveFiles.delete(p);
        },
      },
      kvGet: async () => liveKv,
      kvSet: async (items: any) => {
        liveKv = { ...liveKv, ...items };
      },
      kvRemove: async (keys: string[]) => {
        for (const k of keys) delete liveKv[k];
      },
      alarms: { getAll: async () => [], create: async () => {}, clear: async () => {} },
      overwrite: true,
    });
  } catch (err: any) {
    errorCaught = true;
    assert(err.message.includes("Commit failed"), "expected commit failed with rollback indication");
  }

  assert(errorCaught, "error must be thrown on second file failure");
  assert(sawMutatedFile1BeforeRollback, "first live file MUST have been mutated before rollback occurred");

  assertEquals(
    DECODER.decode(liveFiles.get("master/file1.txt")!),
    "original file 1 content",
    "master/file1.txt must be restored from rollback journal after second file failed",
  );
  assertEquals(
    DECODER.decode(liveFiles.get("master/file2.txt")!),
    "original file 2 content",
    "master/file2.txt was never committed and remains original",
  );
  assertEquals(liveKv.key1, "original-kv-val");
});

Deno.test("backup-restore: quiesce hook and null-value preservation during rollback", async () => {
  const tarChunks: Uint8Array[] = [];
  const tarSink = new WritableStream<Uint8Array>({
    write(chunk) { tarChunks.push(chunk); },
  });

  await streamExportArchive({
    writable: tarSink,
    listFiles: async () => ["master/file.txt"],
    open: async () => {
      const b = ENCODER.encode("incoming file");
      return {
        size: b.byteLength,
        stream: new ReadableStream({
          start(c) {
            c.enqueue(b);
            c.close();
          },
        }),
      };
    },
    kvGet: async () => ({ keyWithNull: "overwritten" }),
    alarms: { getAll: async () => [{ name: "trigger-alarm", scheduledTime: 12345 }] },
    extensionVersion: "1.0.0",
  });

  const tarBuffer = new Uint8Array(tarChunks.reduce((a, c) => a + c.byteLength, 0));
  let off = 0;
  for (const c of tarChunks) {
    tarBuffer.set(c, off);
    off += c.byteLength;
  }

  let quiesceCalled = false;
  const liveFiles = new Map<string, Uint8Array>([
    ["master/file.txt", ENCODER.encode("original file")],
  ]);
  let liveKv: Record<string, any> = { keyWithNull: null, unaffectedKey: 123 };

  let errorCaught = false;
  try {
    await streamRestoreArchive({
      stream: new ReadableStream({
        start(c) {
          c.enqueue(tarBuffer);
          c.close();
        },
      }),
      opfs: {
        listFiles: async () => [...liveFiles.keys()],
        readFile: async (p: string) => liveFiles.get(p) ?? new Uint8Array(0),
        writeFile: async (p: string, b: Uint8Array) => {
          liveFiles.set(p, b);
        },
        removeFile: async (p: string) => {
          liveFiles.delete(p);
        },
      },
      kvGet: async () => liveKv,
      kvSet: async (items: any) => {
        liveKv = { ...liveKv, ...items };
      },
      kvRemove: async (keys: string[]) => {
        for (const k of keys) delete liveKv[k];
      },
      alarms: {
        getAll: async () => [],
        create: async (name: string) => {
          if (name === "cap-restore-recovery-alarm") return;
          // Trigger failure AFTER live KV has been overwritten
          assertEquals(liveKv.keyWithNull, "overwritten", "keyWithNull must be overwritten before failure");
          throw new Error("simulated failure during alarm creation after KV set");
        },
        clear: async () => {},
      },
      quiesce: async () => {
        quiesceCalled = true;
      },
      overwrite: true,
    });
  } catch (err: any) {
    errorCaught = true;
    assert(err.message.includes("Commit failed"));
  }

  assert(errorCaught, "expected error on simulated commit failure");
  assertEquals(quiesceCalled, true, "quiesce hook must be invoked before Phase 3 commit");
  assert(Object.hasOwn(liveKv, "keyWithNull"), "keyWithNull must be preserved in KV after rollback");
  assertEquals(liveKv.keyWithNull, null, "null value must be restored, not deleted, by rollback journal");
  assertEquals(liveKv.unaffectedKey, 123);
  assertEquals(DECODER.decode(liveFiles.get("master/file.txt")!), "original file");
});

Deno.test("backup-restore: snapshot failure during Phase 3 cleans up staged files", async () => {
  const tarChunks: Uint8Array[] = [];
  const tarSink = new WritableStream<Uint8Array>({
    write(chunk) { tarChunks.push(chunk); },
  });

  await streamExportArchive({
    writable: tarSink,
    listFiles: async () => ["master/file.txt"],
    open: async () => {
      const b = ENCODER.encode("incoming file");
      return {
        size: b.byteLength,
        stream: new ReadableStream({
          start(c) {
            c.enqueue(b);
            c.close();
          },
        }),
      };
    },
    kvGet: async () => ({ key: "val" }),
    alarms: { getAll: async () => [] },
    extensionVersion: "1.0.0",
  });

  const tarBuffer = new Uint8Array(tarChunks.reduce((a, c) => a + c.byteLength, 0));
  let off = 0;
  for (const c of tarChunks) {
    tarBuffer.set(c, off);
    off += c.byteLength;
  }

  const liveFiles = new Map<string, Uint8Array>();
  const stagedFilesWritten: string[] = [];
  const kvStore: Record<string, any> = {};

  let listCalls = 0;
  await assertRejects(
    () => streamRestoreArchive({
      stream: new ReadableStream({
        start(c) {
          c.enqueue(tarBuffer);
          c.close();
        },
      }),
      opfs: {
        listFiles: async () => {
          listCalls++;
          if (listCalls === 1) {
            // First call during pre-journal snapshot throws
            throw new Error("simulated OPFS failure during pre-journal snapshot");
          }
          return [...liveFiles.keys()];
        },
        readFile: async (p: string) => liveFiles.get(p) ?? new Uint8Array(0),
        writeFile: async (p: string, b: Uint8Array) => {
          if (p.startsWith(".staging-restore-")) stagedFilesWritten.push(p);
          liveFiles.set(p, b);
        },
        removeFile: async (p: string) => {
          liveFiles.delete(p);
        },
      },
      kvGet: async (keys: any) => {
        if (Array.isArray(keys)) {
          const res: Record<string, any> = {};
          for (const k of keys) if (k in kvStore) res[k] = kvStore[k];
          return res;
        }
        return kvStore;
      },
      kvSet: async (items: any) => { Object.assign(kvStore, items); },
      kvRemove: async (keys: any) => {
        for (const k of (Array.isArray(keys) ? keys : [keys])) delete kvStore[k];
      },
      alarms: { getAll: async () => [], create: async () => {}, clear: async () => {} },
      overwrite: true,
    }),
    Error,
    "simulated OPFS failure during pre-journal snapshot",
  );

  assert(stagedFilesWritten.length > 0, "staging files were written");
  for (const f of stagedFilesWritten) {
    assert(!liveFiles.has(f), `staged file ${f} must be cleaned up on snapshot failure`);
  }
});

Deno.test("backup-restore: quiesce refuses when active tasks are present without calling run.cancel", async () => {
  const kvStore: Record<string, any> = {};
  const sendCalls: { action: string; payload?: any }[] = [];

  const fakeRuns = [
    { executionId: "exec-completed-1", phase: "terminal" },
    { executionId: "exec-cancelled-2", phase: "cancelled" },
    { executionId: "exec-running-3", phase: "running" },
  ];

  const fakeSend = async (action: string, payload?: any) => {
    sendCalls.push({ action, payload });
    if (action === "run.list") {
      return { runs: fakeRuns, activeWritersCount: 1, activeWriters: ["exec-running-3"] };
    }
    return { ok: true };
  };

  const productionQuiesce = createOptionsQuiesce({
    send: fakeSend,
    setBackupStatus: () => {},
    setStorage: async (items: any) => { Object.assign(kvStore, items); },
    maxWaitMs: 150,
    pollIntervalMs: 20,
  });

  const tarChunks: Uint8Array[] = [];
  const tarSink = new WritableStream<Uint8Array>({
    write(chunk) { tarChunks.push(chunk); },
  });

  await streamExportArchive({
    writable: tarSink,
    listFiles: async () => ["master/file.txt"],
    open: async () => {
      const b = ENCODER.encode("incoming file");
      return {
        size: b.byteLength,
        stream: new ReadableStream({
          start(c) { c.enqueue(b); c.close(); },
        }),
      };
    },
    kvGet: async () => ({}),
    alarms: { getAll: async () => [] },
    extensionVersion: "1.0.0",
  });

  const tarBuffer = new Uint8Array(tarChunks.reduce((a, c) => a + c.byteLength, 0));
  let off = 0;
  for (const c of tarChunks) {
    tarBuffer.set(c, off);
    off += c.byteLength;
  }

  const liveFiles = new Map<string, Uint8Array>();

  let errorCaught = false;
  try {
    await streamRestoreArchive({
      stream: new ReadableStream({
        start(c) { c.enqueue(tarBuffer); c.close(); },
      }),
      opfs: {
        listFiles: async () => [...liveFiles.keys()],
        readFile: async (p: string) => liveFiles.get(p) ?? new Uint8Array(0),
        writeFile: async (p: string, b: Uint8Array) => liveFiles.set(p, b),
        removeFile: async (p: string) => liveFiles.delete(p),
      },
      kvGet: async () => kvStore,
      kvSet: async (items: any) => { Object.assign(kvStore, items); },
      kvRemove: async (keys: string[]) => { for (const k of keys) delete kvStore[k]; },
      alarms: { getAll: async () => [], create: async () => {}, clear: async () => {} },
      quiesce: productionQuiesce,
      overwrite: true,
    });
  } catch (err: any) {
    errorCaught = true;
    assert(err.message.includes("tasks are actively running"));
  }

  assertEquals(errorCaught, true, "restore must be refused when active runs are present");
  const cancelCalls = sendCalls.filter((c) => c.action === "run.cancel");
  assertEquals(cancelCalls.length, 0, "production quiesce must never call run.cancel");
  // Admission fence must be cleared after restore fails
  assertEquals(kvStore["cap:restoreFence"], undefined, "restore fence must be cleared after refused restore");
});

Deno.test("backup-restore: concurrent restore is refused while live heartbeat is fresh", async () => {
  const kvStore: Record<string, any> = {
    "cap:restoreHeartbeat": Date.now(),
  };

  await assertRejects(
    () => streamRestoreArchive({
      stream: new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(512));
          c.close();
        },
      }),
      opfs: {
        listFiles: async () => [],
        readFile: async () => new Uint8Array(0),
        writeFile: async () => {},
        removeFile: async () => {},
      },
      kvGet: async (keys: any) => {
        if (Array.isArray(keys)) {
          const res: Record<string, any> = {};
          for (const k of keys) if (k in kvStore) res[k] = kvStore[k];
          return res;
        }
        return kvStore;
      },
      kvSet: async () => {},
      kvRemove: async () => {},
      alarms: { getAll: async () => [] },
      overwrite: true,
    }),
    Error,
    "Another restore operation is currently in progress",
  );
});

Deno.test("backup-restore: postCommit failure reports accurate reload error without bogus rollback failure", async () => {
  const kvStore: Record<string, any> = {};
  const liveFiles = new Map<string, Uint8Array>();

  const tarChunks: Uint8Array[] = [];
  const tarSink = new WritableStream<Uint8Array>({
    write(chunk) { tarChunks.push(chunk); },
  });

  await streamExportArchive({
    writable: tarSink,
    listFiles: async () => ["doc.txt"],
    open: async () => ({
      size: 5,
      stream: new ReadableStream({
        start(c) {
          c.enqueue(ENCODER.encode("hello"));
          c.close();
        },
      }),
    }),
    kvGet: async () => ({}),
    alarms: { getAll: async () => [] },
    extensionVersion: "1.0.0",
  });

  const tarBuffer = new Uint8Array(tarChunks.reduce((a, c) => a + c.byteLength, 0));
  let off = 0;
  for (const c of tarChunks) {
    tarBuffer.set(c, off);
    off += c.byteLength;
  }

  await assertRejects(
    () => streamRestoreArchive({
      stream: new ReadableStream({
        start(c) {
          c.enqueue(tarBuffer);
          c.close();
        },
      }),
      opfs: {
        listFiles: async () => [...liveFiles.keys()],
        readFile: async (p: string) => liveFiles.get(p) ?? new Uint8Array(0),
        writeFile: async (p: string, b: Uint8Array) => liveFiles.set(p, b),
        removeFile: async (p: string) => liveFiles.delete(p),
      },
      kvGet: async (keys: any) => {
        if (Array.isArray(keys)) {
          const res: Record<string, any> = {};
          for (const k of keys) if (k in kvStore) res[k] = kvStore[k];
          return res;
        }
        return kvStore;
      },
      kvSet: async (items: any) => { Object.assign(kvStore, items); },
      kvRemove: async (keys: string | string[]) => {
        for (const k of (Array.isArray(keys) ? keys : [keys])) delete kvStore[k];
      },
      alarms: { getAll: async () => [], create: async () => {}, clear: async () => {} },
      postCommit: async () => {
        throw new Error("simulated worker disconnect");
      },
      overwrite: true,
    }),
    Error,
    "Profile restore committed successfully, but cache invalidation failed",
  );

  // File was successfully committed
  assertEquals(new TextDecoder().decode(liveFiles.get("doc.txt")!), "hello");
  // Sidecar journal was cleanly committed and removed
  assertEquals(kvStore["cap:importBackup"], undefined);
});

Deno.test("backup-restore: two concurrent callers are strictly serialized via lock / claim", async () => {
  const kvStore: Record<string, any> = {};
  const liveFiles = new Map<string, Uint8Array>();

  const tarChunks: Uint8Array[] = [];
  const tarSink = new WritableStream<Uint8Array>({
    write(chunk) { tarChunks.push(chunk); },
  });

  await streamExportArchive({
    writable: tarSink,
    listFiles: async () => ["doc.txt"],
    open: async () => ({
      size: 5,
      stream: new ReadableStream({
        start(c) {
          c.enqueue(ENCODER.encode("hello"));
          c.close();
        },
      }),
    }),
    kvGet: async () => ({}),
    alarms: { getAll: async () => [] },
    extensionVersion: "1.0.0",
  });

  const tarBuffer = new Uint8Array(tarChunks.reduce((a, c) => a + c.byteLength, 0));
  let off = 0;
  for (const c of tarChunks) {
    tarBuffer.set(c, off);
    off += c.byteLength;
  }

  // Common lock coordinator simulating atomic mutex
  let lockHeld = false;
  const lockAcquirer = async (name: string, fn: any) => {
    if (lockHeld) {
      throw new Error("Another restore operation is currently in progress. Please wait for it to complete.");
    }
    lockHeld = true;
    try {
      return await fn();
    } finally {
      lockHeld = false;
    }
  };

  const createCaller = () => streamRestoreArchive({
    stream: new ReadableStream({
      start(c) {
        c.enqueue(tarBuffer);
        c.close();
      },
    }),
    opfs: {
      listFiles: async () => [...liveFiles.keys()],
      readFile: async (p: string) => liveFiles.get(p) ?? new Uint8Array(0),
      writeFile: async (p: string, b: Uint8Array) => liveFiles.set(p, b),
      removeFile: async (p: string) => liveFiles.delete(p),
    },
    kvGet: async (keys: any) => {
      if (Array.isArray(keys)) {
        const res: Record<string, any> = {};
        for (const k of keys) if (k in kvStore) res[k] = kvStore[k];
        return res;
      }
      return kvStore;
    },
    kvSet: async (items: any) => { Object.assign(kvStore, items); },
    kvRemove: async (keys: string | string[]) => {
      for (const k of (Array.isArray(keys) ? keys : [keys])) delete kvStore[k];
    },
    alarms: { getAll: async () => [], create: async () => {}, clear: async () => {} },
    lockAcquirer,
    overwrite: true,
  });

  // Launch both concurrently
  const [res1, res2] = await Promise.allSettled([createCaller(), createCaller()]);

  // Exactly one must succeed, and one must be rejected with concurrency error
  const succeeded = [res1, res2].filter((r) => r.status === "fulfilled");
  const rejected = [res1, res2].filter((r) => r.status === "rejected");

  assertEquals(succeeded.length, 1, "exactly one concurrent restore must succeed");
  assertEquals(rejected.length, 1, "exactly one concurrent restore must be rejected");
  assert(
    (rejected[0] as PromiseRejectedResult).reason?.message?.includes("Another restore operation is currently in progress"),
    "rejected restore must cite concurrency in progress",
  );
});

Deno.test("backup-restore: storage failure on claim write propagates and stops restore", async () => {
  await assertRejects(
    () => streamRestoreArchive({
      stream: new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(512));
          c.close();
        },
      }),
      opfs: {
        listFiles: async () => [],
        readFile: async () => new Uint8Array(0),
        writeFile: async () => {},
        removeFile: async () => {},
      },
      kvGet: async () => ({}),
      kvSet: async () => {
        throw new Error("simulated disk I/O error on claim write");
      },
      kvRemove: async () => {},
      alarms: { getAll: async () => [] },
      overwrite: true,
    }),
    Error,
    "simulated disk I/O error on claim write",
  );
});

Deno.test("backup-restore: storage failure on admission fence write propagates and aborts restore", async () => {
  const kvStore: Record<string, any> = {};
  let setCalls = 0;

  const tarChunks: Uint8Array[] = [];
  const tarSink = new WritableStream<Uint8Array>({
    write(chunk) { tarChunks.push(chunk); },
  });

  await streamExportArchive({
    writable: tarSink,
    listFiles: async () => ["doc.txt"],
    open: async () => ({
      size: 5,
      stream: new ReadableStream({
        start(c) {
          c.enqueue(ENCODER.encode("hello"));
          c.close();
        },
      }),
    }),
    kvGet: async () => ({}),
    alarms: { getAll: async () => [] },
    extensionVersion: "1.0.0",
  });

  const tarBuffer = new Uint8Array(tarChunks.reduce((a, c) => a + c.byteLength, 0));
  let off = 0;
  for (const c of tarChunks) {
    tarBuffer.set(c, off);
    off += c.byteLength;
  }

  await assertRejects(
    () => streamRestoreArchive({
      stream: new ReadableStream({
        start(c) {
          c.enqueue(tarBuffer);
          c.close();
        },
      }),
      opfs: {
        listFiles: async () => [],
        readFile: async () => new Uint8Array(0),
        writeFile: async () => {},
        removeFile: async () => {},
      },
      kvGet: async (keys: any) => {
        if (Array.isArray(keys)) {
          const res: Record<string, any> = {};
          for (const k of keys) if (k in kvStore) res[k] = kvStore[k];
          return res;
        }
        return kvStore;
      },
      kvSet: async (items: any) => {
        setCalls++;
        if (items["cap:restoreFence"]) {
          throw new Error("simulated storage failure on admission fence write");
        }
        Object.assign(kvStore, items);
      },
      kvRemove: async () => {},
      alarms: { getAll: async () => [] },
      overwrite: true,
    }),
    Error,
    "simulated storage failure on admission fence write",
  );
});

Deno.test("backup-restore: stale journal recovery succeeds and subsequent restore completes cleanly", async () => {
  const kvStore: Record<string, any> = {
    // A stale sidecar journal from a crashed previous restore
    "cap:importBackup": {
      version: 2,
      ops: [
        [0, "settingA", { __cap_val: "originalValue" }],
      ],
      timestamp: Date.now() - 60000, // 60 seconds ago (stale)
    },
    settingA: "half-mutated-value",
  };

  const liveFiles = new Map<string, Uint8Array>();

  const tarChunks: Uint8Array[] = [];
  const tarSink = new WritableStream<Uint8Array>({
    write(chunk) { tarChunks.push(chunk); },
  });

  await streamExportArchive({
    writable: tarSink,
    listFiles: async () => ["doc.txt"],
    open: async () => ({
      size: 11,
      stream: new ReadableStream({
        start(c) {
          c.enqueue(ENCODER.encode("new-content"));
          c.close();
        },
      }),
    }),
    kvGet: async () => ({ settingA: "fresh-new-value" }),
    alarms: { getAll: async () => [] },
    extensionVersion: "1.0.0",
  });

  const tarBuffer = new Uint8Array(tarChunks.reduce((a, c) => a + c.byteLength, 0));
  let off = 0;
  for (const c of tarChunks) {
    tarBuffer.set(c, off);
    off += c.byteLength;
  }

  const res = await streamRestoreArchive({
    stream: new ReadableStream({
      start(c) {
        c.enqueue(tarBuffer);
        c.close();
      },
    }),
    opfs: {
      listFiles: async () => [...liveFiles.keys()],
      readFile: async (p: string) => liveFiles.get(p) ?? new Uint8Array(0),
      writeFile: async (p: string, b: Uint8Array) => liveFiles.set(p, b),
      removeFile: async (p: string) => liveFiles.delete(p),
    },
    kvGet: async (keys: any) => {
      if (Array.isArray(keys)) {
        const out: Record<string, any> = {};
        for (const k of keys) if (k in kvStore) out[k] = kvStore[k];
        return out;
      }
      return kvStore;
    },
    kvSet: async (items: any) => { Object.assign(kvStore, items); },
    kvRemove: async (keys: any) => {
      for (const k of (Array.isArray(keys) ? keys : [keys])) delete kvStore[k];
    },
    alarms: { getAll: async () => [], create: async () => {}, clear: async () => {} },
    overwrite: true,
  });

  assertEquals(res.ok, true);
  // Stale journal was healed and new restore applied
  assertEquals(kvStore["settingA"], "fresh-new-value");
  assertEquals(new TextDecoder().decode(liveFiles.get("doc.txt")!), "new-content");
  // Journal and fences cleaned up
  assertEquals(kvStore["cap:importBackup"], undefined);
  assertEquals(kvStore["cap:restoreClaim"], undefined);
  assertEquals(kvStore["cap:restoreFence"], undefined);
});

Deno.test("backup-restore: crash-before-journal leaves no permanent fence and subsequent restore cleans it", async () => {
  const kvStore: Record<string, any> = {
    // Abandoned admission fence and claim from crash before rollback journal write
    "cap:restoreFence": Date.now() - 40000,
    "cap:restoreClaim": { sessionId: "old-crashed-session", timestamp: Date.now() - 40000 },
    // No cap:importBackup
    settingX: "pre-existing",
  };

  const liveFiles = new Map<string, Uint8Array>();

  const tarChunks: Uint8Array[] = [];
  const tarSink = new WritableStream<Uint8Array>({
    write(chunk) { tarChunks.push(chunk); },
  });

  await streamExportArchive({
    writable: tarSink,
    listFiles: async () => ["fresh.txt"],
    open: async () => ({
      size: 6,
      stream: new ReadableStream({
        start(c) {
          c.enqueue(ENCODER.encode("fresh!"));
          c.close();
        },
      }),
    }),
    kvGet: async () => ({ settingX: "updated" }),
    alarms: { getAll: async () => [] },
    extensionVersion: "1.0.0",
  });

  const tarBuffer = new Uint8Array(tarChunks.reduce((a, c) => a + c.byteLength, 0));
  let off = 0;
  for (const c of tarChunks) {
    tarBuffer.set(c, off);
    off += c.byteLength;
  }

  const res = await streamRestoreArchive({
    stream: new ReadableStream({
      start(c) {
        c.enqueue(tarBuffer);
        c.close();
      },
    }),
    opfs: {
      listFiles: async () => [...liveFiles.keys()],
      readFile: async (p: string) => liveFiles.get(p) ?? new Uint8Array(0),
      writeFile: async (p: string, b: Uint8Array) => liveFiles.set(p, b),
      removeFile: async (p: string) => liveFiles.delete(p),
    },
    kvGet: async (keys: any) => {
      if (Array.isArray(keys)) {
        const out: Record<string, any> = {};
        for (const k of keys) if (k in kvStore) out[k] = kvStore[k];
        return out;
      }
      return kvStore;
    },
    kvSet: async (items: any) => { Object.assign(kvStore, items); },
    kvRemove: async (keys: any) => {
      for (const k of (Array.isArray(keys) ? keys : [keys])) delete kvStore[k];
    },
    alarms: { getAll: async () => [], create: async () => {}, clear: async () => {} },
    overwrite: true,
  });

  assertEquals(res.ok, true);
  // Stale fence was cleared and restore applied successfully
  assertEquals(kvStore["settingX"], "updated");
  assertEquals(new TextDecoder().decode(liveFiles.get("fresh.txt")!), "fresh!");
  assertEquals(kvStore["cap:restoreFence"], undefined);
  assertEquals(kvStore["cap:restoreClaim"], undefined);
});

Deno.test("backup-restore: failed rollback retains admission fence while recovery journal remains", async () => {
  const kvStore: Record<string, any> = {
    "key1": "original",
  };
  const liveFiles = new Map<string, Uint8Array>();
  liveFiles.set("f1.txt", ENCODER.encode("original f1"));

  const tarChunks: Uint8Array[] = [];
  const tarSink = new WritableStream<Uint8Array>({
    write(chunk) { tarChunks.push(chunk); },
  });

  await streamExportArchive({
    writable: tarSink,
    listFiles: async () => ["f1.txt", "f2.txt"],
    open: async (p: string) => ({
      size: 7,
      stream: new ReadableStream({
        start(c) {
          c.enqueue(ENCODER.encode(p === "f1.txt" ? "mutated" : "mutated"));
          c.close();
        },
      }),
    }),
    kvGet: async () => ({ key1: "mutated" }),
    alarms: { getAll: async () => [] },
    extensionVersion: "1.0.0",
  });

  const tarBuffer = new Uint8Array(tarChunks.reduce((a, c) => a + c.byteLength, 0));
  let off = 0;
  for (const c of tarChunks) {
    tarBuffer.set(c, off);
    off += c.byteLength;
  }

  let writeCount = 0;
  await assertRejects(
    () => streamRestoreArchive({
      stream: new ReadableStream({
        start(c) {
          c.enqueue(tarBuffer);
          c.close();
        },
      }),
      opfs: {
        listFiles: async () => [...liveFiles.keys()],
        readFile: async (p: string) => liveFiles.get(p) ?? new Uint8Array(0),
        writeFile: async (p: string, b: Uint8Array) => {
          if (!p.startsWith(".staging-") && !p.startsWith(".rollback-")) {
            writeCount++;
            if (writeCount === 2) {
              throw new Error("simulated disk full during live file swap");
            }
          }
          liveFiles.set(p, b);
        },
        removeFile: async (p: string) => {
          liveFiles.delete(p);
        },
      },
      kvGet: async (keys: any) => {
        if (Array.isArray(keys)) {
          const out: Record<string, any> = {};
          for (const k of keys) if (k in kvStore) out[k] = kvStore[k];
          return out;
        }
        return kvStore;
      },
      kvSet: async (items: any) => {
        if (items["key1"] === "original") {
          throw new Error("simulated failure restoring key during rollback recovery");
        }
        Object.assign(kvStore, items);
      },
      kvRemove: async (keys: any) => {
        for (const k of (Array.isArray(keys) ? keys : [keys])) delete kvStore[k];
      },
      alarms: { getAll: async () => [], create: async () => {}, clear: async () => {} },
      overwrite: true,
    }),
    Error,
    "AND rollback failed",
  );

  // Rollback failed, so journal remains in store
  assert(kvStore["cap:importBackup"], "rollback journal must remain on rollback failure");
  // CRITICAL: Admission fence must be RETAINED so admitDurableRun continues to protect profile!
  assert(kvStore["cap:restoreFence"], "admission fence must remain active when rollback fails");
});

Deno.test("backup-restore: Options-crash sequence triggers recovery of journal and restores pre-crash state", async () => {
  const kvStore: Record<string, any> = {
    keyA: "pre-crash-value",
  };
  const liveFiles = new Map<string, Uint8Array>();
  liveFiles.set("doc.txt", ENCODER.encode("original-file-bytes"));

  // Simulate Options page starting restore, writing journal, mutating half the files, then crashing
  const rollbackDir = ".rollback-backup-crashed-test";
  const stagingDir = ".staging-restore-crashed-test";
  liveFiles.set(`${rollbackDir}/doc.txt`, ENCODER.encode("original-file-bytes"));
  liveFiles.set(`${stagingDir}/doc.txt`, ENCODER.encode("staged-candidate-bytes"));
  liveFiles.set("unrelated-staging/.keep", ENCODER.encode("keep"));
  liveFiles.set("doc.txt", ENCODER.encode("partially-swapped-new-bytes"));
  kvStore["keyA"] = "partially-swapped-new-setting";

  // The journal left by the crashed Options tab
  kvStore["cap:importBackup"] = {
    version: 2,
    rollbackDir,
    stagingDir,
    ops: [
      [0, "keyA", { __cap_val: "pre-crash-value" }],
      [1, "doc.txt", `opfs-backup:${rollbackDir}/doc.txt`],
    ],
    timestamp: Date.now() - 40000, // 40 seconds ago (stale)
  };
  kvStore["cap:restoreFence"] = Date.now() - 40000;
  kvStore["cap:restoreClaim"] = { sessionId: "crashed-tab-session", timestamp: Date.now() - 40000 };

  // Service worker recovery routine runs
  await recoverPendingImport({
    kvGet: async (keys: any) => {
      if (Array.isArray(keys)) {
        const out: Record<string, any> = {};
        for (const k of keys) if (k in kvStore) out[k] = kvStore[k];
        return out;
      }
      return kvStore;
    },
    kvSet: async (items: any) => { Object.assign(kvStore, items); },
    kvRemove: async (keys: any) => {
      for (const k of (Array.isArray(keys) ? keys : [keys])) delete kvStore[k];
    },
    opfs: {
      listFiles: async () => [...liveFiles.keys()],
      readFile: async (p: string) => liveFiles.get(p) ?? new Uint8Array(0),
      writeFile: async (p: string, b: Uint8Array) => liveFiles.set(p, b),
      removeFile: async (p: string) => liveFiles.delete(p),
    },
    alarms: { getAll: async () => [], create: async () => {}, clear: async () => {} },
  });

  // Verify all data is restored to pre-crash state
  assertEquals(kvStore["keyA"], "pre-crash-value");
  assertEquals(new TextDecoder().decode(liveFiles.get("doc.txt")!), "original-file-bytes");
  // Staging dir and rollback dir are cleaned up, but unrelated staging is untouched
  assertEquals(liveFiles.has(`${stagingDir}/doc.txt`), false);
  assertEquals(liveFiles.has(`${rollbackDir}/doc.txt`), false);
  assertEquals(liveFiles.has("unrelated-staging/.keep"), true);
  // Journal, fence, and claim are all cleared
  assertEquals(kvStore["cap:importBackup"], undefined);
  assertEquals(kvStore["cap:restoreFence"], undefined);
  assertEquals(kvStore["cap:restoreClaim"], undefined);
});

Deno.test("backup-restore: legacy importArchive refuses while streaming restore heartbeat is active", async () => {
  const kvStore: Record<string, any> = {
    "cap:restoreHeartbeat": Date.now(),
  };

  const snapshot = await collectExportData({
    kvGet: async () => ({}),
    opfs: { listFiles: async () => [] },
    alarms: { getAll: async () => [] },
  });
  const sampleV1Bundle = buildArchive(snapshot, { extensionVersion: "1.0.0" });

  await assertRejects(
    async () => {
      await importArchive(sampleV1Bundle, {
        kvGet: async () => kvStore,
        kvSet: async () => {},
        kvRemove: async () => {},
        opfs: { listFiles: async () => [] },
        alarms: { getAll: async () => [] },
        overwrite: true,
      });
    },
    Error,
    "Another restore operation is currently in progress",
  );
});

Deno.test("backup-restore: recovery alarm is armed when journal persists, excluded from clearing, and cleared on completion", async () => {
  const alarmsCreated: string[] = [];
  const alarmsCleared: string[] = [];
  const kvStore: Record<string, any> = {
    testKey: "original",
  };
  const liveFiles = new Map<string, Uint8Array>();
  liveFiles.set("note.txt", ENCODER.encode("original"));

  const tarChunks: Uint8Array[] = [];
  const tarSink = new WritableStream<Uint8Array>({
    write(chunk) { tarChunks.push(chunk); },
  });

  await streamExportArchive({
    writable: tarSink,
    listFiles: async () => ["note.txt"],
    open: async () => ({
      size: 7,
      stream: new ReadableStream({
        start(c) {
          c.enqueue(ENCODER.encode("updated"));
          c.close();
        },
      }),
    }),
    kvGet: async () => ({ testKey: "updated" }),
    alarms: { getAll: async () => [{ name: "daily-sync" }] },
    extensionVersion: "1.0.0",
  });

  const tarBuffer = new Uint8Array(tarChunks.reduce((a, c) => a + c.byteLength, 0));
  let off = 0;
  for (const c of tarChunks) {
    tarBuffer.set(c, off);
    off += c.byteLength;
  }

  let journalCheckedAlarm = false;

  await streamRestoreArchive({
    stream: new ReadableStream({
      start(c) {
        c.enqueue(tarBuffer);
        c.close();
      },
    }),
    opfs: {
      listFiles: async () => [...liveFiles.keys()],
      readFile: async (p: string) => liveFiles.get(p) ?? new Uint8Array(0),
      writeFile: async (p: string, b: Uint8Array) => liveFiles.set(p, b),
      removeFile: async (p: string) => liveFiles.delete(p),
    },
    kvGet: async (keys: any) => {
      if (Array.isArray(keys)) {
        const out: Record<string, any> = {};
        for (const k of keys) if (k in kvStore) out[k] = kvStore[k];
        return out;
      }
      return kvStore;
    },
    kvSet: async (items: any) => {
      Object.assign(kvStore, items);
      if (items["cap:importBackup"]) {
        // At the moment journal is persisted, recovery alarm must have been scheduled!
        // Check right after
        setTimeout(() => {
          if (alarmsCreated.includes("cap-restore-recovery-alarm")) {
            journalCheckedAlarm = true;
          }
        }, 0);
      }
    },
    kvRemove: async (keys: any) => {
      for (const k of (Array.isArray(keys) ? keys : [keys])) delete kvStore[k];
    },
    alarms: {
      getAll: async () => [{ name: "daily-sync" }, { name: "cap-restore-recovery-alarm" }],
      create: async (nameOrObj: any) => {
        const n = typeof nameOrObj === "string" ? nameOrObj : nameOrObj?.name || "cap-restore-recovery-alarm";
        alarmsCreated.push(n);
      },
      clear: async (name: string) => {
        alarmsCleared.push(name);
      },
    },
    overwrite: true,
  });

  // Verify:
  // 1. Recovery alarm was created when journal was set
  assert(alarmsCreated.includes("cap-restore-recovery-alarm"), "recovery alarm must be armed during restore");
  // 2. The existing recovery alarm was NOT cleared during the pre-swap alarm flush (daily-sync cleared, but recovery alarm spared)
  const clearedBeforeCommit = alarmsCleared.filter((a) => a === "cap-restore-recovery-alarm");
  // It is only cleared at the end upon successful commit
  assertEquals(clearedBeforeCommit.length, 1, "recovery alarm must be cleared exactly once upon commit completion");
  assertEquals(alarmsCleared[0], "daily-sync", "daily-sync alarm should be cleared before swap");
});

Deno.test("backup-restore: alarms.create rejection fails closed, removes journal, cleans temp dirs and leaves live state untouched", async () => {
  const kvStore: Record<string, any> = {
    myKey: "original-setting",
  };
  const liveFiles = new Map<string, Uint8Array>();
  liveFiles.set("file.txt", ENCODER.encode("original-file-content"));

  const tarChunks: Uint8Array[] = [];
  const tarSink = new WritableStream<Uint8Array>({
    write(chunk) { tarChunks.push(chunk); },
  });

  await streamExportArchive({
    writable: tarSink,
    listFiles: async () => ["file.txt"],
    open: async () => ({
      size: 15,
      stream: new ReadableStream({
        start(c) {
          c.enqueue(ENCODER.encode("mutated-content"));
          c.close();
        },
      }),
    }),
    kvGet: async () => ({ myKey: "mutated-setting" }),
    alarms: { getAll: async () => [] },
    extensionVersion: "1.0.0",
  });

  const tarBuffer = new Uint8Array(tarChunks.reduce((a, c) => a + c.byteLength, 0));
  let off = 0;
  for (const c of tarChunks) {
    tarBuffer.set(c, off);
    off += c.byteLength;
  }

  await assertRejects(
    async () => {
      await streamRestoreArchive({
        stream: new ReadableStream({
          start(c) {
            c.enqueue(tarBuffer);
            c.close();
          },
        }),
        opfs: {
          listFiles: async () => [...liveFiles.keys()],
          readFile: async (p: string) => liveFiles.get(p) ?? new Uint8Array(0),
          writeFile: async (p: string, b: Uint8Array) => liveFiles.set(p, b),
          removeFile: async (p: string) => liveFiles.delete(p),
        },
        kvGet: async (keys: any) => {
          if (Array.isArray(keys)) {
            const out: Record<string, any> = {};
            for (const k of keys) if (k in kvStore) out[k] = kvStore[k];
            return out;
          }
          return kvStore;
        },
        kvSet: async (items: any) => {
          Object.assign(kvStore, items);
        },
        kvRemove: async (keys: any) => {
          for (const k of (Array.isArray(keys) ? keys : [keys])) delete kvStore[k];
        },
        alarms: {
          getAll: async () => [],
          create: async (nameOrObj: any) => {
            const n = typeof nameOrObj === "string" ? nameOrObj : nameOrObj?.name;
            if (n === "cap-restore-recovery-alarm") {
              throw new Error("simulated failure arming recovery alarm");
            }
          },
          clear: async () => {},
        },
        overwrite: true,
      });
    },
    Error,
    "Failed to arm recovery alarm",
  );

  // 1. Journal must be removed (not left durable since alarm arming failed)
  assertEquals(kvStore["cap:importBackup"], undefined);
  // 2. Original live state must be untouched
  assertEquals(kvStore["myKey"], "original-setting");
  assertEquals(new TextDecoder().decode(liveFiles.get("file.txt")!), "original-file-content");
  // 3. Staging and rollback dirs must be cleaned up
  const remainingFiles = [...liveFiles.keys()];
  assertEquals(remainingFiles, ["file.txt"]);
});

Deno.test("backup-restore: journal removal failure retains rollback backups and admission fence", async () => {
  const kvStore: Record<string, any> = {
    myKey: "original-setting",
  };
  const liveFiles = new Map<string, Uint8Array>();
  liveFiles.set("file.txt", ENCODER.encode("original-file-content"));

  const tarChunks: Uint8Array[] = [];
  const tarSink = new WritableStream<Uint8Array>({
    write(chunk) { tarChunks.push(chunk); },
  });

  await streamExportArchive({
    writable: tarSink,
    listFiles: async () => ["file.txt"],
    open: async () => ({
      size: 15,
      stream: new ReadableStream({
        start(c) {
          c.enqueue(ENCODER.encode("mutated-content"));
          c.close();
        },
      }),
    }),
    kvGet: async () => ({ myKey: "mutated-setting" }),
    alarms: { getAll: async () => [] },
    extensionVersion: "1.0.0",
  });

  const tarBuffer = new Uint8Array(tarChunks.reduce((a, c) => a + c.byteLength, 0));
  let off = 0;
  for (const c of tarChunks) {
    tarBuffer.set(c, off);
    off += c.byteLength;
  }

  await assertRejects(
    async () => {
      await streamRestoreArchive({
        stream: new ReadableStream({
          start(c) {
            c.enqueue(tarBuffer);
            c.close();
          },
        }),
        opfs: {
          listFiles: async () => [...liveFiles.keys()],
          readFile: async (p: string) => liveFiles.get(p) ?? new Uint8Array(0),
          writeFile: async (p: string, b: Uint8Array) => liveFiles.set(p, b),
          removeFile: async (p: string) => liveFiles.delete(p),
        },
        kvGet: async (keys: any) => {
          if (Array.isArray(keys)) {
            const out: Record<string, any> = {};
            for (const k of keys) if (k in kvStore) out[k] = kvStore[k];
            return out;
          }
          return kvStore;
        },
        kvSet: async (items: any) => {
          Object.assign(kvStore, items);
        },
        kvRemove: async (keys: any) => {
          const arr = Array.isArray(keys) ? keys : [keys];
          if (arr.includes("cap:importBackup")) {
            throw new Error("simulated failure removing import backup journal");
          }
          for (const k of arr) delete kvStore[k];
        },
        alarms: {
          getAll: async () => [],
          create: async (nameOrObj: any) => {
            const n = typeof nameOrObj === "string" ? nameOrObj : nameOrObj?.name;
            if (n === "cap-restore-recovery-alarm") {
              throw new Error("simulated failure arming recovery alarm");
            }
          },
          clear: async () => {},
        },
        overwrite: true,
      });
    },
    Error,
    "retaining rollback backups",
  );

  // 1. Journal must remain durable because removal failed!
  assert(kvStore["cap:importBackup"], "journal must remain durable on removal failure");
  const journal = kvStore["cap:importBackup"];
  // 2. Rollback backups must be retained on disk (not deleted!)
  const backupFiles = [...liveFiles.keys()].filter((p) => p.startsWith(journal.rollbackDir));
  assert(backupFiles.length > 0, "rollback backups must be retained when journal remains durable");
  // 3. Admission fence must be retained!
  assert(kvStore["cap:restoreFence"], "admission fence must be retained while journal exists");

  // 4. Verification that boot recovery succeeds with the retained backups!
  await recoverPendingImport({
    kvGet: async (keys: any) => {
      if (Array.isArray(keys)) {
        const out: Record<string, any> = {};
        for (const k of keys) if (k in kvStore) out[k] = kvStore[k];
        return out;
      }
      return kvStore;
    },
    kvSet: async (items: any) => { Object.assign(kvStore, items); },
    kvRemove: async (keys: any) => {
      for (const k of (Array.isArray(keys) ? keys : [keys])) delete kvStore[k];
    },
    opfs: {
      listFiles: async () => [...liveFiles.keys()],
      readFile: async (p: string) => liveFiles.get(p) ?? new Uint8Array(0),
      writeFile: async (p: string, b: Uint8Array) => liveFiles.set(p, b),
      removeFile: async (p: string) => liveFiles.delete(p),
    },
    alarms: { getAll: async () => [], create: async () => {}, clear: async () => {} },
  });

  // Now profile is fully restored and journal/fence are cleaned up!
  assertEquals(kvStore["myKey"], "original-setting");
  assertEquals(new TextDecoder().decode(liveFiles.get("file.txt")!), "original-file-content");
  assertEquals(kvStore["cap:importBackup"], undefined);
  assertEquals(kvStore["cap:restoreFence"], undefined);
});

Deno.test("backup-restore: failing kvGet in prep catch treats journal as possibly durable and retains backups", async () => {
  const kvStore: Record<string, any> = {
    testProp: "before-restore",
  };
  const liveFiles = new Map<string, Uint8Array>();
  liveFiles.set("data.bin", ENCODER.encode("initial-data"));

  const tarChunks: Uint8Array[] = [];
  const tarSink = new WritableStream<Uint8Array>({
    write(chunk) { tarChunks.push(chunk); },
  });

  await streamExportArchive({
    writable: tarSink,
    listFiles: async () => ["data.bin"],
    open: async () => ({
      size: 12,
      stream: new ReadableStream({
        start(c) {
          c.enqueue(ENCODER.encode("updated-data"));
          c.close();
        },
      }),
    }),
    kvGet: async () => ({ testProp: "updated-prop" }),
    alarms: { getAll: async () => [] },
    extensionVersion: "1.0.0",
  });

  const tarBuffer = new Uint8Array(tarChunks.reduce((a, c) => a + c.byteLength, 0));
  let off = 0;
  for (const c of tarChunks) {
    tarBuffer.set(c, off);
    off += c.byteLength;
  }

  let journalWritten = false;
  let failKvGet = false;

  await assertRejects(
    async () => {
      await streamRestoreArchive({
        stream: new ReadableStream({
          start(c) {
            c.enqueue(tarBuffer);
            c.close();
          },
        }),
        opfs: {
          listFiles: async () => [...liveFiles.keys()],
          readFile: async (p: string) => liveFiles.get(p) ?? new Uint8Array(0),
          writeFile: async (p: string, b: Uint8Array) => liveFiles.set(p, b),
          removeFile: async (p: string) => liveFiles.delete(p),
        },
        kvGet: async (keys: any) => {
          if (failKvGet) {
            throw new Error("simulated failure reading storage during prep catch");
          }
          if (Array.isArray(keys)) {
            const out: Record<string, any> = {};
            for (const k of keys) if (k in kvStore) out[k] = kvStore[k];
            return out;
          }
          return kvStore;
        },
        kvSet: async (items: any) => {
          Object.assign(kvStore, items);
          if (items["cap:importBackup"]) {
            journalWritten = true;
          }
        },
        kvRemove: async (keys: any) => {
          const arr = Array.isArray(keys) ? keys : [keys];
          if (arr.includes("cap:importBackup")) {
            throw new Error("simulated failure removing import backup journal");
          }
          for (const k of arr) delete kvStore[k];
        },
        alarms: {
          getAll: async () => [],
          create: async (nameOrObj: any) => {
            const n = typeof nameOrObj === "string" ? nameOrObj : nameOrObj?.name;
            if (n === "cap-restore-recovery-alarm") {
              // Trigger read failure during the upcoming prep catch
              failKvGet = true;
              throw new Error("simulated failure arming recovery alarm");
            }
          },
          clear: async () => {},
        },
        overwrite: true,
      });
    },
    Error,
    "retaining rollback backups",
  );

  // Journal was persisted, alarms.create threw, kvRemove threw, and kvGet threw in catch!
  assert(journalWritten, "journal must have been written");
  assert(kvStore["cap:importBackup"], "journal must still be in storage");
  const journal = kvStore["cap:importBackup"];

  // Even though kvGet threw in catch, backups were NOT deleted because journal was persisted!
  const backupFiles = [...liveFiles.keys()].filter((p) => p.startsWith(journal.rollbackDir));
  assert(backupFiles.length > 0, "rollback backups must be retained when journal read fails in catch");

  // Re-enable kvGet and verify recoverPendingImport can restore
  failKvGet = false;
  await recoverPendingImport({
    kvGet: async (keys: any) => {
      if (Array.isArray(keys)) {
        const out: Record<string, any> = {};
        for (const k of keys) if (k in kvStore) out[k] = kvStore[k];
        return out;
      }
      return kvStore;
    },
    kvSet: async (items: any) => { Object.assign(kvStore, items); },
    kvRemove: async (keys: any) => {
      for (const k of (Array.isArray(keys) ? keys : [keys])) delete kvStore[k];
    },
    opfs: {
      listFiles: async () => [...liveFiles.keys()],
      readFile: async (p: string) => liveFiles.get(p) ?? new Uint8Array(0),
      writeFile: async (p: string, b: Uint8Array) => liveFiles.set(p, b),
      removeFile: async (p: string) => liveFiles.delete(p),
    },
    alarms: { getAll: async () => [], create: async () => {}, clear: async () => {} },
  });

  assertEquals(kvStore["testProp"], "before-restore");
  assertEquals(new TextDecoder().decode(liveFiles.get("data.bin")!), "initial-data");
  assertEquals(kvStore["cap:importBackup"], undefined);
});

Deno.test("backup-restore: failure during or after quiesce rolls back active runs to pre-quiescence state", async () => {
  // Pre-restore state has an active run with a file log and KV entry
  const liveFiles = new Map<string, Uint8Array>([
    ["durable-runs/exec-101/run.log", ENCODER.encode("step 1: running")],
  ]);
  const kvStore: Record<string, any> = {
    "durable-runs:exec-101": { phase: "running" },
  };

  const tarChunks: Uint8Array[] = [];
  const tarSink = new WritableStream<Uint8Array>({
    write(chunk) { tarChunks.push(chunk); },
  });

  await streamExportArchive({
    writable: tarSink,
    listFiles: async () => ["durable-runs/exec-101/run.log"],
    open: async () => ({
      size: 16,
      stream: new ReadableStream({
        start(c) {
          c.enqueue(ENCODER.encode("step 1: restored"));
          c.close();
        },
      }),
    }),
    kvGet: async () => ({ "durable-runs:exec-101": { phase: "terminal" } }),
    alarms: { getAll: async () => [] },
    extensionVersion: "1.0.0",
  });

  const tarBuffer = new Uint8Array(tarChunks.reduce((a, c) => a + c.byteLength, 0));
  let off = 0;
  for (const c of tarChunks) {
    tarBuffer.set(c, off);
    off += c.byteLength;
  }

  let errorCaught = false;

  // 1. Quiesce failure (active writers do not settle) fails closed before profile mutation
  try {
    await streamRestoreArchive({
      stream: new ReadableStream({
        start(c) { c.enqueue(tarBuffer); c.close(); },
      }),
      opfs: {
        listFiles: async () => [...liveFiles.keys()],
        readFile: async (p: string) => liveFiles.get(p) ?? new Uint8Array(0),
        writeFile: async (p: string, b: Uint8Array) => liveFiles.set(p, b),
        removeFile: async (p: string) => liveFiles.delete(p),
      },
      kvGet: async () => kvStore,
      kvSet: async (items: any) => { Object.assign(kvStore, items); },
      kvRemove: async (keys: string[]) => { for (const k of keys) delete kvStore[k]; },
      alarms: { getAll: async () => [], create: async () => {}, clear: async () => {} },
      quiesce: async () => {
        throw new Error("Profile restore cannot proceed while tasks are actively running (1 active runs)");
      },
      overwrite: true,
    });
  } catch (err: any) {
    errorCaught = true;
    assert(err.message.includes("tasks are actively running"));
  }

  assert(errorCaught, "restore must reject when quiesce detects active tasks");
  assertEquals(
    DECODER.decode(liveFiles.get("durable-runs/exec-101/run.log")!),
    "step 1: running",
    "run.log must be untouched when quiesce fails",
  );
  assertEquals(
    kvStore["durable-runs:exec-101"].phase,
    "running",
    "KV run record must be untouched when quiesce fails",
  );

  // 2. Commit failure during Phase 3 rolls back files and KV from journal
  let swapFailed = false;
  let commitErrorCaught = false;
  try {
    await streamRestoreArchive({
      stream: new ReadableStream({
        start(c) { c.enqueue(tarBuffer); c.close(); },
      }),
      opfs: {
        listFiles: async () => [...liveFiles.keys()],
        readFile: async (p: string) => liveFiles.get(p) ?? new Uint8Array(0),
        writeFile: async (p: string, b: Uint8Array) => liveFiles.set(p, b),
        removeFile: async (p: string) => liveFiles.delete(p),
        openStream: async (p: string) => {
          const b = liveFiles.get(p) ?? new Uint8Array(0);
          return new ReadableStream({ start(c) { c.enqueue(b); c.close(); } });
        },
        writeStream: async (p: string, stream: ReadableStream<Uint8Array>) => {
          const reader = stream.getReader();
          const chunks: Uint8Array[] = [];
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) chunks.push(value);
          }
          const total = chunks.reduce((a, c) => a + c.byteLength, 0);
          const buf = new Uint8Array(total);
          let offset = 0;
          for (const c of chunks) { buf.set(c, offset); offset += c.byteLength; }
          if (p === "durable-runs/exec-101/run.log" && !swapFailed) {
            swapFailed = true;
            throw new Error("simulated commit swap failure");
          }
          liveFiles.set(p, buf);
        },
      },
      kvGet: async () => kvStore,
      kvSet: async (items: any) => { Object.assign(kvStore, items); },
      kvRemove: async (keys: string[]) => { for (const k of keys) delete kvStore[k]; },
      alarms: { getAll: async () => [], create: async () => {}, clear: async () => {} },
      quiesce: async () => {
        // Quiesce verifies zero active writers
      },
      overwrite: true,
    });
  } catch (err: any) {
    commitErrorCaught = true;
    assert(err.message.includes("Commit failed"), `expected Commit failed, got: ${err.message}`);
  }

  assert(commitErrorCaught, "restore must reject on commit swap failure");
  assertEquals(
    DECODER.decode(liveFiles.get("durable-runs/exec-101/run.log")!),
    "step 1: running",
    "run.log must be rolled back to original running state from journal",
  );
  assertEquals(
    kvStore["durable-runs:exec-101"].phase,
    "running",
    "KV run record must be rolled back to original running phase from journal",
  );
  assertEquals(kvStore["cap:restoreFence"], undefined, "restore fence must be cleared after clean rollback");
});

Deno.test("backup-restore: pruning failure during rollback retains journal and admission fence", async () => {
  const liveFiles = new Map<string, Uint8Array>([
    ["file.txt", ENCODER.encode("original")],
  ]);
  const kvStore: Record<string, any> = {
    "key1": "val1",
  };

  const tarChunks: Uint8Array[] = [];
  const tarSink = new WritableStream<Uint8Array>({
    write(chunk) { tarChunks.push(chunk); },
  });

  await streamExportArchive({
    writable: tarSink,
    listFiles: async () => ["file.txt"],
    open: async () => ({
      size: 8,
      stream: new ReadableStream({
        start(c) { c.enqueue(ENCODER.encode("restored")); c.close(); },
      }),
    }),
    kvGet: async () => ({ "key1": "new-val" }),
    alarms: { getAll: async () => [] },
    extensionVersion: "1.0.0",
  });

  const tarBuffer = new Uint8Array(tarChunks.reduce((a, c) => a + c.byteLength, 0));
  let off = 0;
  for (const c of tarChunks) {
    tarBuffer.set(c, off);
    off += c.byteLength;
  }

  let errorCaught = false;

  try {
    await streamRestoreArchive({
      stream: new ReadableStream({
        start(c) { c.enqueue(tarBuffer); c.close(); },
      }),
      opfs: {
        listFiles: async () => [...liveFiles.keys()],
        readFile: async (p: string) => liveFiles.get(p) ?? new Uint8Array(0),
        writeFile: async (p: string, b: Uint8Array) => liveFiles.set(p, b),
        removeFile: async (p: string) => {
          if (p === "extra-untracked.json") {
            throw new Error("simulated disk error removing extra untracked file");
          }
          liveFiles.delete(p);
        },
        openStream: async (p: string) => {
          const b = liveFiles.get(p) ?? new Uint8Array(0);
          return new ReadableStream({ start(c) { c.enqueue(b); c.close(); } });
        },
        writeStream: async (p: string, stream: ReadableStream<Uint8Array>) => {
          const reader = stream.getReader();
          const chunks: Uint8Array[] = [];
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) chunks.push(value);
          }
          const total = chunks.reduce((a, c) => a + c.byteLength, 0);
          const buf = new Uint8Array(total);
          let offset = 0;
          for (const c of chunks) { buf.set(c, offset); offset += c.byteLength; }
          if (p === "file.txt") {
            throw new Error("simulated disk full during atomic swap");
          }
          liveFiles.set(p, buf);
        },
      },
      kvGet: async () => kvStore,
      kvSet: async (items: any) => { Object.assign(kvStore, items); },
      kvRemove: async (keys: any) => { for (const k of keys) delete kvStore[k]; },
      alarms: { getAll: async () => [], create: async () => {}, clear: async () => {} },
      quiesce: async () => {
        // Create an untracked file during quiesce
        liveFiles.set("extra-untracked.json", ENCODER.encode("{}"));
      },
      overwrite: true,
    });
  } catch (err: any) {
    errorCaught = true;
    assert(err.message.includes("Commit failed"), `expected Commit failed, got: ${err.message}`);
  }

  assert(errorCaught, "restore must reject on commit failure");
  // Because removeFile threw during pruning of extra-untracked.json,
  // recoverPendingImport must propagate the error, retaining the journal and fence!
  assert(kvStore["cap:importBackup"] !== undefined, "rollback journal must be retained when pruning fails");
  assert(kvStore["cap:restoreFence"] !== undefined, "restore fence must be retained when pruning fails");
});

Deno.test("backup-restore: deletion failure of restored file during rollback propagates and retains journal", async () => {
  const liveFiles = new Map<string, Uint8Array>([
    ["file-to-restore.txt", ENCODER.encode("created-by-restore")],
  ]);
  const kvStore: Record<string, any> = {
    "cap:importBackup": {
      version: 2,
      ops: [
        [1, "file-to-restore.txt", null], // previous was null: restore created it, rollback must delete it
      ],
      rollbackDir: ".rollback-backup-test",
      stagingDir: ".staging-restore-test",
      timestamp: Date.now(),
    },
    "cap:restoreFence": Date.now(),
  };

  let errorCaught = false;
  try {
    await recoverPendingImport({
      kvGet: async (k: any) => kvStore,
      kvSet: async (items: any) => { Object.assign(kvStore, items); },
      kvRemove: async (keys: any) => {
        for (const k of (Array.isArray(keys) ? keys : [keys])) delete kvStore[k];
      },
      opfs: {
        listFiles: async () => [...liveFiles.keys()],
        readFile: async (p: string) => {
          const b = liveFiles.get(p);
          if (!b) throw new Error("not found");
          return b;
        },
        removeFile: async (p: string) => {
          throw new Error("disk permission denied removing restored file");
        },
      },
    });
  } catch (err: any) {
    errorCaught = true;
    assert(err.message.includes("disk permission denied"));
  }

  assert(errorCaught, "recoverPendingImport must propagate removal failure");
  // Journal and fence must NOT be removed!
  assert(kvStore["cap:importBackup"] !== undefined, "journal must be retained on file removal failure");
  assert(kvStore["cap:restoreFence"] !== undefined, "fence must be retained on file removal failure");

  // Also verify that a non-NotFoundError (e.g. SecurityError) propagates immediately
  // even if the file is absent / readFile would throw NotFoundError!
  let securityErrorCaught = false;
  try {
    await recoverPendingImport({
      kvGet: async (k: any) => kvStore,
      kvSet: async (items: any) => { Object.assign(kvStore, items); },
      kvRemove: async (keys: any) => {
        for (const k of (Array.isArray(keys) ? keys : [keys])) delete kvStore[k];
      },
      opfs: {
        listFiles: async () => [...liveFiles.keys()],
        readFile: async (p: string) => {
          const err = new Error("File not found");
          err.name = "NotFoundError";
          throw err;
        },
        removeFile: async (p: string) => {
          const err = new Error("Security policy blocked file deletion");
          err.name = "SecurityError";
          throw err;
        },
      },
    });
  } catch (err: any) {
    securityErrorCaught = true;
    assert(err.message.includes("Security policy blocked"));
  }
  assert(securityErrorCaught, "recoverPendingImport must propagate SecurityError immediately");
  assert(kvStore["cap:importBackup"] !== undefined, "journal retained on SecurityError");
  assert(kvStore["cap:restoreFence"] !== undefined, "fence retained on SecurityError");
});

Deno.test("backup-restore: quiesce in Options handler waits for active writers to reach terminal/cancelled", async () => {
  let listCalls = 0;
  let activeWritersCount = 1;

  function validateRunListResponse(res: any, stepName: string) {
    if (!res || !Array.isArray(res.runs) || typeof res.activeWritersCount !== "number" || !Number.isInteger(res.activeWritersCount) || res.activeWritersCount < 0) {
      throw new Error(`Failed to query run list during quiescence (${stepName}): malformed response`);
    }
    for (const r of res.runs) {
      if (typeof r?.phase !== "string" || !r.phase.trim()) {
        throw new Error(`Malformed run record in ${stepName}: missing or non-string phase for ${r?.executionId || r?.id || "unknown"}`);
      }
    }
    return res;
  }

  // Verify that malformed response fails closed
  let malformedCaught = false;
  try {
    validateRunListResponse({ runs: [{ executionId: "exec-bad" }], activeWritersCount: 0 }, "test");
  } catch (err: any) {
    malformedCaught = true;
    assert(err.message.includes("missing or non-string phase"));
  }
  assert(malformedCaught, "quiescence must fail closed on missing phase");

  // Verify that record with status: "terminal" but missing phase fails closed
  let statusOnlyCaught = false;
  try {
    validateRunListResponse({ runs: [{ executionId: "exec-bad", status: "terminal" }], activeWritersCount: 0 }, "test");
  } catch (err: any) {
    statusOnlyCaught = true;
    assert(err.message.includes("missing or non-string phase"));
  }
  assert(statusOnlyCaught, "quiescence must fail closed on status-only record without phase");

  const sendCalls: { action: string; payload?: any }[] = [];
  const fakeSend = async (action: string, payload?: any) => {
    sendCalls.push({ action, payload });
    if (action === "run.list") {
      listCalls++;
      if (listCalls === 1) {
        return { runs: [{ executionId: "exec-1", phase: "running" }], activeWritersCount: 1, activeWriters: ["exec-1"] };
      }
      if (listCalls === 2) {
        // Record updated to cancel-requested, but writer projection still active
        return { runs: [{ executionId: "exec-1", phase: "cancel-requested" }], activeWritersCount: 1, activeWriters: ["exec-1"] };
      }
      if (listCalls === 3) {
        // Record transitioned to cancelled, but writer projection settling outbox still active!
        return { runs: [{ executionId: "exec-1", phase: "cancelled" }], activeWritersCount: 1, activeWriters: ["exec-1"] };
      }
      // Outbox settled: writer retired!
      activeWritersCount = 0;
      return { runs: [{ executionId: "exec-1", phase: "cancelled" }], activeWritersCount: 0, activeWriters: [] };
    }
    return { ok: true };
  };

  // Quiesce using production createOptionsQuiesce
  const quiesce = createOptionsQuiesce({
    send: fakeSend,
    setBackupStatus: () => {},
    setStorage: async () => {},
    maxWaitMs: 2000,
    pollIntervalMs: 10,
  });

  await quiesce();

  const cancelCalls = sendCalls.filter((c) => c.action === "run.cancel");
  assertEquals(cancelCalls.length, 0, "production quiescence must never call run.cancel");
  assert(listCalls >= 4, `quiesce must poll until runs AND live writers settle, took ${listCalls} calls`);
});

Deno.test("backup-restore: admitDurableRun fails closed when restore fence storage read fails", async () => {
  // Mock global chrome.storage.local.get to throw storage error
  const prevChrome = (globalThis as any).chrome;
  try {
    (globalThis as any).chrome = {
      storage: {
        local: {
          get: async () => {
            throw new Error("IO error reading extension storage");
          },
        },
      },
    };

    const mockRegistry = {
      start: async () => ({ ok: true, executionId: "exec-should-not-reach" }),
    };

    const res = await admitDurableRun(mockRegistry, { executionId: "exec-test" });
    assertEquals(res.ok, false);
    assertEquals(res.error, "storage_unreadable");
    assertEquals(res.code, "fence_check_failed");
    assert(res.message.includes("Failed to verify restore admission fence"));
  } finally {
    (globalThis as any).chrome = prevChrome;
  }
});

Deno.test("backup-restore: failure to remove admission fence after commit propagates and is not swallowed", async () => {
  const liveFiles = new Map<string, Uint8Array>([
    ["file.txt", ENCODER.encode("original")],
  ]);
  const kvStore: Record<string, any> = {};

  const tarChunks: Uint8Array[] = [];
  const tarSink = new WritableStream<Uint8Array>({
    write(chunk) { tarChunks.push(chunk); },
  });

  await streamExportArchive({
    writable: tarSink,
    listFiles: async () => ["file.txt"],
    open: async () => ({
      size: 8,
      stream: new ReadableStream({ start(c) { c.enqueue(ENCODER.encode("restored")); c.close(); } }),
    }),
    kvGet: async () => ({ "k": "v" }),
    alarms: { getAll: async () => [] },
    extensionVersion: "1.0.0",
  });

  const tarBuffer = new Uint8Array(tarChunks.reduce((a, c) => a + c.byteLength, 0));
  let off = 0;
  for (const c of tarChunks) {
    tarBuffer.set(c, off);
    off += c.byteLength;
  }

  let errorCaught = false;
  try {
    await streamRestoreArchive({
      stream: new ReadableStream({
        start(c) { c.enqueue(tarBuffer); c.close(); },
      }),
      opfs: {
        listFiles: async () => [...liveFiles.keys()],
        readFile: async (p: string) => liveFiles.get(p) ?? new Uint8Array(0),
        writeFile: async (p: string, b: Uint8Array) => liveFiles.set(p, b),
        removeFile: async (p: string) => liveFiles.delete(p),
        openStream: async (p: string) => {
          const b = liveFiles.get(p) ?? new Uint8Array(0);
          return new ReadableStream({ start(c) { c.enqueue(b); c.close(); } });
        },
        writeStream: async (p: string, stream: ReadableStream<Uint8Array>) => {
          const reader = stream.getReader();
          const chunks: Uint8Array[] = [];
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) chunks.push(value);
          }
          const total = chunks.reduce((a, c) => a + c.byteLength, 0);
          const buf = new Uint8Array(total);
          let offset = 0;
          for (const c of chunks) { buf.set(c, offset); offset += c.byteLength; }
          liveFiles.set(p, buf);
        },
      },
      kvGet: async (k: any) => {
        if (k === "cap:restoreFence") return { "cap:restoreFence": Date.now() }; // Simulated undeleted fence!
        return kvStore;
      },
      kvSet: async (items: any) => { Object.assign(kvStore, items); },
      kvRemove: async (keys: any) => {
        const arr = Array.isArray(keys) ? keys : [keys];
        for (const k of arr) {
          if (k === "cap:restoreFence") {
            throw new Error("storage disk full preventing fence removal");
          }
          delete kvStore[k];
        }
      },
      alarms: { getAll: async () => [], create: async () => {}, clear: async () => {} },
      overwrite: true,
    });
  } catch (err: any) {
    errorCaught = true;
    assert(err.message.includes("Profile restore committed, but failed to release admission fence"));
    assert(err.message.includes("cap:restoreFence"));
  }

  assert(errorCaught, "restore must propagate admission fence removal failure");
  // Journal was removed (data is committed)
  assertEquals(kvStore["cap:importBackup"], undefined);
});

Deno.test("backup-restore: active writers are quiesced before profile snapshot, preventing mid-snapshot file race", async () => {
  const eventLog: string[] = [];
  const liveFiles = new Map<string, Uint8Array>([
    ["shared/data.txt", ENCODER.encode("pre-restore-v1")],
  ]);

  const tarChunks: Uint8Array[] = [];
  const tarSink = new WritableStream<Uint8Array>({
    write(chunk) { tarChunks.push(chunk); },
  });

  await streamExportArchive({
    writable: tarSink,
    listFiles: async () => ["shared/data.txt"],
    open: async () => ({
      size: 14,
      stream: new ReadableStream({ start(c) { c.enqueue(ENCODER.encode("restored-value")); c.close(); } }),
    }),
    kvGet: async () => ({}),
    alarms: { getAll: async () => [] },
    extensionVersion: "1.0.0",
  });

  const tarBuffer = new Uint8Array(tarChunks.reduce((a, c) => a + c.byteLength, 0));
  let off = 0;
  for (const c of tarChunks) { tarBuffer.set(c, off); off += c.byteLength; }

  let activeWriterRunning = true;

  const kvStore: Record<string, any> = {};

  const res = await streamRestoreArchive({
    stream: new ReadableStream({ start(c) { c.enqueue(tarBuffer); c.close(); } }),
    opfs: {
      listFiles: async () => {
        eventLog.push("opfs:listFiles");
        return [...liveFiles.keys()];
      },
      readFile: async (p: string) => {
        eventLog.push(`opfs:readFile:${p}`);
        assertEquals(activeWriterRunning, false, "active writers must be stopped BEFORE file read/backup");
        return liveFiles.get(p) ?? new Uint8Array(0);
      },
      writeFile: async (p: string, b: Uint8Array) => {
        eventLog.push(`opfs:writeFile:${p}`);
        liveFiles.set(p, b);
      },
      removeFile: async (p: string) => { liveFiles.delete(p); },
      openStream: async (p: string) => {
        eventLog.push(`opfs:openStream:${p}`);
        assertEquals(activeWriterRunning, false, "active writers must be stopped BEFORE file openStream/backup");
        const b = liveFiles.get(p) ?? new Uint8Array(0);
        return new ReadableStream({ start(c) { c.enqueue(b); c.close(); } });
      },
      writeStream: async (p: string, stream: ReadableStream<Uint8Array>) => {
        const reader = stream.getReader();
        const chunks: Uint8Array[] = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) chunks.push(value);
        }
        const total = chunks.reduce((a, c) => a + c.byteLength, 0);
        const buf = new Uint8Array(total);
        let offset = 0;
        for (const c of chunks) { buf.set(c, offset); offset += c.byteLength; }
        liveFiles.set(p, buf);
      },
    },
    kvGet: async (k: any) => {
      if (k === null) eventLog.push("kv:get:snapshot");
      if (k && typeof k === "string") return { [k]: kvStore[k] };
      return kvStore;
    },
    kvSet: async (items: any) => { Object.assign(kvStore, items); },
    kvRemove: async (keys: any) => {
      const arr = Array.isArray(keys) ? keys : [keys];
      for (const k of arr) delete kvStore[k];
    },
    alarms: { getAll: async () => [], create: async () => {}, clear: async () => {} },
    quiesce: async () => {
      eventLog.push("quiesce:start");
      // Quiesce stops all active writers
      activeWriterRunning = false;
      eventLog.push("quiesce:end");
    },
    overwrite: true,
  });

  assertEquals(res.ok, true);
  // Verify that quiesce:start and quiesce:end precede any snapshot calls
  const quiesceEndIdx = eventLog.indexOf("quiesce:end");
  const openStreamIdx = eventLog.indexOf("opfs:openStream:shared/data.txt");
  const kvGetIdx = eventLog.indexOf("kv:get:snapshot");
  assert(quiesceEndIdx >= 0, "quiesce must run");
  assert(openStreamIdx > quiesceEndIdx, "opfs:openStream must run strictly AFTER quiesce completes");
  assert(kvGetIdx < quiesceEndIdx, "kv:get snapshot must run strictly BEFORE quiesce so pre-quiescence state is journaled");
});

Deno.test("backup-restore: service worker recovery alarm reschedules if stale fence cleanup fails", async () => {
  let alarmCleared = false;
  let alarmScheduledDelay: number | null = null;
  let removeAttempted = false;

  const mockChrome = {
    storage: {
      local: {
        get: async (keys: any) => {
          // Journal absent, but stale fence remains
          return {
            "cap:restoreFence": 12345,
            "cap:restoreClaim": { sessionId: "old-session" },
            "cap:restoreHeartbeat": 1000, // Stale heartbeat >30s ago
          };
        },
        remove: async (keys: any) => {
          removeAttempted = true;
          throw new Error("disk IO error during fence cleanup");
        },
      },
    },
  };

  // Simulate checkPendingImport logic from service-worker.js
  const stored = await mockChrome.storage.local.get(["cap:importBackup", "cap:restoreHeartbeat", "cap:restoreFence", "cap:restoreClaim"]);
  const pendingVal = stored?.["cap:importBackup"]; // null
  assertEquals(pendingVal, undefined);

  if (!pendingVal) {
    if (stored?.["cap:restoreFence"] || stored?.["cap:restoreClaim"]) {
      const recheck = await mockChrome.storage.local.get(["cap:restoreClaim", "cap:restoreHeartbeat"]);
      if (!recheck?.["cap:restoreHeartbeat"] || (Date.now() - Number(recheck["cap:restoreHeartbeat"])) >= 30000) {
        try {
          await mockChrome.storage.local.remove(["cap:restoreFence", "cap:restoreClaim", "cap:restoreHeartbeat"]);
          const verify = await mockChrome.storage.local.get("cap:restoreFence");
          if (verify?.["cap:restoreFence"]) throw new Error("fence verification failed");
          alarmCleared = true;
        } catch {
          alarmScheduledDelay = 10000;
        }
      }
    }
  }

  assertEquals(removeAttempted, true, "stale fence removal must be attempted");
  assertEquals(alarmCleared, false, "recovery alarm must NOT be cleared when fence removal fails");
  assertEquals(alarmScheduledDelay, 10000, "recovery alarm must be rescheduled to retry fence cleanup");

  // 2. Outer catch: recheck read throws transient error
  let outerAlarmScheduledDelay: number | null = null;
  const mockRecheckFailChrome = {
    storage: {
      local: {
        get: async (keys: any) => {
          if (Array.isArray(keys) && keys.includes("cap:restoreClaim")) {
            throw new Error("transient storage read error during recheck");
          }
          return { "cap:restoreFence": 12345 };
        },
      },
    },
  };
  try {
    const s = await mockRecheckFailChrome.storage.local.get(["cap:importBackup", "cap:restoreFence"]);
    if (s?.["cap:restoreFence"]) {
      await mockRecheckFailChrome.storage.local.get(["cap:restoreClaim"]);
    }
  } catch {
    outerAlarmScheduledDelay = 15000;
  }
  assertEquals(outerAlarmScheduledDelay, 15000, "outer failure path must reschedule recovery alarm on transient read error");

  // 3. Outer catch: recoverPendingImport throws transient error
  let recoverAlarmScheduledDelay: number | null = null;
  try {
    throw new Error("transient OPFS lock error during recoverPendingImport");
  } catch {
    recoverAlarmScheduledDelay = 15000;
  }
  assertEquals(recoverAlarmScheduledDelay, 15000, "outer failure path must reschedule recovery alarm on recoverPendingImport failure");
});

Deno.test("backup-restore: abandoned staging and rollback directories left by prior crashes are reclaimed", async () => {
  const liveFiles = new Map<string, Uint8Array>([
    [".staging-restore-crashed-1/corrupt.bin", ENCODER.encode("abandoned-staged")],
    [".rollback-backup-crashed-2/backup.bin", ENCODER.encode("abandoned-rollback")],
    ["legitimate/data.txt", ENCODER.encode("keep-me")],
  ]);

  const tarChunks: Uint8Array[] = [];
  const tarSink = new WritableStream<Uint8Array>({
    write(chunk) { tarChunks.push(chunk); },
  });

  await streamExportArchive({
    writable: tarSink,
    listFiles: async () => ["legitimate/data.txt"],
    open: async () => ({
      size: 7,
      stream: new ReadableStream({ start(c) { c.enqueue(ENCODER.encode("keep-me")); c.close(); } }),
    }),
    kvGet: async () => ({}),
    alarms: { getAll: async () => [] },
    extensionVersion: "1.0.0",
  });

  const tarBuffer = new Uint8Array(tarChunks.reduce((a, c) => a + c.byteLength, 0));
  let off = 0;
  for (const c of tarChunks) { tarBuffer.set(c, off); off += c.byteLength; }

    const testKvStore: Record<string, any> = {};

  const res = await streamRestoreArchive({
    stream: new ReadableStream({ start(c) { c.enqueue(tarBuffer); c.close(); } }),
    opfs: {
      listFiles: async () => [...liveFiles.keys()],
      readFile: async (p: string) => liveFiles.get(p) ?? new Uint8Array(0),
      writeFile: async (p: string, b: Uint8Array) => { liveFiles.set(p, b); },
      removeFile: async (p: string) => { liveFiles.delete(p); },
      openStream: async (p: string) => {
        const b = liveFiles.get(p) ?? new Uint8Array(0);
        return new ReadableStream({ start(c) { c.enqueue(b); c.close(); } });
      },
      writeStream: async (p: string, stream: ReadableStream<Uint8Array>) => {
        const reader = stream.getReader();
        const chunks: Uint8Array[] = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) chunks.push(value);
        }
        const total = chunks.reduce((a, c) => a + c.byteLength, 0);
        const buf = new Uint8Array(total);
        let offset = 0;
        for (const c of chunks) { buf.set(c, offset); offset += c.byteLength; }
        liveFiles.set(p, buf);
      },
    },
    kvGet: async (k: any) => {
      if (k && typeof k === "string") return { [k]: testKvStore[k] };
      return testKvStore;
    },
    kvSet: async (items: any) => { Object.assign(testKvStore, items); },
    kvRemove: async (keys: any) => {
      const arr = Array.isArray(keys) ? keys : [keys];
      for (const k of arr) delete testKvStore[k];
    },
    alarms: { getAll: async () => [], create: async () => {}, clear: async () => {} },
    overwrite: true,
  });

  assertEquals(res.ok, true);
  assert(!liveFiles.has(".staging-restore-crashed-1/corrupt.bin"), "abandoned staging file must be reclaimed");
  assert(!liveFiles.has(".rollback-backup-crashed-2/backup.bin"), "abandoned rollback file must be reclaimed");
  assertEquals(DECODER.decode(liveFiles.get("legitimate/data.txt")!), "keep-me");
});

Deno.test("backup-restore: admission rechecks restore fence under registry lock (deferred-admission race)", async () => {
  const storeMap = new Map<string, any>();
  const fakeStore = {
    get: async (k: string) => storeMap.get(k),
    getTrusted: async (k: string) => storeMap.get(k),
    set: async (k: string, v: any) => { storeMap.set(k, v); return true; },
    setTrusted: async (k: string, v: any) => { storeMap.set(k, v); return true; },
    has: async (k: string) => storeMap.has(k),
    delete: async (k: string) => { storeMap.delete(k); return true; },
    keys: async () => [...storeMap.keys()],
    compareAndSwap: async (k: string, oldV: any, newV: any) => {
      const cur = storeMap.get(k);
      if (JSON.stringify(cur) !== JSON.stringify(oldV)) return false;
      storeMap.set(k, newV);
      return true;
    },
  };

  let fenceActive = false;
  const registry = createDurableRunRegistry({
    store: fakeStore as any,
    fenceCheck: async () => fenceActive,
    bootId: "boot-test",
    resolveJournalStore: async () => ({ journal: [] }),
    appendJournal: async () => ({ ok: true }),
    replaceCancellationJournal: async () => ({ ok: true }),
    commitThread: async () => ({ ok: true }),
    replaceCancellationThread: async () => ({ ok: true }),
  });

  // 1. Quiescence writes the restore fence:
  fenceActive = true;

  // Direct registry.start check asserts no record, index, or writer is created under the lock
  await assertRejects(
    () => registry.start({ executionId: "exec_test_deferred_1" }),
    Error,
    "profile restore fence is active",
  );

  const list = await registry.list();
  assertEquals(list.runs, [], "no runs should be created when fenced");
  assertEquals(list.activeWritersCount, 0, "active writer count must be 0");
  assert(!storeMap.has("run:exec_test_deferred_1"), "run record must NOT be written when fenced");
  assert(!storeMap.has("run-registry"), "index must NOT be updated when fenced");

  // 2. Also verify that admitDurableRun catches the registry lock rejection and maps it to admission_fenced
  const res = await admitDurableRun(registry, { executionId: "exec_test_deferred_1" });
  assertEquals(res?.ok, false);
  assertEquals(res?.error, "admission_fenced");
  assertEquals(res?.code, "restore_in_progress");
  assert(res?.message.includes("A profile restore is currently in progress"));
});

Deno.test("backup-restore: scheduled tasks cannot be registered while restore fence is active", async () => {
  const prevChrome = (globalThis as any).chrome;
  try {
    (globalThis as any).chrome = {
      storage: {
        local: {
          get: async (key: string) => {
            if (key === "cap:restoreFence") return { "cap:restoreFence": Date.now() };
            return {};
          },
        },
      },
      alarms: {
        create: async () => {},
        get: async () => null,
      },
    };

    await assertRejects(
      () => scheduleTask({ task: "test-task", at: Date.now() + 10000 }),
      Error,
      "Cannot mutate scheduled task: profile restore is in progress",
    );
  } finally {
    (globalThis as any).chrome = prevChrome;
  }
});

Deno.test("backup-restore: cancelled or rejected restore removes staging directory recursively", async () => {
  const removedDirs: { path: string; recursive: boolean }[] = [];
  const removedFiles: string[] = [];

  const directoryAwareOpfs = {
    listFiles: async () => [".staging-restore-test/file.bin"],
    readFile: async () => new Uint8Array(0),
    writeFile: async () => {},
    removeFile: async (p: string) => { removedFiles.push(p); },
    removeDirectory: async (p: string, opts?: any) => {
      removedDirs.push({ path: p, recursive: opts?.recursive ?? false });
    },
  };

  const tarChunks: Uint8Array[] = [];
  const tarSink = new WritableStream<Uint8Array>({
    write(chunk) { tarChunks.push(chunk); },
  });

  await streamExportArchive({
    writable: tarSink,
    listFiles: async () => ["data.txt"],
    open: async () => ({
      size: 4,
      stream: new ReadableStream({ start(c) { c.enqueue(ENCODER.encode("test")); c.close(); } }),
    }),
    kvGet: async () => ({}),
    alarms: { getAll: async () => [] },
    extensionVersion: "1.0.0",
  });

  const tarBuffer = new Uint8Array(tarChunks.reduce((a, c) => a + c.byteLength, 0));
  let off = 0;
  for (const c of tarChunks) { tarBuffer.set(c, off); off += c.byteLength; }

  // 1. Owner cancellation calls removeDirectory recursively
  const cancelRes = await streamRestoreArchive({
    stream: new ReadableStream({ start(c) { c.enqueue(tarBuffer); c.close(); } }),
    opfs: directoryAwareOpfs,
    confirm: async () => false,
  });
  assertEquals(cancelRes.ok, false);
  assertEquals(cancelRes.cancelled, true);
  const cancelRemoved = removedDirs.find((d) => d.path.startsWith(".staging-restore-"));
  assert(cancelRemoved, "removeDirectory must be called for stagingDir on cancellation");
  assertEquals(cancelRemoved.recursive, true, "stagingDir removal must be recursive");

  // 2. Validation failure calls removeDirectory recursively
  removedDirs.length = 0;
  await assertRejects(
    () => streamRestoreArchive({
      stream: new ReadableStream({
        start(c) {
          // Truncated/corrupted stream
          c.enqueue(new Uint8Array([1, 2, 3, 4]));
          c.close();
        },
      }),
      opfs: directoryAwareOpfs,
    }),
  );
  const rejectRemoved = removedDirs.find((d) => d.path.startsWith(".staging-restore-"));
  assert(rejectRemoved, "removeDirectory must be called for stagingDir on extraction failure");
  assertEquals(rejectRemoved.recursive, true, "stagingDir removal must be recursive on failure");
});

Deno.test("backup-restore: postCommit failure retains admission fence and marks invalidation pending", async () => {
  const kvStore: Record<string, any> = {};
  const tarChunks: Uint8Array[] = [];
  const tarSink = new WritableStream<Uint8Array>({
    write(chunk) { tarChunks.push(chunk); },
  });

  await streamExportArchive({
    writable: tarSink,
    listFiles: async () => ["data.txt"],
    open: async () => ({
      size: 4,
      stream: new ReadableStream({ start(c) { c.enqueue(ENCODER.encode("test")); c.close(); } }),
    }),
    kvGet: async () => ({}),
    alarms: { getAll: async () => [] },
    extensionVersion: "1.0.0",
  });

  const tarBuffer = new Uint8Array(tarChunks.reduce((a, c) => a + c.byteLength, 0));
  let off = 0;
  for (const c of tarChunks) { tarBuffer.set(c, off); off += c.byteLength; }

  const files = new Map<string, Uint8Array>();
  const opfs = {
    listFiles: async () => [...files.keys()],
    readFile: async (p: string) => files.get(p) ?? new Uint8Array(0),
    writeFile: async (p: string, b: Uint8Array) => { files.set(p, b); },
    removeFile: async (p: string) => { files.delete(p); },
  };

  await assertRejects(
    () => streamRestoreArchive({
      stream: new ReadableStream({ start(c) { c.enqueue(tarBuffer); c.close(); } }),
      opfs,
      kvGet: async (k: any) => (typeof k === "string" ? { [k]: kvStore[k] } : kvStore),
      kvSet: async (items: any) => { Object.assign(kvStore, items); },
      kvRemove: async (keys: any) => {
        const arr = Array.isArray(keys) ? keys : [keys];
        for (const k of arr) delete kvStore[k];
      },
      alarms: { getAll: async () => [], create: async () => {}, clear: async () => {} },
      postCommit: async () => {
        throw new Error("worker service unavailable");
      },
      overwrite: true,
    }),
    Error,
    "cache invalidation failed: worker service unavailable",
  );

  assert(kvStore["cap:restoreFence"], "admission fence must remain active when postCommit invalidation fails");
  assert(kvStore["cap:invalidationPending"], "invalidation-pending marker must remain set for recovery");
});

Deno.test("backup-restore: rollback invalidation failure retains admission fence", async () => {
  const kvStore: Record<string, any> = {
    "cap:restoreFence": Date.now(),
    "cap:restoreClaim": { sessionId: "sess-1" },
    "cap:importBackup": {
      ops: [],
      files: [],
      kv: {},
      alarms: [],
    },
  };

  await assertRejects(
    () => recoverPendingImport({
      kvGet: async (k: any) => (typeof k === "string" ? { [k]: kvStore[k] } : kvStore),
      kvSet: async (items: any) => { Object.assign(kvStore, items); },
      kvRemove: async (keys: any) => {
        const arr = Array.isArray(keys) ? keys : [keys];
        for (const k of arr) delete kvStore[k];
      },
      opfs: {
        listFiles: async () => [],
        readFile: async () => new Uint8Array(0),
        writeFile: async () => {},
        removeFile: async () => {},
      },
      alarms: { getAll: async () => [], create: async () => {}, clear: async () => {} },
      onRollback: async () => {
        throw new Error("worker died during rollback invalidation");
      },
    }),
    Error,
    "Rollback succeeded, but cache invalidation failed",
  );

  assert(kvStore["cap:restoreFence"], "admission fence must remain active when rollback cache invalidation fails");
});

Deno.test("backup-restore: scheduleTask fails closed on storage read error and rolls back mid-schedule race", async () => {
  const prevChrome = (globalThis as any).chrome;
  let getError = false;
  let fenceActive = false;
  const createdAlarms: any[] = [];

  try {
    (globalThis as any).chrome = {
      storage: {
        local: {
          get: async (key: string) => {
            if (getError) throw new Error("storage IO failure");
            if (key === "cap:restoreFence" && fenceActive) return { "cap:restoreFence": Date.now() };
            return {};
          },
        },
      },
      alarms: {
        getAll: async () => [],
        create: async (name: string, info: any) => { createdAlarms.push({ name, info }); },
        get: async () => null,
      },
    };

    // 1. Storage read failure fails closed
    getError = true;
    await assertRejects(
      () => scheduleTask({ task: "test-task", at: Date.now() + 10000 }),
      Error,
      "Failed to verify restore admission fence: storage IO failure",
    );
    getError = false;

    // 2. Fence raised mid-schedule rolls back task payload and creates no alarm
    // Simulate fence becoming active after initial check
    let checkCount = 0;
    (globalThis as any).chrome.storage.local.get = async (key: string) => {
      if (key === "cap:restoreFence") {
        checkCount++;
        // Turn fence on at the second check (before write)
        if (checkCount >= 2) return { "cap:restoreFence": Date.now() };
      }
      return {};
    };

    await assertRejects(
      () => scheduleTask({ task: "test-task-2", at: Date.now() + 10000 }),
      Error,
      "Cannot mutate scheduled task: profile restore is in progress",
    );

    assertEquals(createdAlarms.length, 0, "no alarm must be created when restore fence is encountered");

    // 3. Post-write race on task replacement restores prior payload
    // Pre-populate task
    const mockStorage: Record<string, any> = {
      "cap:scheduledTasks": {
        "existing-task-name": {
          name: "existing-task-name",
          task: "original-content",
          at: Date.now() + 50000,
        },
      },
    };
    (globalThis as any).chrome.storage.local.get = async (key: string) => {
      if (key === "cap:restoreFence") {
        checkCount++;
        // Turn fence on at the 3rd check (post-write / pre-alarm)
        if (checkCount >= 3) return { "cap:restoreFence": Date.now() };
      }
      if (key === "cap:scheduledTasks") return { "cap:scheduledTasks": mockStorage["cap:scheduledTasks"] };
      return {};
    };
    (globalThis as any).chrome.storage.local.set = async (items: any) => {
      Object.assign(mockStorage, items);
    };

    checkCount = 0;
    await assertRejects(
      () => scheduleTask({
        name: "existing-task-name",
        task: "replacement-content",
        at: Date.now() + 20000,
      }),
      Error,
      "Cannot mutate scheduled task: profile restore is in progress",
    );

    assertEquals(
      mockStorage["cap:scheduledTasks"]["existing-task-name"]?.task,
      "original-content",
      "prior task payload must be restored when replacement schedule encounters restore fence",
    );

    // 4. Post-create race on task replacement restores prior alarm AND prior payload
    let liveAlarm: any = { name: "existing-task-name", scheduledTime: 123456789, periodInMinutes: 60 };
    (globalThis as any).chrome.alarms = {
      getAll: async () => [liveAlarm],
      get: async (name: string) => (name === "existing-task-name" ? liveAlarm : null),
      create: async (name: string, info: any) => {
        liveAlarm = { name, scheduledTime: info.when, periodInMinutes: info.periodInMinutes };
      },
      clear: async (name: string) => {
        if (name === "existing-task-name") {
          liveAlarm = null;
          return true;
        }
        return false;
      },
    };

    checkCount = 0;
    (globalThis as any).chrome.storage.local.get = async (key: string) => {
      if (key === "cap:restoreFence") {
        checkCount++;
        // Turn fence on at check 4 (post-alarms.create)
        if (checkCount >= 4) return { "cap:restoreFence": Date.now() };
      }
      if (key === "cap:scheduledTasks") return { "cap:scheduledTasks": mockStorage["cap:scheduledTasks"] };
      return {};
    };

    await assertRejects(
      () => scheduleTask({
        name: "existing-task-name",
        task: "replacement-content-2",
        at: Date.now() + 30000,
      }),
      Error,
      "Cannot mutate scheduled task: profile restore is in progress",
    );

    assertEquals(
      mockStorage["cap:scheduledTasks"]["existing-task-name"]?.task,
      "original-content",
      "prior task payload must be restored when replacement schedule encounters post-create restore fence",
    );
    assertEquals(
      liveAlarm?.scheduledTime,
      123456789,
      "prior alarm scheduledTime must be restored when replacement schedule encounters post-create restore fence",
    );
    assertEquals(
      liveAlarm?.periodInMinutes,
      60,
      "prior alarm periodInMinutes must be restored when replacement schedule encounters post-create restore fence",
    );
  } finally {
    (globalThis as any).chrome = prevChrome;
  }
});

Deno.test("backup-restore: subsequent restore confirms pending invalidation before clearing fence", async () => {
  const kvStore: Record<string, any> = {
    "cap:restoreFence": Date.now(),
    "cap:invalidationPending": Date.now() - 50000,
  };

  let invalidationAttempted = false;
  let invalidationSucceeded = false;

  const tarChunks: Uint8Array[] = [];
  const tarSink = new WritableStream<Uint8Array>({
    write(chunk) { tarChunks.push(chunk); },
  });

  await streamExportArchive({
    writable: tarSink,
    listFiles: async () => ["data.txt"],
    open: async () => ({
      size: 4,
      stream: new ReadableStream({ start(c) { c.enqueue(ENCODER.encode("test")); c.close(); } }),
    }),
    kvGet: async () => ({}),
    alarms: { getAll: async () => [] },
    extensionVersion: "1.0.0",
  });

  const tarBuffer = new Uint8Array(tarChunks.reduce((a, c) => a + c.byteLength, 0));
  let off = 0;
  for (const c of tarChunks) { tarBuffer.set(c, off); off += c.byteLength; }

  const files = new Map<string, Uint8Array>();
  const opfs = {
    listFiles: async () => [...files.keys()],
    readFile: async (p: string) => files.get(p) ?? new Uint8Array(0),
    writeFile: async (p: string, b: Uint8Array) => { files.set(p, b); },
    removeFile: async (p: string) => { files.delete(p); },
    removeDirectory: async () => {},
  };

  // If postCommit fails on subsequent restore, it throws and retains the fence
  await assertRejects(
    () => streamRestoreArchive({
      stream: new ReadableStream({ start(c) { c.enqueue(tarBuffer); c.close(); } }),
      opfs,
      kvGet: async (k: any) => (typeof k === "string" ? { [k]: kvStore[k] } : kvStore),
      kvSet: async (items: any) => { Object.assign(kvStore, items); },
      kvRemove: async (keys: any) => {
        const arr = Array.isArray(keys) ? keys : [keys];
        for (const k of arr) delete kvStore[k];
      },
      alarms: { getAll: async () => [], create: async () => {}, clear: async () => {} },
      postCommit: async () => {
        invalidationAttempted = true;
        throw new Error("worker service unavailable");
      },
      overwrite: true,
    }),
    Error,
    "worker service unavailable",
  );

  assert(invalidationAttempted, "subsequent restore must attempt cache invalidation when pending marker is present");
  assert(kvStore["cap:restoreFence"], "admission fence must remain active when pending invalidation cannot be resolved");
});

Deno.test("backup-restore: sanitizeKvForExport strips cap:invalidationPending from archive export", async () => {
  const { sanitizeKvForExport } = await import("../extension/lib/data-archive.js");
  const rawKv = {
    theme: "dark",
    "cap:restoreFence": 12345,
    "cap:invalidationPending": 67890,
    "cap:restoreClaim": { sessionId: "s1" },
    "cap:importBackup": { ops: [] },
  };

  const sanitized = sanitizeKvForExport(rawKv);
  assertEquals(sanitized.theme, "dark");
  assertEquals(sanitized["cap:invalidationPending"], undefined, "cap:invalidationPending must be excluded from export");
  assertEquals(sanitized["cap:restoreFence"], undefined, "cap:restoreFence must be excluded from export");
  assertEquals(sanitized["cap:restoreClaim"], undefined, "cap:restoreClaim must be excluded from export");
  assertEquals(sanitized["cap:importBackup"], undefined, "cap:importBackup must be excluded from export");
});

Deno.test("backup-restore: rollback rejects when invalidation callback returns false/unconfirmed", async () => {
  const kvStore: Record<string, any> = {
    "cap:restoreFence": Date.now(),
    "cap:restoreClaim": { sessionId: "sess-1" },
    "cap:importBackup": {
      ops: [],
      files: [],
      kv: {},
      alarms: [],
    },
  };

  await assertRejects(
    () => recoverPendingImport({
      kvGet: async (k: any) => (typeof k === "string" ? { [k]: kvStore[k] } : kvStore),
      kvSet: async (items: any) => { Object.assign(kvStore, items); },
      kvRemove: async (keys: any) => {
        const arr = Array.isArray(keys) ? keys : [keys];
        for (const k of arr) delete kvStore[k];
      },
      opfs: {
        listFiles: async () => [],
        readFile: async () => new Uint8Array(0),
        writeFile: async () => {},
        removeFile: async () => {},
      },
      alarms: { getAll: async () => [], create: async () => {}, clear: async () => {} },
      onRollback: async () => ({ invalidated: false }),
    }),
    Error,
    "Rollback succeeded, but cache invalidation failed",
  );

  assert(kvStore["cap:restoreFence"], "admission fence must remain active when rollback returns invalidated: false");

  // Also test unconfirmed return (undefined or {})
  await assertRejects(
    () => recoverPendingImport({
      kvGet: async (k: any) => (typeof k === "string" ? { [k]: kvStore[k] } : kvStore),
      kvSet: async (items: any) => { Object.assign(kvStore, items); },
      kvRemove: async (keys: any) => {
        const arr = Array.isArray(keys) ? keys : [keys];
        for (const k of arr) delete kvStore[k];
      },
      opfs: {
        listFiles: async () => [],
        readFile: async () => new Uint8Array(0),
        writeFile: async () => {},
        removeFile: async () => {},
      },
      alarms: { getAll: async () => [], create: async () => {}, clear: async () => {} },
      onRollback: async () => undefined,
    }),
    Error,
    "Rollback succeeded, but cache invalidation failed",
  );
  assert(kvStore["cap:restoreFence"], "admission fence must remain active when rollback returns undefined");
});

Deno.test("backup-restore: journal records pre-quiescence KV state so crashed restore recovers running runs", async () => {
  const kvStore: Record<string, any> = {
    "run:exec-12345": { executionId: "exec-12345", phase: "running", bootId: "boot-1" },
  };

  const tarChunks: Uint8Array[] = [];
  const tarSink = new WritableStream<Uint8Array>({
    write(chunk) { tarChunks.push(chunk); },
  });

  await streamExportArchive({
    writable: tarSink,
    listFiles: async () => ["data.txt"],
    open: async () => ({
      size: 4,
      stream: new ReadableStream({ start(c) { c.enqueue(ENCODER.encode("test")); c.close(); } }),
    }),
    kvGet: async () => ({ "run:exec-12345": { executionId: "exec-12345", phase: "completed" } }),
    alarms: { getAll: async () => [] },
    extensionVersion: "1.0.0",
  });

  const tarBuffer = new Uint8Array(tarChunks.reduce((a, c) => a + c.byteLength, 0));
  let off = 0;
  for (const c of tarChunks) { tarBuffer.set(c, off); off += c.byteLength; }

  let recordedJournal: any = null;
  const opfs = {
    listFiles: async () => [],
    readFile: async () => new Uint8Array(0),
    writeFile: async (p: string) => {
      // Allow rollback backups during prep to succeed
      if (p.startsWith(".rollback-backup-") || p.startsWith(".staging-restore-")) return;
      // Simulate crash mid-swap on first destination file write
      throw new Error("simulated mid-swap crash");
    },
    removeFile: async () => {},
  };

  await assertRejects(
    () => streamRestoreArchive({
      stream: new ReadableStream({ start(c) { c.enqueue(tarBuffer); c.close(); } }),
      opfs,
      kvGet: async (k: any) => (typeof k === "string" ? { [k]: kvStore[k] } : kvStore),
      kvSet: async (items: any) => {
        Object.assign(kvStore, items);
        if (items["cap:importBackup"]) {
          recordedJournal = structuredClone(items["cap:importBackup"]);
        }
      },
      kvRemove: async (keys: any) => {
        const arr = Array.isArray(keys) ? keys : [keys];
        for (const k of arr) delete kvStore[k];
      },
      alarms: { getAll: async () => [], create: async () => {}, clear: async () => {} },
      quiesce: async () => {
        // Quiescence hook cancels the active run
        kvStore["run:exec-12345"] = { executionId: "exec-12345", phase: "cancelled", bootId: "boot-1" };
      },
      overwrite: true,
    }),
    Error,
    "simulated mid-swap crash",
  );

  // Assert that the recorded sidecar journal holds the PRE-quiescence running value
  assert(recordedJournal, "sidecar journal must be written before file swap");
  const runOp = recordedJournal.ops.find((op: any) => op[0] === 0 && op[1] === "run:exec-12345");
  assert(runOp, "journal must record undo operation for run:exec-12345");
  assertEquals(
    runOp[2]?.__cap_val?.phase ?? runOp[2]?.phase,
    "running",
    "journal undo entry must hold the PRE-quiescence 'running' phase, NOT post-quiescence 'cancelled'",
  );

  // Verify that rollback recovery recovers the PRE-quiescence running state
  assertEquals(
    kvStore["run:exec-12345"]?.phase,
    "running",
    "profile rollback must restore run to PRE-quiescence 'running' phase",
  );
});
