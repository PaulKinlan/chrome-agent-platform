// CAP-authored source audit for the always-on static-first Emscripten pin.
// Generated bundles, historical ABI evidence and Python's pinned runtime are
// not CAP-authored Emscripten source. The caller must pass its own repo root.
import { tokenizer } from "../../extension/lib/vendor/acorn.mjs";

const SCRIPT_EXTENSIONS = /\.(?:js|mjs|cjs)$/u;
const RUNTIME_HOOKS = new Set(["loadDylibs", "dynamicLibraries", "sideBinaries", "instantiateWasm", "locateFile"]);
const OMIT_DIRECTORIES = new Set(["dist", "dist-versions", "dist-archives", "node_modules"]);

export async function collectProductSources(root) {
  const sources = new Map();
  async function visit(relative) {
    for await (const entry of Deno.readDir(new URL(relative + "/", root))) {
      const name = `${relative}/${entry.name}`;
      if (OMIT_DIRECTORIES.has(entry.name) ||
          (relative === "extension" && /^\.dist-(?:stage|link|prev)-/u.test(entry.name)) ||
          name === "packages/bundled/evidence") continue;
      if (entry.isSymlink) throw new Error(`unreviewed product source symlink: ${name}`);
      if (entry.isDirectory) {
        await visit(name);
      } else if (entry.isFile && SCRIPT_EXTENSIONS.test(entry.name)) {
        sources.set(name, await Deno.readTextFile(new URL(name, root)));
      }
    }
  }
  await visit("extension");
  await visit("packages");
  return sources;
}

// Tokenise rather than search text: comments are not executable links, and
// escaped identifier/property spellings are decoded by the JS lexer. This is
// a finite syntactic pin, NOT a proof against computed/aliased JS properties.
export function auditStaticFirst(sources) {
  const violations = [];
  for (const [path, source] of sources) {
    const tokens = tokenizer(source, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true });
    let previous = null;
    for (;;) {
      const token = tokens.getToken();
      if (token.type.label === "eof") break;
      if (RUNTIME_HOOKS.has(token.value)) violations.push(`${path}:${token.value}`);
      if (previous?.value === "Module" && (token.type.label === "." || token.type.label === "[")) {
        violations.push(`${path}:Module-hook`);
      }
      previous = token;
    }
  }
  return violations.sort();
}
