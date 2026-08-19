// A run may continue in the service worker after its NTP surface is replaced.
// Its durable journal writes remain authoritative, but its old UI owner must not
// retitle the newly opened thread or make that thread show the old run banner.
import { assertEquals } from "jsr:@std/assert";
import { createRunSurfaceOwner } from "../extension/shared/run-surface-owner.js";

Deno.test("run surface owner: a switched-away run cannot retitle or reveal status on the newly opened surface", () => {
  const owners = createRunSurfaceOwner();
  const switchedAwayRun = owners.claim();
  const newlyOpenedSurface = owners.claim();

  const visible = { title: "Existing thread", status: "idle" };
  const staleTitleCommit = owners.commit(switchedAwayRun, () => {
    visible.title = "Switched-away task";
  });
  const staleStatusCommit = owners.commit(switchedAwayRun, () => {
    visible.status = "working";
  });

  assertEquals(owners.owns(newlyOpenedSurface), true);
  assertEquals(staleTitleCommit, false);
  assertEquals(staleStatusCommit, false);
  assertEquals(visible, { title: "Existing thread", status: "idle" });
});
