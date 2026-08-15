// apply-theme.js — apply the user's stored theme to this surface on load.
// Include it as a module script in each surface's HTML head.
//
// The theme is shared state whose single authority is the SERVICE WORKER
// (Settings writes it via the SW `kv.set` route). Reading chrome.storage.local
// directly here would (a) throw when the optional storage permission is absent,
// and (b) miss the SW's session fallback when storage is not granted — a
// realm-local split. Route the read through the SW so every surface shows the
// same theme as Settings.
(async () => {
  try {
    const s = await chrome.runtime.sendMessage({ type: "kv.get", keys: "cap:theme" });
    const theme = s?.["cap:theme"] ?? "sunlit";
    document.documentElement.dataset.theme = theme;
  } catch {
    // worker not reachable (e.g. file:// preview) — default theme stays
  }
})();
