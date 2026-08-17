// Unit test for the image-attachment fix (Paul 2026-08-17): the image bytes
// must reach the model as a MULTIMODAL vision part, and the attachment must be
// persisted + rendered in the conversation.
// @ts-nocheck — the attachment shapes are intentionally dynamic.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { buildMultimodalTask, sanitizeAttachments } from "../extension/lib/attachments.js";

const IMG = "data:image/png;base64,iVBORw0KGgo=";

Deno.test("buildMultimodalTask: no image attachments → the plain task string", () => {
  const r = buildMultimodalTask("summarise this", [
    { name: "notes.txt", type: "text/plain", size: 10, kind: "file", dataURL: "data:text/plain;base64,aGVsbG8=" },
  ]);
  assertEquals(r, "summarise this");
});

Deno.test("buildMultimodalTask: an image becomes a text + image part array", () => {
  const r = buildMultimodalTask("summarise this", [
    { name: "shot.png", type: "image/png", size: 5, kind: "file", dataURL: IMG },
  ]);
  assert(Array.isArray(r), "an image attachment must produce a multimodal content array");
  assertEquals(r.length, 2);
  assertEquals(r[0], { type: "text", text: "summarise this" });
  assertEquals(r[1], { type: "image", image: IMG });
});

Deno.test("buildMultimodalTask: multiple images → multiple image parts", () => {
  const r = buildMultimodalTask("compare", [
    { name: "a.png", type: "image/png", size: 1, dataURL: IMG },
    { name: "b.jpg", type: "image/jpeg", size: 1, dataURL: "data:image/jpeg;base64,QQ==" },
    { name: "c.txt", type: "text/plain", size: 1, dataURL: "data:text/plain;base64,QQ==" },
  ]);
  assert(Array.isArray(r));
  assertEquals(r.length, 3); // text + 2 image parts (the text file is not an image part)
  assertEquals(r.filter((p) => p.type === "image").length, 2);
});

Deno.test("buildMultimodalTask: a data:image URL without a type is still an image part", () => {
  const r = buildMultimodalTask("look", [{ name: "x", type: "", size: 1, dataURL: IMG }]);
  assert(Array.isArray(r));
  assertEquals(r[1], { type: "image", image: IMG });
});

Deno.test("sanitizeAttachments: keeps metadata + dataURL, drops the live File, bounds the URL", () => {
  const file = {};
  const r = sanitizeAttachments([
    { name: "pic.png", type: "image/png", size: 123, kind: "file", dataURL: IMG, file },
  ]);
  assertEquals(r.length, 1);
  assertEquals(r[0].name, "pic.png");
  assertEquals(r[0].dataURL, IMG);
  assertEquals("file" in r[0], false);
  // A >2MB dataURL is dropped (bounded), the metadata survives.
  const huge = "data:image/png;base64," + "A".repeat(2 * 1024 * 1024 + 10);
  const r2 = sanitizeAttachments([{ name: "big.png", type: "image/png", size: 1, dataURL: huge }]);
  assertEquals(r2[0].dataURL, "");
  assertEquals(r2[0].name, "big.png");
});

Deno.test("sanitizeAttachments: empty/non-array → undefined", () => {
  assertEquals(sanitizeAttachments([]), undefined);
  assertEquals(sanitizeAttachments(null), undefined);
  assertEquals(sanitizeAttachments(undefined), undefined);
});
