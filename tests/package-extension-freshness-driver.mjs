// @ts-nocheck — exercises the Node packaging helper from Deno.
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import {
  collectPackageInventory,
  packageExtensionArchive,
  verifyPackageArchive,
} from "../scripts/package-archive.mjs";

async function command(cwd, executable, args) {
  const output = await new Deno.Command(executable, {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder();
  if (!output.success) {
    throw new Error(
      `${executable} ${args.join(" ")} failed: ${text.decode(output.stderr)}`,
    );
  }
  return text.decode(output.stdout);
}

async function write(root, relative, value) {
  const file = `${root}/${relative}`;
  await Deno.mkdir(file.slice(0, file.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(file, value);
}

async function fixture() {
  const root = await Deno.makeTempDir({
    prefix: "cap-package-freshness-fixture-",
  });
  await write(
    root,
    ".gitignore",
    [
      "extension/dist/",
      "extension/dist-versions/",
      "extension/CHANGELOG.md",
      "extension/**/*.bundle.js",
      "out/",
      "",
    ].join("\n"),
  );
  await write(root, "CHANGELOG.md", "# Changelog\n\n## [fixture]\n- exact\n");
  await write(
    root,
    "extension/manifest.json",
    JSON.stringify({
      manifest_version: 3,
      version: "1.0.0",
      background: { service_worker: "dist/background/service-worker.js" },
    }),
  );
  await write(
    root,
    "extension/options/options.js",
    "export const source = 1;\n",
  );
  await write(
    root,
    "extension/remove-after-first.js",
    "export const removed = true;\n",
  );
  await command(root, "git", ["init", "-q"]);
  await command(root, "git", ["config", "user.name", "Package Test"]);
  await command(root, "git", [
    "config",
    "user.email",
    "package@example.invalid",
  ]);
  await command(root, "git", [
    "add",
    ".gitignore",
    "CHANGELOG.md",
    "extension",
  ]);
  await command(root, "git", ["commit", "-qm", "fixture"]);

  // Generated authority is intentionally ignored and created after the commit.
  await write(
    root,
    "extension/CHANGELOG.md",
    await Deno.readTextFile(`${root}/CHANGELOG.md`),
  );
  await write(
    root,
    "extension/dist/background/service-worker.js",
    "console.log('dist-v1');\n",
  );
  await write(
    root,
    "extension/dist/options.bundle.js",
    "console.log('options-v1');\n",
  );
  await write(root, "extension/dist/dist.complete", '{"fixture":1}\n');
  return root;
}

async function zipEntries(archive) {
  const output = await new Deno.Command("unzip", {
    args: ["-Z1", archive],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(output.success);
  return new TextDecoder().decode(output.stdout).split(/\r?\n/u).filter(
    Boolean,
  );
}

async function zipText(archive, entry) {
  const output = await new Deno.Command("unzip", {
    args: ["-p", archive, entry],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(output.success);
  return new TextDecoder().decode(output.stdout);
}

async function assertPortableExtract(archive) {
  const extracted = await Deno.makeTempDir({
    prefix: "cap-package-extracted-",
  });
  try {
    await command(extracted, "unzip", ["-q", archive, "-d", extracted]);
    const walk = async (dir) => {
      for await (const entry of Deno.readDir(dir)) {
        const file = `${dir}/${entry.name}`;
        const info = await Deno.lstat(file);
        assert(!info.isSymlink, `archive extracted a symlink: ${file}`);
        assert(
          info.isDirectory || info.isFile,
          `archive extracted a special file: ${file}`,
        );
        if (info.isDirectory) await walk(file);
      }
    };
    await walk(extracted);
  } finally {
    await Deno.remove(extracted, { recursive: true });
  }
}

Deno.test("package archive replaces poison from exact tracked + generated inventory on every run", async () => {
  const root = await fixture();
  try {
    const archive = `${root}/out/cap.zip`;
    await Deno.mkdir(`${root}/out`, { recursive: true });

    // Poison both local ignored state and the pre-existing final ZIP. The old
    // wholesale-copy + in-place zip update admitted/retained these entries.
    await write(
      root,
      "extension/options/options.bundle.js",
      "IGNORED_LOCAL_POISON\n",
    );
    const poison = `${root}/poison`;
    await write(root, "poison/stale-only.js", "STALE_ARCHIVE_POISON\n");
    await write(
      root,
      "poison/options/options.bundle.js",
      "IGNORED_ARCHIVE_POISON\n",
    );
    await command(poison, "zip", ["-q", "-r", archive, "."]);

    const first = await packageExtensionArchive({ root, archive });
    const firstNames = await zipEntries(archive);
    assertEquals(
      firstNames.length,
      new Set(firstNames).size,
      "duplicate ZIP entries",
    );
    assert(firstNames.includes("remove-after-first.js"));
    assert(firstNames.includes("dist/background/service-worker.js"));
    assert(firstNames.includes("dist/options.bundle.js"));
    assert(!firstNames.includes("stale-only.js"));
    assert(!firstNames.includes("options/options.bundle.js"));
    assertEquals(first.entries, firstNames.length);
    await assertPortableExtract(archive);

    // The second package reuses the same final path after a tracked removal,
    // an ignored-file removal, and a fresh generated dist. It must not retain
    // any entry from the prior ZIP and must carry current dist bytes.
    await command(root, "git", ["rm", "-q", "extension/remove-after-first.js"]);
    await Deno.remove(`${root}/extension/options/options.bundle.js`);
    await write(
      root,
      "extension/dist/background/service-worker.js",
      "console.log('dist-v2-current');\n",
    );
    await write(
      root,
      "extension/dist/options.bundle.js",
      "console.log('options-v2-current');\n",
    );
    await write(root, "extension/dist/dist.complete", '{"fixture":2}\n');

    const second = await packageExtensionArchive({ root, archive });
    const secondNames = await zipEntries(archive);
    assertEquals(
      secondNames.length,
      new Set(secondNames).size,
      "duplicate ZIP entries after replacement",
    );
    assert(
      !secondNames.includes("remove-after-first.js"),
      "removed tracked file survived second package",
    );
    assert(
      !secondNames.includes("stale-only.js"),
      "poisoned stale entry survived replacement",
    );
    assert(
      !secondNames.includes("options/options.bundle.js"),
      "ignored local bundle entered package",
    );
    assertStringIncludes(
      await zipText(archive, "dist/background/service-worker.js"),
      "dist-v2-current",
    );
    assertStringIncludes(
      await zipText(archive, "dist/options.bundle.js"),
      "options-v2-current",
    );
    assertEquals(second.entries, secondNames.length);
    assert(
      first.archiveSha256 !== second.archiveSha256,
      "fresh archive hash did not change",
    );
    await verifyPackageArchive({
      archive,
      expected: await collectPackageInventory({ root }),
      scratchParent: `${root}/out`,
    });
    await assertPortableExtract(archive);

    const leftovers = [];
    for await (const entry of Deno.readDir(`${root}/out`)) {
      if (
        entry.name.startsWith(".cap-package-") || entry.name.includes(".tmp-")
      ) {
        leftovers.push(entry.name);
      }
    }
    assertEquals(leftovers, [], "package staging/temp files leaked");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("package archive preserves final and cleans unique stage/temp after ZIP failure", async () => {
  const root = await fixture();
  try {
    const archive = `${root}/out/cap.zip`;
    await Deno.mkdir(`${root}/out`, { recursive: true });
    await Deno.writeTextFile(archive, "POISONED_FINAL_MUST_SURVIVE_FAILURE\n");
    const before = await Deno.readTextFile(archive);
    await assertRejects(
      () =>
        packageExtensionArchive({
          root,
          archive,
          zipCommand: "/bin/false",
        }),
      Error,
      "zip exited",
    );
    assertEquals(await Deno.readTextFile(archive), before);
    const leftovers = [];
    for await (const entry of Deno.readDir(`${root}/out`)) {
      if (
        entry.name.startsWith(".cap-package-") || entry.name.includes(".tmp-")
      ) {
        leftovers.push(entry.name);
      }
    }
    assertEquals(leftovers, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("package archive rejects tracked symlinks and generated symlink/special files", async () => {
  const trackedRoot = await fixture();
  try {
    await Deno.symlink(
      "manifest.json",
      `${trackedRoot}/extension/tracked-link`,
    );
    await command(trackedRoot, "git", ["add", "extension/tracked-link"]);
    await assertRejects(
      () =>
        packageExtensionArchive({
          root: trackedRoot,
          archive: `${trackedRoot}/out/tracked-link.zip`,
        }),
      Error,
      "tracked symlink/special mode 120000",
    );
  } finally {
    await Deno.remove(trackedRoot, { recursive: true });
  }

  const generatedLinkRoot = await fixture();
  try {
    await Deno.symlink(
      "options.bundle.js",
      `${generatedLinkRoot}/extension/dist/generated-link.js`,
    );
    await assertRejects(
      () =>
        packageExtensionArchive({
          root: generatedLinkRoot,
          archive: `${generatedLinkRoot}/out/generated-link.zip`,
        }),
      Error,
      "generated symlink rejected",
    );
  } finally {
    await Deno.remove(generatedLinkRoot, { recursive: true });
  }

  const specialRoot = await fixture();
  try {
    await command(specialRoot, "mkfifo", [
      `${specialRoot}/extension/dist/generated-pipe`,
    ]);
    await assertRejects(
      () =>
        packageExtensionArchive({
          root: specialRoot,
          archive: `${specialRoot}/out/generated-special.zip`,
        }),
      Error,
      "generated special file rejected",
    );
  } finally {
    await Deno.remove(specialRoot, { recursive: true });
  }
});
