// tests/backup-restore.test.ts
// chrome-agent-platform-d885.8: tests for streaming TAR restore driver and options wiring.
// @ts-nocheck

import { assert, assertEquals } from "jsr:@std/assert@1";
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
