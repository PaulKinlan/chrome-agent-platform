// @ts-nocheck
// CAP-FB-20260830-GENERATED-IMAGE-STRIP-01 — the images a run produces (the
// screenshots it captured, the image-type assets it created) are collected from
// the durable run log into ONE "images" row per execution, so the thread and
// the hub timeline can mount a <screenshot-strip> that reads from the stores.
//
// The load-bearing property: the row carries only IDS (never the image bytes),
// in run-log order, and it is the SAME derivation the live view and the replay
// use — so the strip cannot appear during a run and vanish on reopen.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { toolRowsFromRunLog } from "../extension/shared/conversation.js";

const capture = (screenshotId, over = {}) => ({
  type: "tool-result", callId: `cap_${screenshotId}`, tool: "capture_screenshot",
  result: { ok: true, screenshotId, url: "https://example.com", width: 1280, height: 720, ...over }, ok: true, at: 10,
});
const captureCall = (screenshotId) => ({ type: "tool-call", callId: `cap_${screenshotId}`, tool: "capture_screenshot", args: {}, at: 9 });
const createAsset = (id, type) => ({
  type: "tool-result", callId: `ca_${id}`, tool: "create_asset",
  result: { ok: true, asset: { id, name: `${id}.${type}`, type, origin: "master", size: 100 } }, ok: true, at: 20,
});
const createCall = (id) => ({ type: "tool-call", callId: `ca_${id}`, tool: "create_asset", args: {}, at: 19 });

Deno.test("images row: collects a screenshot and an image asset in run-log order", () => {
  const rows = toolRowsFromRunLog("e1", [
    captureCall("s1"), capture("s1"),
    createCall("a1"), createAsset("a1", "image"),
    createCall("a2"), createAsset("a2", "html"),
  ]);
  const images = rows.filter((r) => r.role === "images");
  assertEquals(images.length, 1, "exactly one images row per execution");
  assertEquals(images[0].items.map((i) => ({ id: i.id, kind: i.kind })), [
    { id: "s1", kind: "screenshot" },
    { id: "a1", kind: "image" },
  ]);
});

Deno.test("images row: a run with no images emits no images row", () => {
  const rows = toolRowsFromRunLog("e2", [
    createCall("a9"), createAsset("a9", "text"),
  ]);
  assertEquals(rows.filter((r) => r.role === "images").length, 0);
});

Deno.test("images row: the screenshotId survives the agent-do {modelContent,userSummary} wrapper", () => {
  const wrapped = {
    type: "tool-result", callId: "cW", tool: "execute_tool", selectedTool: "capture_screenshot",
    result: {
      modelContent: JSON.stringify({ ok: true, selectedTool: "capture_screenshot", result: { ok: true, screenshotId: "sW", url: "https://x", width: 10, height: 10 } }),
      userSummary: "Captured a screenshot",
    }, ok: true, at: 30,
  };
  const rows = toolRowsFromRunLog("e3", [
    { type: "tool-call", callId: "cW", tool: "execute_tool", args: { arguments: {} }, at: 29 },
    wrapped,
  ]);
  const images = rows.filter((r) => r.role === "images");
  assertEquals(images.length, 1);
  assertEquals(images[0].items.map((i) => ({ id: i.id, kind: i.kind })), [{ id: "sW", kind: "screenshot" }]);
});
