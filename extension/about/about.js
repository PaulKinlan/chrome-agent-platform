// extension/about/about.js — client-side enhancement for the About page

function initAboutPage() {
  const searchInput = document.getElementById("tool-search");
  const filterStatus = document.getElementById("filter-status");
  const noResults = document.getElementById("no-results");
  const expandAllBtn = document.getElementById("expand-all-btn");
  const collapseAllBtn = document.getElementById("collapse-all-btn");
  const toolCards = Array.from(document.querySelectorAll(".tool-card"));
  const totalCount = toolCards.length;

  // Set changelog link to packaged CHANGELOG.md if in extension context
  try {
    if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
      const clLink = document.getElementById("changelog-link");
      if (clLink) clLink.href = chrome.runtime.getURL("CHANGELOG.md");
    }
  } catch {
    // Non-extension context
  }

  function applyFilter() {
    if (!searchInput) return;
    const query = searchInput.value.trim().toLowerCase();
    let visibleCount = 0;

    for (const card of toolCards) {
      const toolId = card.getAttribute("data-tool-id") || "";
      const pkgId = card.getAttribute("data-package-id") || "";
      const category = card.getAttribute("data-category") || "";
      const spdx = card.getAttribute("data-spdx") || "";
      const text = card.textContent || "";

      const match = !query ||
        toolId.toLowerCase().includes(query) ||
        pkgId.toLowerCase().includes(query) ||
        category.toLowerCase().includes(query) ||
        spdx.toLowerCase().includes(query) ||
        text.toLowerCase().includes(query);

      card.hidden = !match;
      if (match) visibleCount++;
    }

    if (filterStatus) {
      if (query) {
        filterStatus.textContent = `Showing ${visibleCount} of ${totalCount} tools`;
      } else {
        filterStatus.textContent = `Showing ${totalCount} tools`;
      }
    }

    if (noResults) {
      noResults.hidden = visibleCount > 0;
    }
  }

  if (searchInput) {
    searchInput.addEventListener("input", applyFilter);
  }

  if (expandAllBtn) {
    expandAllBtn.addEventListener("click", () => {
      for (const card of toolCards) {
        if (!card.hidden) {
          const details = card.querySelectorAll("details");
          for (const d of details) d.open = true;
        }
      }
    });
  }

  if (collapseAllBtn) {
    collapseAllBtn.addEventListener("click", () => {
      for (const card of toolCards) {
        const details = card.querySelectorAll("details");
        for (const d of details) d.open = false;
      }
    });
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initAboutPage);
} else {
  initAboutPage();
}
