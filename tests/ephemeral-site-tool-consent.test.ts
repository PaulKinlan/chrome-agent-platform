import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { createEphemeralSiteToolConsentStore } from "../extension/lib/ephemeral-site-tool-consent.js";

const origin = "https://booking.example";
const attachment = (runId: string, documentId = "document-A") => ({
  origin, tabId: 51, documentId, runId, threadId: "thread-7",
});
const declared = (name: string, version = 1) => ({
  name, source: "declared", inputSchema: { type: "object", properties: { version: { const: version } } },
});

Deno.test("ephemeral Q23: no decision without a run token; Allow is digest-bound and scoped to one run", () => {
  const store = createEphemeralSiteToolConsentStore();
  const first = store.begin(attachment("run-one"));
  const second = store.begin(attachment("run-two"));
  const tool = declared("change-seat");
  assertEquals(store.snapshot(first, tool).state, "ask");
  const ask = store.snapshot(first, tool);
  const allowed = store.decide(first, tool, "allowed", { expected: ask });
  assertEquals(allowed.state, "allowed");
  assertEquals(store.snapshot(second, tool).state, "ask");
  assertEquals(store.snapshot(first, declared("change-seat", 2)).state, "ask");
  assertThrows(() => store.snapshot({}, tool));
  assertThrows(() => store.decide(first, tool, "allowed", { expected: ask }));
  assertThrows(() => store.decide(first, { ...tool, source: "inferred" }, "allowed"));
  store.end(first);
  assertThrows(() => store.snapshot(first, tool));
  assertEquals(store.snapshot(second, tool).state, "ask");
});

Deno.test("ephemeral Q23: Deny sticks to exact origin and name despite page descriptor changes", () => {
  const store = createEphemeralSiteToolConsentStore();
  const token = store.begin(attachment("run-deny"));
  store.decide(token, declared("change-seat"), "denied", { expected: store.snapshot(token, declared("change-seat")) });
  assertEquals(store.snapshot(token, declared("change-seat", 2)).state, "denied");
  assertThrows(() => store.decide(token, declared("change-seat", 2), "allowed"));
  assertEquals(store.snapshot(token, declared("other-tool")).state, "ask");
});

Deno.test("ephemeral Q23: promotion gathers both states across live runs, with Deny winning conflicts and one atomic callback", async () => {
  const store = createEphemeralSiteToolConsentStore();
  const first = store.begin(attachment("run-one"));
  const second = store.begin(attachment("run-two", "document-B"));
  store.decide(first, declared("seat"), "allowed");
  store.decide(first, declared("meal"), "allowed");
  store.decide(second, declared("seat", 2), "denied");
  let captured: Array<{ name: string; state: string }> = [];
  let release: (() => void) | undefined;
  const pending = store.withPromotionForOrigin(origin, async (records, isCurrent) => {
    captured = records;
    assertEquals(isCurrent(), true);
    await new Promise<void>((resolve) => { release = resolve; });
    assertEquals(isCurrent(), true);
    return "persisted-once";
  });
  // Allow the callback to begin without racing the assertions below.
  await Promise.resolve();
  assertThrows(() => store.begin(attachment("run-three")));
  assertThrows(() => store.decide(first, declared("meal"), "denied"));
  assertEquals(captured.map(({ name, state }) => [name, state]), [["meal", "allowed"], ["seat", "denied"]]);
  release?.();
  assertEquals(await pending, "persisted-once");
  assertThrows(() => store.snapshot(first, declared("meal")));
  assertThrows(() => store.snapshot(second, declared("seat")));
});

Deno.test("ephemeral Q23: rejected promotion preserves live decisions; run end fences a late promotion", async () => {
  const store = createEphemeralSiteToolConsentStore();
  const token = store.begin(attachment("run-failure"));
  store.decide(token, declared("seat"), "denied");
  await assertRejects(() => store.withPromotionForOrigin(origin, async () => { throw Error("disk failed"); }));
  assertEquals(store.snapshot(token, declared("seat")).state, "denied");
  let release: (() => void) | undefined;
  const pending = store.withPromotionForOrigin(origin, async (_rows, isCurrent) => {
    await new Promise<void>((resolve) => { release = resolve; });
    assertEquals(isCurrent(), false);
  });
  await Promise.resolve();
  store.end(token);
  release?.();
  await assertRejects(() => pending);
});
