# Artifact Display & New-Tab Opening Architecture

**Status:** Implemented & Verified.  
**Reference:** FolioLM / NotebookLM-Chrome Full-Tab Artifact Model.  
**Scope:** Responsive full-container artifact sizing, minimal Web-Accessible Resources (WAR), and dedicated new-tab artifact viewing.  

---

## 1. Context & The "Tiny Window" Sizing Defect

### The Problem
Previously, clicking an asset or generated HTML artifact in the gallery or hub opened the content in an `<agent-dialog>` or iframe that collapsed down to a tiny window (default browser `300×150` iframe fallback), rendering interactive artifacts and generative UI impossible to view or interact with properly.

### Root Cause
1. In `extension/artifacts/index.js`, the `<agent-dialog>` body container was given a static `minHeight: 200px` without explicit height or flex stretching for the `.frame` container.
2. The nested `.html-frame` and its sandboxed `iframe` lacked `flex: 1` and `minHeight: 70vh`, causing the browser user-agent stylesheet to collapse the iframe to minimal default height.
3. In `extension/artifact/artifact.html`, the standalone viewer used fixed constraints (`max-width: 960px`, `height: 72vh`) rather than taking the full available viewport.

### The Sizing Fix
1. **Gallery & Hub Dialog (`openArtifactDialog`):**
   - Dialog body set to `minWidth: min(92vw, 1280px)`, `width: 100%`, `height: 80vh`, `minHeight: min(80vh, 850px)`.
   - Nested `.frame`, `.html-frame`, and `iframe` set to `flex: 1 1 auto`, `height: 100%`, `minHeight: min(72vh, 760px)`.
   - Images and text preformatted blocks styled with `maxHeight: 72vh`, `overflow: auto`, `object-fit: contain`.
2. **Standalone Full-Tab Viewer (`artifact/artifact.html`):**
   - Full viewport layout: `height: 100vh`, `width: 100%`, flex column container with responsive `#out` frame taking `100%` available space.

---

## 2. FolioLM Artifact Management Model & Investigation

### Findings from FolioLM (NotebookLM-Chrome)
FolioLM operates as a browser extension that enables NotebookLM-style interactive transformations, notes, and sources directly in the browser:
- **Dedicated Wrapper Pages:** When an artifact or transform is opened, FolioLM provides a dedicated viewer page with full-bleed layout rather than trapping all interactions inside small inline popups.
- **Sandboxed Rendering Host:** Interactive content is isolated in sandboxed iframe contexts under strict CSPs to execute client-side scripts safely without host leakage.
- **Deep-Link URL Routing:** Every artifact is addressable via `chrome-extension://<id>/artifact/artifact.html?id=<id>&origin=<origin>`, enabling users to open artifacts in separate tabs or windows.

---

## 3. Minimal Web-Accessible Resources (WAR) Policy

To allow external pages or tab navigations to reach the artifact viewer without broadening the attack surface of the extension, `extension/manifest.json` declares a **strictly minimal** resource set:

```json
"web_accessible_resources": [
  {
    "resources": [
      "artifact/artifact.html",
      "artifact/artifact.js",
      "sandbox/artifact-preview.html"
    ],
    "matches": [
      "<all_urls>"
    ]
  }
]
```

### Security Invariants
1. **No Sensitive Code Exposure:** Background service workers, internal libraries (`lib/*`), secrets, and options pages are **NEVER** in `web_accessible_resources`.
2. **Double-Sandboxed Iframe:** HTML artifacts continue to render through `sandbox/artifact-preview.html` with `sandbox="allow-scripts"` and strict inline CSP, preventing DOM traversal to parent extension contexts.
3. **No Ambient Host Elevation:** Web-accessible declaration does not grant host permissions; data fetching remains strictly gated through service worker message endpoints.

---

## 4. "Open in New Tab" Flow & UI Affordances

### UI Affordances Added
1. **`<artifact-card>` Action Button:**
   - Added a primary **"New tab"** button with the `external` SVG icon alongside "Reuse" and "Delete".
   - Emits custom event `"open-tab"` carrying `{ id, name, type, origin }`.
2. **Artifact Dialog Header Action:**
   - Both `artifacts/index.js` and `ntp.js` modal dialogs render an **"Open in new tab ↗"** button in the header bar.
3. **Copy Content Button:**
   - Standalone viewer `artifact/artifact.html` includes a **"Copy content"** button in the top navigation bar.

### Execution Path
When clicked:
```javascript
const url = chrome.runtime.getURL(
  `artifact/artifact.html?id=${encodeURIComponent(id)}&origin=${encodeURIComponent(origin ?? "master")}`
);
if (typeof chrome !== "undefined" && chrome.tabs?.create) {
  chrome.tabs.create({ url });
} else {
  window.open(url, "_blank");
}
```
