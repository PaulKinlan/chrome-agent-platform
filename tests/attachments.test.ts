// Unit test for the image-attachment fix (Paul 2026-08-17): the image bytes
// must reach the model as a MULTIMODAL vision part, and the attachment must be
// persisted + rendered in the conversation.
// @ts-nocheck — the attachment shapes are intentionally dynamic.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  attachmentContext,
  buildMultimodalTask,
  isTextLikeAttachment,
  MAX_LOCAL_TEXT_BYTES,
  sanitizeAttachments,
  textToDataUrl,
} from "../extension/lib/attachments.js";

const IMG = "data:image/png;base64,iVBORw0KGgo=";

Deno.test("local file attachments: text detection and UTF-8 data URLs are bounded inputs", () => {
  assertEquals(MAX_LOCAL_TEXT_BYTES, 1024 * 1024);
  assert(isTextLikeAttachment({ name: "report.md", type: "" }));
  assert(isTextLikeAttachment({ name: "data", type: "application/json" }));
  assertEquals(isTextLikeAttachment({ name: "photo.png", type: "image/png" }), false);
  const url = textToDataUrl("héllo", "text/plain");
  assert(url.startsWith("data:text/plain;charset=utf-8;base64,"));
  assertEquals(new TextDecoder().decode(Uint8Array.from(atob(url.split(",")[1]), (c) => c.charCodeAt(0))), "héllo");
});

Deno.test("attachmentContext preserves UTF-8 text in agent-facing context", () => {
  const text = "Report body ✓";
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const context = attachmentContext([{
    name: "report.txt",
    type: "text/plain",
    size: bytes.length,
    kind: "file",
    dataURL: `data:text/plain;base64,${btoa(binary)}`,
  }]);
  assertStringIncludes(context, text);
  assert(!context.includes("â"), "UTF-8 bytes must not be treated as Latin-1");
});

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

Deno.test("attachArtifactToComposer: the Reuse path emits the canonical artifact attachment (kind + exact ref)", async () => {
  // The NTP's single Reuse path (full browser + quick drawer) must attach the
  // canonical artifact shape so the SW's attachmentContext re-emits the exact
  // `asset:origin/id` ref. A source-level regression: kind must be "artifact"
  // and the three artifact identity fields must be present.
  const src = await Deno.readTextFile("extension/ntp/ntp.js");
  const fn = src.match(/async function attachArtifactToComposer[\s\S]*?\n}/);
  assert(fn, "attachArtifactToComposer must exist");
  const add = fn[0].match(/composer\.addAttachment\(\{[\s\S]*?\}\);/);
  assert(add, "the Reuse path must attach via composer.addAttachment");
  const body = add[0];
  assert(/kind:\s*"artifact"/.test(body), "kind must be artifact (not file)");
  assert(/artifactId:\s*artifact\.id/.test(body), "artifactId must come from the fetched artifact");
  assert(/artifactOrigin:\s*artifact\.origin/.test(body), "artifactOrigin must come from the fetched artifact");
  assert(/artifactType:\s*artifact\.type/.test(body), "artifactType must come from the fetched artifact");
  // The exact-ref source fields are retained too (name/type/size/dataURL/content).
  assert(/dataURL:/ .test(body) && /content:/ .test(body) && /name:/ .test(body), "name/type/size/data/content retained");
});

Deno.test("ntp: the standalone Skills button is GONE (skills live in Settings now)", async () => {
  const src = await Deno.readTextFile("extension/ntp/ntp.js");
  const html = await Deno.readTextFile("extension/ntp/ntp.html");
  // No button, no listener, no standalone view route — a reintroduction fails here.
  assert(!html.includes("open-recipes"), "open-recipes button must not exist in ntp.html");
  assert(!src.includes("open-recipes"), "open-recipes listener must not exist in ntp.js");
  assert(!src.includes("VIEW_ROUTE.SKILLS"), "the standalone SKILLS route must stay removed");
});

Deno.test("ntp: the cap:attach-artifact handler is ONE canonical attachment — no dead inline get/add/close/status", async () => {
  const src = await Deno.readTextFile("extension/ntp/ntp.js");
  const start = src.indexOf('window.addEventListener("message"');
  const marker = src.indexOf("cap:attach-artifact", start);
  const call = src.indexOf("attachArtifactToComposer", marker);
  assert(start >= 0 && marker > start && call > marker, "the cap:attach-artifact handler block missing");
  // The block spans from the listener to the end of the handler function.
  const end = src.indexOf("\n});", call);
  assert(end > call, "the handler block has no closing brace");
  const block = src.slice(start, end + 4);
  // Exactly ONE asset.get (inside attachArtifactToComposer) — never a duplicate
  // inline get in the message handler.
  const gets = (block.match(/asset\.get/g) ?? []).length;
  assert(gets === 1, `cap:attach-artifact handler issues ${gets} asset.get calls (want exactly 1)`);
  // The handler itself must not re-implement addAttachment / closeView /
  // setStatus — those live in attachArtifactToComposer.
  assert(!/composer\.addAttachment/.test(block), "the message handler re-implements addAttachment");
  assert(!/setStatus\(`Attached/.test(block), "the message handler re-implements the attach status line");
  // The canonical artifact shape lives in attachArtifactToComposer.
  const fn = src.match(/async function attachArtifactToComposer[\s\S]*?\n}/);
  assert(fn, "attachArtifactToComposer missing");
  const body = fn[0];
  assert(/kind: "artifact"/.test(body), 'attachArtifactToComposer does not emit kind:"artifact"');
  assert(/artifactId:/.test(body) && /artifactOrigin:/.test(body) && /artifactType:/.test(body), "attachArtifactToComposer missing the artifact identity fields");
});
