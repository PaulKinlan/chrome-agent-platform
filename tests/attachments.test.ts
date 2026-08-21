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

Deno.test("attachAssetToComposer: the Reuse path emits the canonical artifact attachment (kind + exact ref)", async () => {
  // The NTP's single Reuse path (full browser + quick drawer) must attach the
  // canonical artifact shape so the SW's attachmentContext re-emits the exact
  // `asset:origin/id` ref. A source-level regression: kind must be "artifact"
  // and the three artifact identity fields must be present.
  const src = await Deno.readTextFile("extension/ntp/ntp.js");
  const fn = src.match(/async function attachAssetToComposer[\s\S]*?\n}/);
  assert(fn, "attachAssetToComposer must exist");
  const add = fn[0].match(/composer\.addAttachment\(\{[\s\S]*?\}\);/);
  assert(add, "the Reuse path must attach via composer.addAttachment");
  const body = add[0];
  assert(/kind:\s*"artifact"/.test(body), "kind must be artifact (not file)");
  assert(/artifactId:\s*asset\.id/.test(body), "artifactId must come from the fetched asset");
  assert(/artifactOrigin:\s*asset\.origin/.test(body), "artifactOrigin must come from the fetched asset");
  assert(/artifactType:\s*asset\.type/.test(body), "artifactType must come from the fetched asset");
  // The exact-ref source fields are retained too (name/type/size/dataURL/content).
  assert(/dataURL:/ .test(body) && /content:/ .test(body) && /name:/ .test(body), "name/type/size/data/content retained");
});

Deno.test("ntp: open-recipes listener has EXACTLY two arguments (no stray dead callback)", async () => {
  const src = await Deno.readTextFile("extension/ntp/ntp.js");
  const match = src.match(/getElementById\("open-recipes"\)\?\.[\s\S]*?\.addEventListener\([\s\S]*?\);/);
  assert(match, "open-recipes listener block missing");
  const block = match[0];
  // The third argument (an options object) must be absent — a function as the
  // third argument is a dead callback that never fires.
  const args = block.match(/addEventListener\(([\s\S]*?)\);/);
  const openParens = (args?.[1] ?? "").split("").filter((c) => c === "(").length;
  const closeParens = (args?.[1] ?? "").split("").filter((c) => c === ")").length;
  const depth = openParens - closeParens;
  // After the 2-arg listener, the closing parens must balance: depth 0 means
  // exactly "click", handler → no third argument.
  assert(depth === 0, `open-recipes listener arity unexpected: depth=${depth}`);
});

Deno.test("ntp: the cap:attach-artifact handler is ONE canonical attachment — no dead inline get/add/close/status", async () => {
  const src = await Deno.readTextFile("extension/ntp/ntp.js");
  const start = src.indexOf('window.addEventListener("message"');
  const marker = src.indexOf("cap:attach-artifact", start);
  const call = src.indexOf("attachAssetToComposer", marker);
  assert(start >= 0 && marker > start && call > marker, "the cap:attach-artifact handler block missing");
  // The block spans from the listener to the end of the handler function.
  const end = src.indexOf("\n});", call);
  assert(end > call, "the handler block has no closing brace");
  const block = src.slice(start, end + 4);
  // Exactly ONE asset.get (inside attachAssetToComposer) — never a duplicate
  // inline get in the message handler.
  const gets = (block.match(/asset\.get/g) ?? []).length;
  assert(gets === 1, `cap:attach-artifact handler issues ${gets} asset.get calls (want exactly 1)`);
  // The handler itself must not re-implement addAttachment / closeView /
  // setStatus — those live in attachAssetToComposer.
  assert(!/composer\.addAttachment/.test(block), "the message handler re-implements addAttachment");
  assert(!/setStatus\(`Attached/.test(block), "the message handler re-implements the attach status line");
  // The canonical artifact shape lives in attachAssetToComposer.
  const fn = src.match(/async function attachAssetToComposer[\s\S]*?\n}/);
  assert(fn, "attachAssetToComposer missing");
  const body = fn[0];
  assert(/kind: "artifact"/.test(body), 'attachAssetToComposer does not emit kind:"artifact"');
  assert(/artifactId:/.test(body) && /artifactOrigin:/.test(body) && /artifactType:/.test(body), "attachAssetToComposer missing the artifact identity fields");
});
