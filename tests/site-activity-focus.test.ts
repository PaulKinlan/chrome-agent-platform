import { assertEquals } from "jsr:@std/assert@1";
import {
  consumeSiteActivityFocus,
  normalizeSiteActivityFocus,
  SITE_ACTIVITY_FOCUS_KEY,
} from "../extension/lib/site-activity-focus.js";

Deno.test("site activity focus: exact hints are one-shot and malformed metadata fails closed", async () => {
  let value: Record<string, unknown> = {
    [SITE_ACTIVITY_FOCUS_KEY]: {
      origin: "https://shop.example",
      tool: "add_to_cart",
      at: 1_788_624_000_000,
    },
  };
  let removed = 0;
  const storage = {
    get: async (key: string) => key === SITE_ACTIVITY_FOCUS_KEY ? structuredClone(value) : {},
    remove: async (key: string) => {
      removed++;
      delete value[key];
    },
  };
  assertEquals(await consumeSiteActivityFocus(storage), {
    origin: "https://shop.example",
    tool: "add_to_cart",
  });
  assertEquals(removed, 1);
  assertEquals(await consumeSiteActivityFocus(storage), null, "the hint cannot refocus a later Settings visit");

  let getterCalls = 0;
  const hostile = Object.create(null, {
    origin: { enumerable: true, get() { getterCalls++; return "https://shop.example"; } },
    tool: { enumerable: true, value: "add_to_cart" },
    at: { enumerable: true, value: 1 },
  });
  const invalid = [
    hostile,
    { origin: "chrome://settings", tool: "add_to_cart", at: 1 },
    { origin: "https://shop.example/", tool: "add_to_cart", at: 1 },
    { origin: "https://shop.example", tool: "add\u0000to_cart", at: 1 },
    { origin: "https://shop.example", tool: "cafe\u0301", at: 1 },
    Object.assign(Object.create({ inherited: true }), { origin: "https://shop.example", tool: "add_to_cart", at: 1 }),
    { origin: "https://shop.example", tool: "x".repeat(129), at: 1 },
    { origin: "https://shop.example", tool: "add_to_cart", at: 1, runId: "forbidden" },
  ];
  for (const value of invalid) assertEquals(normalizeSiteActivityFocus(value), null);
  assertEquals(getterCalls, 0);
});
