# Audit: Shared Sender Classifier Assumptions and Internal Message Contract

- **Bead:** `chrome-agent-platform-lw6d` ([CAP-FB-20260908-INTERNAL-SENDER-CONTRACT-01])
- **Status:** Audit completed; hardening explicitly withheld per coordinator118 directive.
- **Seams Inspected:** `extension/lib/pure.js` (`authorizeToolReport`), `extension/background/service-worker.js` (`chrome.runtime.onMessage` listener), `extension/manifest.json`, `extension/lib/owner-approval.js` (`isOwnerDirectApproval`).
- **Prior Records:** `/home/paulkinlan/cap-evidence/astra/18ug-owner-edit-20260908/sender-contract-inspection.md`, `source-audit.log`, and `source-audit.json`.

---

## 1. Executive Summary

During `18ug`, a synthetic test fixture was observed where a fake `MessageSender` object with:
- `id: "foreign-extension"`
- `url: "https://attacker.example/"`
- `origin: "https://attacker.example"`
- `documentId: "synthetic-no-tab"`
- `tab: undefined`

evaluated through `authorizeToolReport(...)` in `extension/lib/pure.js` and returned `{ kind: "extension" }`.

This audit determines:
1. **The synthetic fixture is NOT reachable in a real browser.** Chromium's browser process enforces channel separation: `chrome.runtime.onMessage` only receives IPC messages dispatched by `chrome.runtime.sendMessage` from execution contexts belonging to the extension itself. External extensions and web pages can only communicate via `chrome.runtime.onMessageExternal`.
2. **The extension declares NO external messaging channels.** `extension/manifest.json` declares no `externally_connectable` key, and `service-worker.js` registers no `chrome.runtime.onMessageExternal` listener. In Chromium, external senders attempting to message this extension are dropped unconditionally by the browser process before reaching any extension JavaScript.
3. **The shared classifier (`authorizeToolReport`) relies on implicit assumptions** inherited from its original role as a WebMCP tool report classifier. When tab metadata is missing or filtered, the classifier treats the sender as an internal extension document by default.
4. **Hardening must remain withheld** until supported by real-browser delivery evidence, because naive exact-id or URL-prefix filters risk breaking legitimate tabless or opaque-origin internal frames (such as offscreen documents, sidepanels, and sandboxed iframes).

---

## 2. The Recorded Synthetic Fixture

The exact synthetic fixture recorded during `18ug`:

```json
{
  "sender": {
    "id": "foreign-extension",
    "url": "https://attacker.example/",
    "origin": "https://attacker.example",
    "documentId": "synthetic-no-tab"
  },
  "result": {
    "kind": "extension"
  },
  "limitation": "Pure synthetic input, NOT a Chrome-delivered sender and NOT proof of browser exploit. Internal runtime.onMessage vs onMessageExternal contract; global classifier intentionally unchanged per coordinator118."
}
```

### Why `authorizeToolReport` Returns `{ kind: "extension" }`:

In `extension/lib/pure.js` (lines 893–913):

```javascript
export function authorizeToolReport(
  sender,
  messageOrigin,
  canonicalOrigin,
  extensionId,
) {
  const senderUrl = sender?.url ?? "";
  const senderTabUrl = sender?.tab?.url ?? "";
  const isContentScript = Boolean(
    sender?.id === extensionId &&
      senderTabUrl &&
      !senderUrl.startsWith("chrome-extension://") &&
      !senderUrl.startsWith("moz-extension://") &&
      sender?.frameId === 0,
  );
  if (!isContentScript) {
    if (!senderUrl.startsWith("chrome-extension://") && senderTabUrl) {
      return {
        kind: "unmatched",
        error: "tool reports must come from the page's top frame",
      };
    }
    return { kind: "extension" };
  }
  // ... origin verification ...
}
```

Execution trace for the synthetic fixture:
1. `senderTabUrl` is `""` (since `sender.tab` is undefined).
2. `isContentScript` is `false`.
3. `if (!isContentScript)` branch is taken.
4. The nested condition `if (!senderUrl.startsWith("chrome-extension://") && senderTabUrl)` evaluates `senderTabUrl` (`""` / falsy), which evaluates to `false`.
5. The function executes `return { kind: "extension" };`.

The fallback assumes: *if a message arrives at the internal listener and does not have a content-script tab URL, it must be an internal extension page.*

---

## 3. Browser Reachability and IPC Channel Boundary

### 3.1 Chromium Messaging Architecture

In Google Chrome / Chromium (Manifest V3):
- **`chrome.runtime.sendMessage` without target ID:** Dispatches to `chrome.runtime.onMessage` within the same extension. The sender is guaranteed by the browser IPC dispatch to originate from an execution context created by the extension (background service worker, extension page, extension iframe, or injected content script).
- **`chrome.runtime.sendMessage` with target ID:** Sent by an external extension or web page. In the recipient, this triggers `chrome.runtime.onMessageExternal`.
- **`externally_connectable` Manifest Requirement:** Web pages (`https://*`) cannot call `chrome.runtime.sendMessage(extensionId, ...)` unless the extension explicitly includes `externally_connectable: { matches: [...] }` in `manifest.json`. Without this declaration, calling `sendMessage` from a web page throws `Access to extension denied`.

### 3.2 Audit of Extension Manifest & Listeners

- `extension/manifest.json`: Checked; contains **no** `externally_connectable` declaration.
- `extension/background/service-worker.js`: Checked; contains **no** `chrome.runtime.onMessageExternal.addListener` registration (an occurrence in `extension/lib/terser-bounded.worker.js` is minified vendored code inside an isolated worker, not an extension listener).

### 3.3 Conclusion on Browser Reachability

The synthetic fixture `{ id: "foreign-extension", url: "https://attacker.example/" }` **cannot** be delivered to `chrome.runtime.onMessage` by Chromium. The browser process drops any external message before extension code runs.

---

## 4. Census of Legitimate Internal Senders

The following table documents every legitimate sender context that can communicate with the service worker's `chrome.runtime.onMessage`:

| Sender Context | `sender.id` | `sender.url` Scheme | `sender.tab` | `sender.frameId` | `sender.documentId` | `sender.documentLifecycle` |
|---|---|---|---|---|---|---|
| **NTP (New Tab Page)** | `== chrome.runtime.id` | `chrome-extension://` | Present (`tab.id`, `tab.url`) | `0` | Present (UUID) | `"active"` |
| **Options / Settings** | `== chrome.runtime.id` | `chrome-extension://` | Present (`tab.id`, `tab.url`) | `0` | Present (UUID) | `"active"` |
| **Side Panel** | `== chrome.runtime.id` | `chrome-extension://` | Varies (window vs tab) | `0` | Present (UUID) | `"active"` |
| **Offscreen Document** | `== chrome.runtime.id` | `chrome-extension://` | `undefined` (no tab) | `0` | Present (UUID) | `"active"` |
| **Script Sandbox (iframe)** | `== chrome.runtime.id` | `chrome-extension://` | Varies | `> 0` | Present (UUID) | `"active"` |
| **Top-frame Content Script** | `== chrome.runtime.id` | `https://` (page URL) | Present (`tab.id`, `tab.url`) | `0` | Present (UUID) | `"active"` |
| **Sub-frame Content Script** | `== chrome.runtime.id` | `https://` (frame URL)| Present (`tab.id`, `tab.url`) | `> 0` | Present (UUID) | `"active"` |

---

## 5. Assumptions in the Shared Classifier

The shared classifier makes six core assumptions. Below is the adjudication of which are supported by runtime behaviour and which are residual assumptions:

### Assumption 1: Internal channel integrity (SUPPORTED)
- *Assumption:* Any sender at `chrome.runtime.onMessage` was dispatched by code belonging to this extension.
- *Reality:* **Supported by Chromium IPC.** External extensions and web pages cannot route to `onMessage`.

### Assumption 2: Senders lacking `tab.url` are internal extension pages (PARTIALLY ASSUMED)
- *Assumption:* When `sender?.tab?.url` is falsy, the message is from an internal extension page (NTP, options, sidepanel, offscreen).
- *Reality:* **Mostly true, but with edge cases.** In legitimate operation, offscreen documents have `sender.tab === undefined`. However, content scripts running in opaque frames (`about:blank`, `data:`, sandboxed iframes without `allow-same-origin`) or tabs where URL access is restricted may have `sender.tab.url === ""` or `undefined`. In that rare edge case, `authorizeToolReport` falls through to `{ kind: "extension" }`.
- *Mitigation currently present:* The service worker's `PAGE_ALLOWED_ROUTES` allowlist restricts page routes, and content scripts are expected to have `frameId === 0` and valid `tab.url`.

### Assumption 3: Content scripts cannot forge browser sender fields (SUPPORTED)
- *Assumption:* Even if a content script's JavaScript realm is compromised, it cannot forge `sender.tab.id`, `sender.frameId`, or `sender.documentId`.
- *Reality:* **Supported by Chromium.** `MessageSender` properties are populated by the browser process from its internal frame host representation, not by renderer-supplied arguments.

### Assumption 4: Content script message bodies are untrusted (SUPPORTED)
- *Assumption:* A content script may try to inject a false `message.origin` or invoke privileged routes.
- *Reality:* **Supported and enforced.** `service-worker.js:10795` explicitly overwrites `message.origin = auth.origin` using the browser-derived URL, and enforces `PAGE_ALLOWED_ROUTES.has(message.type)` before executing any handler.

### Assumption 5: `sender.documentId` indicates owner UI document (PARTIALLY ASSUMED)
- *Assumption:* `isOwnerDirectApproval(context, action)` checks `context.principal === "extension" && typeof context.documentId === "string" && context.documentId.length > 0`.
- *Reality:* **Supported for internal pages, but dependent on classifier accuracy.** Chrome populates `sender.documentId` for web documents as well as extension documents. Therefore, `isOwnerDirectApproval` relies on `principal === "extension"` having been accurately classified by `authorizeToolReport`.

---

## 6. Recommendations (For Review, Withheld from Implementation)

Per coordinator118 instructions, no hardening is applied in this bead. When future maintenance or permission changes occur, the following bounded improvements may be considered:

1. **Explicit scheme check for tabless senders:**
   If `senderTabUrl` is absent, verify that `senderUrl.startsWith("chrome-extension://")` before returning `{ kind: "extension" }`. If a tabless sender has an `http://` or `https://` scheme, return `{ kind: "unmatched", error: "web documents must supply tab context" }`.
2. **Explicit extension ID validation:**
   Even though `onMessage` is internal-only, asserting `sender?.id === extensionId` before returning `{ kind: "extension" }` would ensure that if the classifier function is ever called from another context or wrapper, it fails closed.
3. **No broad fallback allowlists:**
   Never introduce fallback allowlists or trust message-body assertions for document identity.

---

## 7. Conclusion

The synthetic fixture observed in `18ug` reflects the behavior of an isolated pure function when given out-of-spec parameters that the browser runtime never delivers to this listener. The existing separation between `chrome.runtime.onMessage` and `chrome.runtime.onMessageExternal`, combined with the absence of `externally_connectable`, provides architectural enforcement against foreign sender injection.
