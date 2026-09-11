import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { assertChromeProcessOwnership as check } from "../scripts/lib/chrome-process-ownership.ts";
import captured from "./fixtures/chrome-process-snapshots.json" with { type: "json" };

// Only constructs fixture inputs; all identity/corroboration logic is the real helper.
function assertChromeProcessOwnership(
  owner: (typeof captured.cases)[number]["owner"] & { executable?: string },
  observed: Parameters<typeof check>[1],
) {
  return check(owner, observed, [
    `--load-extension=${owner.extension}`,
    `--user-data-dir=${owner.profile}`,
    "--remote-debugging-port=0",
  ]);
}

const owner = captured.cases[1].owner;
// A synthetic NUL-separated vector, not a reconstruction of the lossy capture.
const nul = `/usr/lib/chromium/chromium\0--headless=new\0--load-extension=${owner.extension}\0--user-data-dir=${owner.profile}\0--remote-debugging-port=0\0about:blank\0`;
const vector = { pid: owner.pid, ppid: owner.ppid, startTicks: owner.startTicks,
  argv: nul.split("\0").filter(Boolean) };

for (const c of captured.cases) {
  Deno.test(`9rmz: accepts the captured ${c.name} flattened form with its owned identity`, () => {
    assertEquals(c.observed.argv.length, 1);
    assertEquals(assertChromeProcessOwnership(c.owner, c.observed), "flattened");
  });
}

Deno.test("9rmz: accepts a normal NUL-separated vector without flattening it", () => {
  assertEquals(assertChromeProcessOwnership(owner, vector), "argv");
});

Deno.test("9rmz: extension/profile text in a flattened display never proves a foreign PID is ours", () => {
  for (const c of captured.cases) {
    assertThrows(() => assertChromeProcessOwnership(c.owner, { ...c.observed, pid: c.owner.pid + 10 }), Error, "pid mismatch");
  }
});

Deno.test("9rmz: a reused PID with matching flags but different start ticks is rejected", () => {
  for (const c of captured.cases) {
    assertThrows(() => assertChromeProcessOwnership(c.owner, { ...c.observed, startTicks: "999999" }), Error, "startTicks mismatch");
  }
});

Deno.test("9rmz: parent and executable must match when captured, including missing fields", () => {
  const expected = { ...owner, executable: "/usr/lib/chromium/chromium" };
  const actual = { ...vector, executable: expected.executable };
  assertEquals(assertChromeProcessOwnership(expected, actual), "argv");
  for (const ppid of [undefined, owner.ppid + 1]) {
    assertThrows(() => assertChromeProcessOwnership(expected, { ...actual, ppid }), Error, "ppid mismatch");
  }
  for (const executable of [undefined, "/different/browser"]) {
    assertThrows(() => assertChromeProcessOwnership(expected, { ...actual, executable }), Error, "executable mismatch");
  }
});

Deno.test("9rmz: identity cannot be vacuously missing or made up from invalid expected fields", () => {
  assertThrows(() => assertChromeProcessOwnership(owner, null), Error, "process missing");
  for (const patch of [{ pid: 0 }, { pid: NaN }, { startTicks: "" }, { startTicks: "unknown" }, { ppid: 0 }, { executable: "" }]) {
    assertThrows(() => assertChromeProcessOwnership({ ...owner, ...patch }, vector), Error, "invalid expected identity");
  }
  assertThrows(() => assertChromeProcessOwnership(owner, { ...vector, startTicks: undefined } as any), Error, "startTicks mismatch");
});

Deno.test("9rmz: a path prefix or a flag embedded in another option does not corroborate either form", () => {
  for (const snapshot of [vector, captured.cases[1].observed]) {
    for (const flag of [`--load-extension=${owner.extension}`, `--user-data-dir=${owner.profile}`]) {
      for (const replacement of [`${flag}-other`, `--note=${flag}`, `--note=${flag.split("=")[1]}`]) {
        const argv = snapshot.argv.map(a => a.replace(flag, replacement));
        assertThrows(() => assertChromeProcessOwnership(owner, { ...snapshot, argv }), Error, "flag not corroborated");
      }
    }
  }
});

Deno.test("9rmz: a different debugging flag or missing profile/extension flag is refused", () => {
  for (const snapshot of [vector, captured.cases[1].observed]) {
    for (const flag of [`--load-extension=${owner.extension}`, `--user-data-dir=${owner.profile}`, "--remote-debugging-port=0"]) {
      const argv = snapshot.argv.map(a => a.replace(flag, "--unrelated=true"));
      assertThrows(() => assertChromeProcessOwnership(owner, { ...snapshot, argv }), Error, "flag not corroborated");
    }
  }
});

Deno.test("9rmz: malformed snapshots or required arguments fail closed without echoing argv", () => {
  for (const argv of [[], null, [7], ["secret-sentinel\0--user-data-dir=/other"]]) {
    const e = assertThrows(() => assertChromeProcessOwnership(owner, { ...vector, argv } as any), Error, "invalid cmdline snapshot");
    assertEquals(e.message.includes("secret-sentinel"), false);
  }
  for (const required of [[], [""], ["\0"], [7], null]) {
    assertThrows(() => check(owner, vector, required as any), Error, "invalid required arguments");
  }
});
