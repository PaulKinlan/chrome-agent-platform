// tests/backup-restore.test.ts
// chrome-agent-platform-d885.8: tests for streaming TAR restore driver and options wiring.
// @ts-nocheck

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { streamExportArchive } from "../extension/lib/backup-export.js";
import { streamRestoreArchive } from "../extension/lib/backup-restore.js";

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
  const restoredAlarms: any[] = [];
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
      clear: async () => {},
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

Deno.test("backup-restore: options.js routes .tar files to streamRestoreArchive and .json to owner.import.all", async () => {
  const code = await Deno.readTextFile("extension/options/options.js");

  // Tar detection check
  assert(
    code.includes('file.name.toLowerCase().endsWith(".tar") || file.type === "application/x-tar"'),
    "options.js must check for .tar extension or application/x-tar type",
  );

  // Streaming restore branch
  assert(
    code.includes("streamRestoreArchive({"),
    "options.js must call streamRestoreArchive for .tar backups",
  );

  // JSON fallback preservation
  assert(
    code.includes('send("owner.import.all", { raw'),
    "options.js must preserve owner.import.all for JSON backups",
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
      totalBytes: 50,
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
    "archive-bad-json",
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
    kvRemove: async () => {},
    alarms: { getAll: async () => [], create: async () => {}, clear: async () => {} },
    overwrite: true,
  });

  assertEquals(res.ok, true, "legacy JSON restore must succeed");
  assertEquals(DECODER.decode(liveFiles.get("legacy/note.txt")!), "legacy content via json");
  assertEquals(liveKv["legacy:pref"], "restored-val");
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
          if (!p.startsWith(".staging-restore-")) {
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
    assert(err.message.includes("simulated disk failure"), "expected simulated disk failure");
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
