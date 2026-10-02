// @ts-nocheck
// tests/artifact-export-3p3e7.test.ts — tests for bead chrome-agent-platform-3p3e.7:
// Save artifact to disk (Save… via showSaveFilePicker, Download fallback)
// and export_asset_to_folder management tool.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  suggestArtifactFilename,
  saveArtifactToDisk,
  exportAssetToFolder,
} from "../extension/lib/artifact-export.js";
import { MANAGEMENT_TOOL_NAMES, managementToolset } from "../extension/lib/management-tools.js";
import {
  chromeToolCapability,
  MANAGEMENT_CAPABILITY_TOOL_NAMES,
} from "../extension/lib/chrome-tool-capabilities.js";
import { toolPurposeGroup } from "../extension/lib/tool-purpose-groups.js";
import {
  permissionUserLanguage,
  PERMISSION_USER_LANGUAGE,
} from "../extension/lib/permission-language.js";
import { describeToolCall } from "../extension/lib/tool-summary.js";
import { ledgerRowFor } from "../extension/lib/action-ledger.js";

// Stub browser globals for artifact-card custom element testing if not present
if (!globalThis.HTMLElement) {
  globalThis.HTMLElement = class HTMLElementStub {
    attachShadow() { return { innerHTML: "", querySelector: () => null, querySelectorAll: () => [], appendChild() {} }; }
    getAttribute() { return null; }
    hasAttribute() { return false; }
    setAttribute() {}
    removeAttribute() {}
    dispatchEvent() { return true; }
    addEventListener() {}
    querySelector() { return null; }
    querySelectorAll() { return []; }
  };
}
if (!globalThis.customElements) {
  const registry = new Map();
  globalThis.customElements = {
    define(name, cls) { registry.set(name, cls); },
    get(name) { return registry.get(name); },
  };
}
if (!globalThis.CustomEvent) {
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, init = {}) { this.type = type; this.detail = init.detail ?? {}; }
  };
}

Deno.test("artifact-export: suggestArtifactFilename suggests clean name and correct extensions", () => {
  // Markdown
  assertEquals(
    suggestArtifactFilename({ title: "Q3 Report", mimeType: "text/markdown" }),
    "Q3-Report.md",
  );
  assertEquals(
    suggestArtifactFilename({ name: "Analysis", kind: "report" }),
    "Analysis.md",
  );

  // CSV
  assertEquals(
    suggestArtifactFilename({ title: "Sales Data", kind: "csv" }),
    "Sales-Data.csv",
  );
  assertEquals(
    suggestArtifactFilename({ title: "Metrics", mimeType: "text/csv" }),
    "Metrics.csv",
  );

  // JSON
  assertEquals(
    suggestArtifactFilename({ title: "Configuration", type: "json" }),
    "Configuration.json",
  );
  assertEquals(
    suggestArtifactFilename({ name: "api_spec", mimeType: "application/json" }),
    "api_spec.json",
  );

  // HTML
  assertEquals(
    suggestArtifactFilename({ title: "Dashboard", type: "html" }),
    "Dashboard.html",
  );

  // SVG
  assertEquals(
    suggestArtifactFilename({ title: "Chart", mimeType: "image/svg+xml" }),
    "Chart.svg",
  );
  assertEquals(
    suggestArtifactFilename({ title: "Logo", content: "<svg viewBox='0 0 10 10'></svg>" }),
    "Logo.svg",
  );

  // PNG
  assertEquals(
    suggestArtifactFilename({ title: "Screenshot", type: "image" }),
    "Screenshot.png",
  );

  // Plain text fallback
  assertEquals(
    suggestArtifactFilename({ title: "Raw Notes", type: "text", content: "simple text" }),
    "Raw-Notes.txt",
  );

  // Preserves existing valid extension
  assertEquals(
    suggestArtifactFilename({ title: "document.md", type: "text" }),
    "document.md",
  );
  assertEquals(
    suggestArtifactFilename({ title: "export.json", type: "json" }),
    "export.json",
  );

  // Sanitizes dangerous path characters
  assertEquals(
    suggestArtifactFilename({ title: "bad/name:with*chars?", type: "html" }),
    "bad-name-with-chars-.html",
  );
});

Deno.test("artifact-export: saveArtifactToDisk calls picker and writes exact bytes", async () => {
  const writtenChunks: Uint8Array[] = [];
  let closed = false;
  let receivedPickerOpts: any = null;

  const fakeHandle = {
    name: "My-Report.md",
    createWritable: async () => ({
      write: async (chunk: Uint8Array) => { writtenChunks.push(chunk); },
      close: async () => { closed = true; },
    }),
  };

  const fakePicker = async (opts: any) => {
    receivedPickerOpts = opts;
    return fakeHandle;
  };

  const artifact = {
    title: "My Report",
    kind: "markdown",
    content: "# Hello World\nByte-identical content test.",
  };

  const result = await saveArtifactToDisk(artifact, { showSaveFilePickerFn: fakePicker });

  assertEquals(result.ok, true);
  assertEquals(result.method, "file-picker");
  assertEquals(result.filename, "My-Report.md");
  assertEquals(receivedPickerOpts?.suggestedName, "My-Report.md");
  assertEquals(closed, true);

  const writtenText = new TextDecoder().decode(writtenChunks[0]);
  assertEquals(writtenText, artifact.content);
});

Deno.test("artifact-export: saveArtifactToDisk handles user cancellation (AbortError)", async () => {
  const abortingPicker = async () => {
    const err = new Error("The user aborted a request.");
    err.name = "AbortError";
    throw err;
  };

  const artifact = {
    title: "Cancelled Report",
    type: "text",
    content: "content",
  };

  const result = await saveArtifactToDisk(artifact, { showSaveFilePickerFn: abortingPicker });
  assertEquals(result.ok, false);
  assertEquals(result.cancelled, true);
});

Deno.test("artifact-export: saveArtifactToDisk falls back to download when picker is absent", async () => {
  let fallbackInvoked = false;
  let fallbackData: any = null;

  const fallbackFn = async (data: any) => {
    fallbackInvoked = true;
    fallbackData = data;
  };

  const artifact = {
    title: "Table Export",
    kind: "csv",
    content: "col1,col2\nval1,val2",
  };

  const result = await saveArtifactToDisk(artifact, {
    showSaveFilePickerFn: null,
    downloadFallbackFn: fallbackFn,
  });

  assertEquals(result.ok, true);
  assertEquals(result.method, "download");
  assertEquals(result.filename, "Table-Export.csv");
  assertEquals(fallbackInvoked, true);
  assertEquals(fallbackData.filename, "Table-Export.csv");
  assert(fallbackData.blob instanceof Blob);
});

Deno.test("artifact-export: exportAssetToFolder writes byte-identical content to directoryHandle with subpaths", async () => {
  const dirMap = new Map<string, any>();
  const filesWritten = new Map<string, Uint8Array>();

  function makeMockDir(name = ""): any {
    return {
      name,
      getDirectoryHandle: async (subName: string, _opts: any) => {
        if (!dirMap.has(subName)) {
          dirMap.set(subName, makeMockDir(subName));
        }
        return dirMap.get(subName);
      },
      getFileHandle: async (fileName: string, _opts: any) => {
        return {
          name: fileName,
          createWritable: async () => ({
            write: async (bytes: Uint8Array) => { filesWritten.set(fileName, bytes); },
            close: async () => {},
          }),
        };
      },
    };
  }

  const rootDir = makeMockDir("root");
  const artifact = {
    id: "art-1",
    name: "deliverable.md",
    content: "### Deliverable Content\nExact bytes on disk.",
  };

  const res = await exportAssetToFolder({
    artifact,
    directoryHandle: rootDir,
    filename: "reports/final/deliverable.md",
  });

  assertEquals(res.ok, true);
  assertEquals(res.written, true);
  assertEquals(res.path, "reports/final/deliverable.md");
  assert(dirMap.has("reports"));
  assert(filesWritten.has("deliverable.md"));

  const savedText = new TextDecoder().decode(filesWritten.get("deliverable.md"));
  assertEquals(savedText, artifact.content);
});

Deno.test("export_asset_to_folder: management tool catalog and capabilities contract", () => {
  assert(MANAGEMENT_TOOL_NAMES.includes("export_asset_to_folder"), "must be in management-tools.js MANAGEMENT_TOOL_NAMES");
  assert(MANAGEMENT_CAPABILITY_TOOL_NAMES.includes("export_asset_to_folder"), "must be in chrome-tool-capabilities.js MANAGEMENT_CAPABILITY_TOOL_NAMES");

  const cap = chromeToolCapability("export_asset_to_folder", "management");
  assertEquals(cap.toolName, "export_asset_to_folder");
  assertEquals(cap.sourceKind, "management");
  assertEquals(cap.routeFamily, "management.assets");
  assertEquals(cap.mutationClass, "mutating");
  // Destructive policy class: same approval class as write_file
  assertEquals(cap.policyClass, "destructive");

  // Purpose group must be 'assets'
  const group = toolPurposeGroup("export_asset_to_folder", "management");
  assertEquals(group, "assets");

  // Human label in permission language
  assertEquals(permissionUserLanguage("export_asset_to_folder"), "Save artifact to folder");
  assertEquals(PERMISSION_USER_LANGUAGE["export_asset_to_folder"], "Save artifact to folder");

  // Tool summary line
  const summary = describeToolCall("export_asset_to_folder", { path: "reports/final.md" });
  assertEquals(summary, "Saving artifact to “reports/final.md”");

  // Action ledger row
  const ledger = ledgerRowFor(
    "export_asset_to_folder",
    { path: "reports/final.md" },
    { ok: true, name: "Deliverable", path: "reports/final.md" },
  );
  assert(ledger !== null);
  assertEquals(ledger.sentence, "Saved Deliverable to reports/final.md");
  assertEquals(ledger.inverse, null);
});

Deno.test("export_asset_to_folder: guard test - cannot bypass owner approval card on granted folder", async () => {
  let approvalCardPresented = false;
  let writeCommitted = false;

  // Simulate route dispatch with mock approval gate
  const mockContext = {
    principal: "model",
    scope: { taskId: "task-test" },
  };

  const fakeRequireOwnerApproval = async (_ctx: any, action: string, _target: string, _payload: any) => {
    assertEquals(action, "fs.write");
    approvalCardPresented = true;
    // Simulate denial
    return { ok: false, error: "denied_by_owner", approvalDenied: true };
  };

  const tools = managementToolset({
    callRoute: async (route: string, args: any) => {
      if (route === "asset.export-to-folder") {
        // Enforce the approval gate
        const gate = await fakeRequireOwnerApproval(mockContext, "fs.write", args.path, args);
        if (!gate.ok) return gate;
        writeCommitted = true;
        return { ok: true, written: true };
      }
      return { ok: false };
    },
  });

  const tool = tools["export_asset_to_folder"];
  assert(tool, "export_asset_to_folder must be present in managementToolset");

  const res = await tool.execute({
    assetId: "art-100",
    path: "project/out.md",
    folder: "project-folder",
  });

  assertEquals(approvalCardPresented, true, "Approval card must be presented");
  assertEquals(writeCommitted, false, "Write must NOT be committed when owner approval is denied");
  assertEquals((res as any).ok, false);
});

Deno.test("ArtifactCard: has Save to disk button and emits save event with detail", async () => {
  await import("../extension/shared/components.js");
  const ArtifactCardClass = globalThis.customElements.get("artifact-card");
  assert(ArtifactCardClass, "artifact-card must be registered in customElements");

  const listeners = new Map<string, (e: any) => void>();
  let renderedMarkup = "";

  const shadow = {
    _html: "",
    set innerHTML(v: string) {
      this._html = v;
      renderedMarkup = v;
    },
    get innerHTML() { return this._html; },
    querySelector(sel: string) {
      if (sel === '[data-act="save"]') {
        return {
          addEventListener: (type: string, fn: any) => {
            listeners.set("save", fn);
          },
        };
      }
      return null;
    },
    querySelectorAll: () => [],
  };

  const emittedEvents: any[] = [];
  const host = {
    constructor: ArtifactCardClass,
    _root: shadow,
    _rendered: false,
    _preview: "",
    getAttribute(name: string) {
      if (name === "id") return "asset-save-1";
      if (name === "name") return "Analysis Report";
      if (name === "type") return "text";
      if (name === "origin") return "master";
      if (name === "actions") return ""; // allow all default actions
      return null;
    },
    _emit(type: string, detail: any) {
      emittedEvents.push({ type, detail });
    },
  };

  // Invoke render and wire on prototype
  ArtifactCardClass.prototype._render.call(host);
  ArtifactCardClass.prototype._wire.call(host);

  assert(renderedMarkup.includes('data-act="save"'), "Must render Save to disk button in markup");
  assert(renderedMarkup.includes("Save to disk"), "Must include visible 'Save to disk' text");
  assert(listeners.has("save"), "Must wire click listener on save button");

  // Trigger the save action
  listeners.get("save")!({});

  assertEquals(emittedEvents.length, 1);
  assertEquals(emittedEvents[0].type, "save");
  assertEquals(emittedEvents[0].detail.id, "asset-save-1");
  assertEquals(emittedEvents[0].detail.name, "Analysis Report");
});
