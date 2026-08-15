// apply-theme.js — apply the user's stored theme to this surface on load.
// Include it as a module script in each surface's HTML head.
(async () => {
  try {
    const s = await chrome.storage.local.get("cap:theme");
    const theme = s["cap:theme"] ?? "midnight";
    document.documentElement.dataset.theme = theme;
  } catch {
    // storage unavailable (e.g. file:// preview) — default theme stays
  }
})();
