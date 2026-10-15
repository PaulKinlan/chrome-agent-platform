import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { exportHtmlFile, saveHtmlFile, canShareHtmlFile, shareHtmlFile } from "../extension/shared/thread-export-preview.js";

const html = '<!DOCTYPE html><html lang="en"><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"></head><body>Safe narrative</body></html>';
const response = { ok: true, html, filename: "Task report.html", mimeType: "text/html" };

Deno.test("export preview: one fixed-MIME File carries byte-identical standalone HTML", async () => {
  const file = exportHtmlFile(response);
  assertEquals(file.name, "Task report.html");
  assertEquals(file.type, "text/html");
  assertEquals(await file.text(), html);
  for (const malicious of [
    { ...response, filename: "../secrets.html" },
    { ...response, filename: "folder\\secrets.html" },
    { ...response, filename: "bad\nname.html" },
    { ...response, mimeType: "text/javascript" },
    { ...response, html: "not a standalone document" },
  ]) {
    await assertRejects(async () => exportHtmlFile(malicious));
  }
});

Deno.test("export preview: Save invokes picker adapter synchronously inside owner gesture", async () => {
  const file = exportHtmlFile(response);
  const calls: unknown[] = [];
  const save = (asset: unknown) => { calls.push(asset); return Promise.resolve({ ok: true, method: "file-picker" }); };
  const pending = saveHtmlFile(file, html, save);
  assertEquals(calls, [{ name: file.name, content: html, mimeType: "text/html" }]);
  assertEquals(await pending, { ok: true, method: "file-picker" });
});

Deno.test("export preview: Share invokes navigator.share synchronously with the same File, or declines cleanly", async () => {
  const file = exportHtmlFile(response);
  const calls: unknown[] = [];
  const navigation = {
    canShare: ({ files }: { files: File[] }) => files.length === 1 && files[0] === file,
    share: (payload: unknown) => { calls.push(payload); return Promise.resolve(); },
  };
  assert(canShareHtmlFile(file, navigation));
  const pending = shareHtmlFile(file, navigation);
  assertEquals(calls, [{ files: [file], title: file.name }]);
  assertEquals(await pending, { ok: true });
  const unavailable = await shareHtmlFile(file, { ...navigation, canShare: () => false });
  assertEquals(unavailable.ok, false);
  assertEquals("error" in unavailable ? unavailable.error : undefined, "share_unavailable");
  assertEquals(calls.length, 1, "unsupported Share must not invoke navigator.share");
});
