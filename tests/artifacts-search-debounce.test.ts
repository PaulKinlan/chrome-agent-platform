import { assertEquals } from "jsr:@std/assert";
import { createSearchDebounce, SEARCH_SETTLE_MS } from "../extension/artifacts/search-debounce.js";

function fakeTimers() {
  let now = 0;
  const queue = new Map<symbol, { at: number; fn: () => void }>();
  return {
    schedule(fn: () => void, ms: number) {
      const id = Symbol();
      queue.set(id, { at: now + ms, fn });
      return id;
    },
    cancel(id: symbol) { queue.delete(id); },
    advance(ms: number) {
      now += ms;
      for (const [id, item] of [...queue]) {
        if (item.at <= now) { queue.delete(id); item.fn(); }
      }
    },
    pending() { return queue.size; },
  };
}

Deno.test("artifacts search coalesces typing into one trailing rebuild of the final query", () => {
  assertEquals(SEARCH_SETTLE_MS, 110);
  const clock = fakeTimers();
  let query = "";
  const rebuilt: string[] = [];
  const search = createSearchDebounce(() => rebuilt.push(query), clock);
  for (const char of "beta") {
    query += char;
    search();
    clock.advance(60);
  }
  assertEquals(rebuilt, []);
  assertEquals(clock.pending(), 1);
  clock.advance(SEARCH_SETTLE_MS - 61);
  assertEquals(rebuilt, []);
  clock.advance(1);
  assertEquals(rebuilt, ["beta"]);
  assertEquals(clock.pending(), 0);

  query = "alpha";
  search();
  clock.advance(SEARCH_SETTLE_MS);
  assertEquals(rebuilt, ["beta", "alpha"]);
});

Deno.test("artifacts search cancels a pending rebuild on teardown or remount", () => {
  const clock = fakeTimers();
  let calls = 0;
  const oldMount = createSearchDebounce(() => calls++, clock);
  oldMount();
  clock.advance(90);
  oldMount.cancel();
  assertEquals(clock.pending(), 0);
  clock.advance(SEARCH_SETTLE_MS * 2);
  assertEquals(calls, 0);

  const newMount = createSearchDebounce(() => calls++, clock);
  newMount();
  clock.advance(SEARCH_SETTLE_MS);
  assertEquals(calls, 1);
  newMount.cancel(); // Idempotent after the timer has fired.
  assertEquals(clock.pending(), 0);
});

Deno.test("artifacts search re-arms the same debounce after a pending search is cancelled", () => {
  const clock = fakeTimers();
  const rebuilt: string[] = [];
  let query = "alpha";
  const search = createSearchDebounce(() => rebuilt.push(query), clock);

  search();
  clock.advance(90);
  search.cancel(); // Refresh or kind-pill changes reuse this debounce instance.
  assertEquals(clock.pending(), 0);

  query = "beta";
  search();
  clock.advance(SEARCH_SETTLE_MS);
  assertEquals(rebuilt, ["beta"]); // Cancel must not permanently disarm search.
  assertEquals(clock.pending(), 0);

  search();
  clock.advance(50);
  search.cancel();
  clock.advance(SEARCH_SETTLE_MS * 2);
  assertEquals(rebuilt, ["beta"]); // The re-armed instance remains cancellable.
});
