// tests/opfs-platform-facts-pin.test.ts — chrome-agent-platform-n87j0 (static half).
//
// The MEASUREMENT of the four OPFS platform facts g2dje's writer decision rests
// on lives in scripts/opfs-real-browser.ts (npm run test:opfs): one page, one
// dedicated worker per measurement, a real Chrome, the measured Chrome version
// printed, and a CONTROL (a live holder must block the probe) that makes the
// termination measurement mean anything. It cannot live in tests/: the contract
// (docs/CHROME-TEST-CONTRACT.md §2.1, pinned by tests/chrome-test-contract.test.ts)
// makes tests/chrome-profile-location.test.ts the SOLE real-browser test in
// tests/, and that is not a guard this bead may lift to fit its own deliverable.
//
// What CAN run cheaply and with no browser is the coupling that actually decays in
// this repo: the pin's assertions being deleted or unwired, and production
// ADOPTING a writer mode or a sync-handle site that the recorded measurement does
// not cover.
//
// HOW IT IS SELECTED (and why it is NOT an always-on guard): the three modules the
// pin covers are imported for real below, so the fast gate selects this file
// exactly when wasm-stream-files.js, emscripten-custody.js or emscripten-host.js
// changes — the bead's acceptance — and pays nothing when none of them does.
// Registering it in SOURCE_INSPECTING_GUARDS instead would make EVERY lane's gate
// run it AND would edit the selector's own machinery, which forces the selector's
// fail-closed full suite on any commit that touches that list (measured on this
// branch: two 600 s gate runs under fleet load, no verdict). An import edge buys
// the same coverage for ~0 ms when irrelevant.
//
// A failure here is the instruction: re-measure with `npm run test:opfs`, confirm
// the four facts on the shipped Chrome, then update the pin AND this file
// together. Never relax a check to make it green.
import { assert, assertEquals } from "jsr:@std/assert@1";

// THE SELECTION EDGES. These are the modules the pin covers; importing them is
// what makes a change to any of them select this file in the fast gate. Each is
// asserted below, so the edge is a real dependency and not an unused import a
// later cleanup would delete.
import { WASM_STREAM_ROOT_NAME } from "../extension/lib/wasm-stream-files.js";
import { emscriptenJobOwner } from "../extension/lib/emscripten-custody.js";
import { EMSCRIPTEN_WORKER_PATH } from "../extension/lib/emscripten-host.js";

const ROOT = new URL("../", import.meta.url);
const read = (rel: string) => Deno.readTextFile(new URL(rel, ROOT));

/** The harness that measures the facts, and the wiring that makes it runnable. */
const HARNESS = "scripts/opfs-real-browser.ts";
const NPM_SCRIPT = "test:opfs";

/** The beads that depend on the pin. A drift must name them, not just fail. */
const DEPENDENTS = ["x9r8k", "ltkj.7", "ltkj.8"];

/** Every production call site of `createWritable(` in the writer decision, with
 *  the mode the pin MEASURED for it. `null` = default mode (fact (b)); "exclusive"
 *  = `mode:"exclusive"` (fact (c)). These are the files the decision actually rests
 *  on, checked by explicit path — no repository walk, so this file stays a cheap
 *  ordinary test instead of a tree scanner that must be always-on (see the header).
 *  A NEW writer site is not census'd here; the mode it picks is either one of these
 *  two measured ones or a behaviour nobody measured, and `npm run test:opfs` plus
 *  review is where a third mode has to be justified. */
const WRITABLE_SITES: Record<string, "default" | "exclusive"> = {
  "extension/lib/wasm-stream-files.js": "default", // the prepared output path (g2dje: not lock-mediated)
  "extension/lib/run-log-wal.js": "default", // the SW run-log WAL: "createWritable does not lock the file"
  "extension/lib/emscripten-host-evidence.js": "default", // the host ledger's own records
  "extension/lib/emscripten-host-writer.js": "exclusive", // 3mcu1's host-owned writer, fact (c)
};

/** Every file allowed to CALL `.createSyncAccessHandle(` inside the decision, with
 *  why. Exclusivity per file is measured; so is the fact that the service worker
 *  cannot use this API at all (run-log-wal.js:18-31). The two modules whose
 *  teardown story is UNKNOWN must NOT be callers: a handle there would be a
 *  writer whose release nobody can prove. */
const SYNC_HANDLE_CALLERS: Record<string, string> = {
  "extension/lib/wasm-stream-worker.js": "the job worker opens the stream files (g2dje: the worker-scope holder whose teardown cannot be proven)",
  "extension/lib/wasm-external-sort.js": "the external-sort worker opens its scratch files in worker scope",
};
const NEVER_SYNC_HANDLE_CALLERS = [
  "extension/lib/run-log-wal.js", // the SW context cannot use it at all (line 18-31)
  "extension/lib/emscripten-custody.js", // no writer is issued to the job worker (C1)
  "extension/lib/emscripten-host.js", // the host spawns/terminates the worker; it holds no OPFS handle
];

/** Code-only view: a `.createSyncAccessHandle(` CALL is code; the prose in
 *  run-log-wal.js mentions the API without a call, and must not count. */
function syncHandleCallSites(source: string): number[] {
  const lines: number[] = [];
  source.split("\n").forEach((line, i) => {
    if (/\.createSyncAccessHandle\s*\(/.test(line)) lines.push(i + 1);
  });
  return lines;
}

/** `createWritable(...)` argument lists, so a `mode:` adoption is visible. */
function writableModes(source: string): { line: number; args: string }[] {
  const out: { line: number; args: string }[] = [];
  const re = /\.createWritable\s*\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    out.push({ line: source.slice(0, m.index).split("\n").length, args: m[1] });
  }
  return out;
}

Deno.test("n87j0: the OPFS fact pin is declared, complete, and wired to a runnable harness", async () => {
  // The selection edges, asserted: these symbols are why the modules must not
  // quietly change shape relative to the decision the pin measures.
  assert(typeof WASM_STREAM_ROOT_NAME === "string" && WASM_STREAM_ROOT_NAME.length > 0, "wasm-stream-files.js still declares its OPFS stream root");
  assert(typeof emscriptenJobOwner === "function", "emscripten-custody.js still declares the job owner the host-owned-writer decision is about");
  assert(typeof EMSCRIPTEN_WORKER_PATH === "string" && EMSCRIPTEN_WORKER_PATH.endsWith(".js"), "emscripten-host.js still names the job worker it terminates");

  const harness = await read(HARNESS).catch(() => null);
  assert(harness !== null, `${HARNESS} must exist: it is the only place the four OPFS platform facts are measured`);

  // Each fact must still be ASSERTED (a check per fact), not merely described:
  // this is what a "tidy up the noisy harness" edit would remove first.
  for (const label of ["fact (a):", "fact (b):", "fact (b'):", "fact (c):", "fact (d):"]) {
    assert(
      harness!.includes(`OPFS ${label}`),
      `${HARNESS} no longer asserts "OPFS ${label}" — the pin lost a fact. Restore it or re-measure deliberately; ` +
        `the dependents are ${DEPENDENTS.join(", ")}.`,
    );
  }
  // The control is the assertion that makes (d) meaningful: without it, a probe
  // that never blocked would read as "the handle was released".
  assert(
    /OPFS fact \(d'\) CONTROL:/.test(harness!),
    `${HARNESS} no longer asserts the (d') CONTROL — a live holder must block another worker, or the termination ` +
      `measurement proves nothing (${DEPENDENTS.join(", ")}).`,
  );
  // A pin that does not say WHICH browser it was measured on cannot be read.
  assert(
    harness!.includes("PINNED_FACTS") && harness!.includes("measuredOn:") && /Browser\.getVersion/.test(harness!),
    `${HARNESS} must record PINNED_FACTS.measuredOn and report Browser.getVersion — a pin without a measured browser ` +
      `is folklore, which is the decay this bead exists to stop.`,
  );
  // Every fact check names the beads that rest on it, so a drift points at a
  // decision to re-read rather than at a test to update.
  for (const bead of DEPENDENTS) {
    assert(
      harness!.includes(bead),
      `${HARNESS} no longer names dependent bead ${bead} in its fact checks; a drift would read as an anonymous red.`,
    );
  }

  // Wiring: a harness nobody can run decays silently.
  const registry = await read("scripts/lib/harness-registry.ts");
  assert(
    registry.includes(`"opfs-real-browser.ts"`) && registry.includes(`npm: "${NPM_SCRIPT}"`),
    `scripts/lib/harness-registry.ts must register ${HARNESS} with npm "${NPM_SCRIPT}"`,
  );
  const pkg = JSON.parse(await read("package.json"));
  assertEquals(
    typeof pkg.scripts?.[NPM_SCRIPT],
    "string",
    `package.json must define the "${NPM_SCRIPT}" script the registry points at`,
  );
  assert(
    String(pkg.scripts[NPM_SCRIPT]).includes("opfs-real-browser.ts"),
    `npm run ${NPM_SCRIPT} must run ${HARNESS}`,
  );
});

Deno.test("n87j0: production still uses the writer modes and sync-handle sites the pin measured", async () => {
  // (b)/(c) Each production writer site must still be on a mode the pin measured.
  for (const [rel, expected] of Object.entries(WRITABLE_SITES)) {
    const sites = writableModes(await read(rel));
    assert(
      sites.length > 0,
      `${rel} no longer calls createWritable(): the pin's facts describe nothing there any more (${DEPENDENTS.join(", ")})`,
    );
    const observed = sites.map((site) => (/mode\s*:\s*["']exclusive["']/.test(site.args) ? "exclusive" : /\bmode\s*:/.test(site.args) ? `other(${site.args.trim()})` : "default"));
    for (const [i, mode] of observed.entries()) {
      assert(
        mode === expected,
        `${rel}:${sites[i].line} writes in ${mode} mode; the pin recorded ${expected}. The pinned OPFS facts cover DEFAULT and ` +
          `mode:"exclusive" only (and only for the Chrome named in PINNED). Re-run npm run ${NPM_SCRIPT}, confirm the facts on the ` +
          `shipped Chrome, then update PINNED_FACTS and this table together (${DEPENDENTS.join(", ")}; decision: g2dje).`,
      );
    }
  }

  // (a)/(d) The exclusivity and teardown facts apply to the CALLERS of
  // createSyncAccessHandle: they are the contexts that actually hold a handle.
  const callers = Object.keys(SYNC_HANDLE_CALLERS).sort();
  for (const rel of callers) {
    const source = await read(rel);
    assert(
      syncHandleCallSites(source).length > 0,
      `${rel} is declared a sync-access-handle caller but no longer calls it — update SYNC_HANDLE_CALLERS and the pin ` +
        `(${DEPENDENTS.join(", ")}).`,
    );
    assert(
      SYNC_HANDLE_CALLERS[rel].length > 20,
      `${rel} must declare WHY it may hold a sync access handle`,
    );
  }
  for (const rel of NEVER_SYNC_HANDLE_CALLERS) {
    const sites = syncHandleCallSites(await read(rel));
    assertEquals(
      sites,
      [],
      `${rel} now CALLS createSyncAccessHandle at line(s) ${sites.join(", ")}. The pinned exclusivity/teardown facts apply to the ` +
        `callers the pin measured, and this file is one the decision says must NOT hold a handle (a writer whose release nobody can ` +
        `prove). If that changed deliberately, re-run npm run ${NPM_SCRIPT}, then move it into SYNC_HANDLE_CALLERS with its reason ` +
        `(${DEPENDENTS.join(", ")}; decision: g2dje).`,
    );
  }
});

