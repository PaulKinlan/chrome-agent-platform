// Keyboard command routing — CAP-FB-20260825-KEYBOARD-COMMANDS-01.
//
// The pure halves: which commands exist, what URL each opens, and how the NTP
// parses the hash they land on. The OS-level key chord itself cannot be driven
// headless (Chrome dispatches `commands` from browser UI, not from page input),
// so firing the real chord belongs to the headed lane
// CAP-FB-20260825-HEADED-ACCEPTANCE-LANE-01.
import { assertEquals } from "jsr:@std/assert";
import { KEYBOARD_COMMANDS, hubUrlForCommand } from "../extension/lib/pure.js";
import { parseNtpHash } from "../extension/lib/navigation-controller.js";

const getURL = (p: string) => `chrome-extension://cap/${p}`;

Deno.test("commands: the declared set is exactly the three shipped ids", () => {
  assertEquals(KEYBOARD_COMMANDS, ["open-hub", "new-task", "open-side-panel"]);
});

Deno.test("commands: the manifest declares exactly those ids, with descriptions", async () => {
  const manifest = JSON.parse(await Deno.readTextFile("extension/manifest.json"));
  assertEquals(Object.keys(manifest.commands), KEYBOARD_COMMANDS);
  for (const id of KEYBOARD_COMMANDS) {
    const c = manifest.commands[id];
    assertEquals(typeof c.description, "string");
    assertEquals(c.description.length > 0, true);
  }
});

Deno.test("commands: no suggested chord collides with a common Chrome binding", async () => {
  const manifest = JSON.parse(await Deno.readTextFile("extension/manifest.json"));
  // Chrome reserves or commonly assigns these; a suggested key that collides is
  // silently dropped by Chrome, so the shortcut would simply never work.
  const taken = new Set([
    "Ctrl+Shift+A", "Ctrl+Shift+B", "Ctrl+Shift+D", "Ctrl+Shift+E", "Ctrl+Shift+I",
    "Ctrl+Shift+J", "Ctrl+Shift+M", "Ctrl+Shift+N", "Ctrl+Shift+O", "Ctrl+Shift+P",
    "Ctrl+Shift+Q", "Ctrl+Shift+T", "Ctrl+Shift+W", "Ctrl+T", "Ctrl+N", "Ctrl+W",
  ]);
  for (const id of KEYBOARD_COMMANDS) {
    const keys = manifest.commands[id].suggested_key ?? {};
    for (const chord of Object.values(keys) as string[]) {
      assertEquals(taken.has(chord), false, `${id} suggests reserved chord ${chord}`);
    }
  }
});

Deno.test("commands: only new-task lands on the composer, and carries no payload", () => {
  assertEquals(hubUrlForCommand("open-hub", getURL), "chrome-extension://cap/ntp/ntp.html");
  assertEquals(hubUrlForCommand("new-task", getURL), "chrome-extension://cap/ntp/ntp.html#compose");
  // A shortcut must never inject task text: the URL carries no query/payload.
  assertEquals(hubUrlForCommand("new-task", getURL).includes("="), false);
});

Deno.test("commands: an unknown id still resolves to the plain hub, never a payload URL", () => {
  assertEquals(hubUrlForCommand("nope", getURL), "chrome-extension://cap/ntp/ntp.html");
});

Deno.test("routes: #compose is its own route, and is not confused with hub or omnibox", () => {
  assertEquals(parseNtpHash("#compose"), { route: "compose" });
  assertEquals(parseNtpHash("compose"), { route: "compose" });
  assertEquals(parseNtpHash(""), { route: "hub" });
  assertEquals(parseNtpHash("#"), { route: "hub" });
  // Unrelated hashes must not become `compose`.
  assertEquals(parseNtpHash("#composer"), { route: "hub" });
  assertEquals(parseNtpHash("#omnibox=run:hello"), { route: "omnibox", mode: "run", query: "hello" });
});
