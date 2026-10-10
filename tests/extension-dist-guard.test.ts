// tests/extension-dist-guard.test.ts — pins the extension build artifact guard (zqgn3).
//
// Invariants guarded:
//   1. launchChrome refuses an unpacked extension whose declared build artifacts
//      (manifest.json, background service worker, dist) are missing, before
//      spawning the browser or attempting any DevTools connection.
//   2. The refusal message explicitly names the missing path, the cause
//      ("extension" + "/dist not built"), and the fix ("run npm run build:production").
//   3. Covers both opts.extension and opts.args ("--load-extension=...").
//   4. A properly-built unpacked extension passes validation without throwing.

import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import { assertExtensionBuilt, launchChrome } from "../scripts/lib/chrome-launch.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXT = join(ROOT, "extension");
const NOT_BUILT_FRAGMENT = ["extension", "dist not built - run npm run build:production"].join("/");

function makeScratchDir(prefix: string): string {
  return Deno.makeTempDirSync({ dir: durableDir("scratch"), prefix: `zqgn3-${prefix}-` });
}

Deno.test("zqgn3: launchChrome rejects repo extension when dist is absent on real call path", async () => {
  // If dist exists in the worktree, we skip this specific repo-tree check
  // (the isolated fixture tests below exercise both missing and present cases unconditionally).
  const distWorker = join(EXT, "dist", "background", "service-worker.js");
  const distExists = await Deno.stat(distWorker).then(() => true, () => false);
  if (distExists) return;

  await assertRejects(
    async () => {
      await launchChrome({ binary: "/bin/true", extension: EXT });
    },
    Error,
    NOT_BUILT_FRAGMENT,
  );
});

Deno.test("zqgn3: launchChrome rejects via --load-extension arg when dist is absent", async () => {
  const distWorker = join(EXT, "dist", "background", "service-worker.js");
  const distExists = await Deno.stat(distWorker).then(() => true, () => false);
  if (distExists) return;

  await assertRejects(
    async () => {
      await launchChrome({ binary: "/bin/true", args: [`--load-extension=${EXT}`] });
    },
    Error,
    NOT_BUILT_FRAGMENT,
  );
});

Deno.test("zqgn3: isolated fixture with declared service-worker in missing dist fails with clear message", async () => {
  const dir = makeScratchDir("missing-dist");
  try {
    const manifest = {
      manifest_version: 3,
      name: "test-fixture",
      version: "1.0",
      background: {
        service_worker: ["dist", "background", "service-worker.js"].join("/"),
      },
    };
    Deno.writeTextFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));

    const err = await assertRejects(
      async () => {
        await launchChrome({ binary: "/bin/true", extension: dir });
      },
      Error,
    );

    const msg = err.message;
    assert(msg.includes("launchChrome: the extension at"), `expected launchChrome prefix, got: ${msg}`);
    assert(msg.includes("did not load:"), `expected 'did not load:', got: ${msg}`);
    assert(msg.includes(join(dir, "dist", "background", "service-worker.js")), `expected missing worker path, got: ${msg}`);
    assert(msg.includes(["extension", "dist not built"].join("/")), `expected extension dist not built, got: ${msg}`);
    assert(msg.includes("run npm run build"), `expected 'run npm run build', got: ${msg}`);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("zqgn3: fixture missing manifest.json fails early with actionable message", async () => {
  const dir = makeScratchDir("missing-manifest");
  try {
    const err = await assertRejects(
      async () => {
        await launchChrome({ binary: "/bin/true", extension: dir });
      },
      Error,
    );

    const msg = err.message;
    assert(msg.includes("manifest.json is missing"), `expected 'manifest.json is missing', got: ${msg}`);
    assert(msg.includes("run npm run build"), `expected fix instruction, got: ${msg}`);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("zqgn3: nonexistent extension directory fails early", async () => {
  const nonExistent = join(ROOT, "nonexistent-extension-dir-zqgn3");
  const err = await assertRejects(
    async () => {
      await launchChrome({ binary: "/bin/true", extension: nonExistent });
    },
    Error,
  );
  assert(err.message.includes("does not exist"), `expected 'does not exist', got: ${err.message}`);
});

Deno.test("zqgn3: assertExtensionBuilt succeeds when declared artifacts are present", () => {
  const dir = makeScratchDir("built");
  try {
    const manifest = {
      manifest_version: 3,
      name: "test-fixture",
      version: "1.0",
      background: {
        service_worker: ["dist", "background", "service-worker.js"].join("/"),
      },
    };
    Deno.writeTextFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
    const distBg = join(dir, "dist", "background");
    Deno.mkdirSync(distBg, { recursive: true });
    Deno.writeTextFileSync(join(distBg, "service-worker.js"), "// worker");

    // Must not throw when built artifacts are present
    assertExtensionBuilt(dir);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

