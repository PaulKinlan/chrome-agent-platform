// scripts/dump-tool-corpus-tokens.ts — tablegen inputs for the semantic tool
// vector table. Default: print the unique lowercase tokens of the built-in
// tool corpus one per line (vocabulary coverage). `--mode=texts`: print each
// descriptor's full searchable text one per line (the common-direction fit
// corpus). Dev-time tool: never runs in the extension, the suite, or the
// build gates.
import { adaptBrowserTools, adaptManagementTools, buildToolCatalog } from "../extension/lib/tool-catalog.js";
import { browserToolset } from "../extension/lib/browser-tools.js";
import { managementToolset } from "../extension/lib/management-tools.js";

const ctx = {
  packageId: "cap.tablegen",
  version: "0",
  scope: { hub: true, agentId: "hub", origin: "", documentId: "" },
  sourceGeneration: "tablegen",
};
// Descriptions/schemas only — dispatch stubs are never invoked here.
const catalog = buildToolCatalog([
  ...adaptBrowserTools(browserToolset(false, { developerFeatures: true }), ctx),
  ...adaptManagementTools(managementToolset({ callRoute: async () => ({ ok: false }) }), ctx),
]);

const textsMode = (typeof Deno !== "undefined" ? Deno.args : process.argv.slice(2))
  .includes("--mode=texts");
const FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/gu;
const textOf = (d) =>
  [d.name, ...(d.aliases ?? []), d.description, ...(d.capabilities ?? [])].join(" ")
    .normalize("NFKC").toLocaleLowerCase("en-US").replace(FORBIDDEN, " ");

if (textsMode) {
  for (const d of catalog.descriptors) {
    const norm = textOf(d).replace(/\s+/g, " ").trim();
    if (norm) console.log(norm);
  }
} else {
  const tokens = new Set();
  for (const d of catalog.descriptors) {
    for (const t of textOf(d).match(/[\p{L}\p{N}_-]+/gu) ?? []) tokens.add(t);
  }
  for (const t of [...tokens].sort()) console.log(t);
}
