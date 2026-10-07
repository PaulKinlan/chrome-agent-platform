// scripts/generate-about-page.mjs — generate the About & Third-Party Licenses
// page from the bundled tool inventory.
//
// Paul's permanent licence policy (2026-10-06): every bundled library and tool
// we ship must be listed with its emitted licence/notice text, GENERATED from
// the bundled inventory so attribution cannot drift from what actually ships.
//
// Run:
//   node scripts/generate-about-page.mjs          → generate extension/about/about.html
//   node scripts/generate-about-page.mjs --check  → verify no drift (exit 1 on drift)

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");

export const UPSTREAM_MAP = Object.freeze({
  "cap.bundled.avif": {
    upstreamName: "cavif-rs (ravif / rav1e)",
    upstreamUrl: "https://github.com/kornelski/cavif-rs",
  },
  "cap.bundled.awk": {
    upstreamName: "posixutils-rs (posixutils-awk)",
    upstreamUrl: "https://github.com/rustcoreutils/posixutils-rs",
  },
  "cap.bundled.awk.filter.bounded": {
    upstreamName: "Chrome Agent Platform (wasi-libc sysroot)",
    upstreamUrl: "https://github.com/PaulKinlan/chrome-agent-platform",
  },
  "cap.bundled.base64": {
    upstreamName: "Chrome Agent Platform (unix-stream-v1)",
    upstreamUrl: "https://github.com/PaulKinlan/chrome-agent-platform",
  },
  "cap.bundled.chacha20.poly1305": {
    upstreamName: "@awasm/noble (Paul Miller)",
    upstreamUrl: "https://github.com/paulmillr/awasm-noble",
  },
  "cap.bundled.compressops": {
    upstreamName: "Chrome Agent Platform",
    upstreamUrl: "https://github.com/PaulKinlan/chrome-agent-platform",
  },
  "cap.bundled.csvtool": {
    upstreamName: "Chrome Agent Platform (clean-room)",
    upstreamUrl: "https://github.com/PaulKinlan/chrome-agent-platform",
  },
  "cap.bundled.cut": {
    upstreamName: "Chrome Agent Platform (a2)",
    upstreamUrl: "https://github.com/PaulKinlan/chrome-agent-platform",
  },
  "cap.bundled.date.formatter.bounded": {
    upstreamName: "Chrome Agent Platform (wasi-libc sysroot)",
    upstreamUrl: "https://github.com/PaulKinlan/chrome-agent-platform",
  },
  "cap.bundled.diff": {
    upstreamName: "Chrome Agent Platform (b2)",
    upstreamUrl: "https://github.com/PaulKinlan/chrome-agent-platform",
  },
  "cap.bundled.du": {
    upstreamName: "Chrome Agent Platform (c2)",
    upstreamUrl: "https://github.com/PaulKinlan/chrome-agent-platform",
  },
  "cap.bundled.grep": {
    upstreamName: "Chrome Agent Platform (unix-stream-v1)",
    upstreamUrl: "https://github.com/PaulKinlan/chrome-agent-platform",
  },
  "cap.bundled.gzip": {
    upstreamName: "zlib (madler/zlib)",
    upstreamUrl: "https://github.com/madler/zlib",
  },
  "cap.bundled.hash.adler32": {
    upstreamName: "hash-wasm (Daninet/hash-wasm)",
    upstreamUrl: "https://github.com/Daninet/hash-wasm",
  },
  "cap.bundled.hash.blake2b": {
    upstreamName: "hash-wasm (Daninet/hash-wasm)",
    upstreamUrl: "https://github.com/Daninet/hash-wasm",
  },
  "cap.bundled.hash.blake2s": {
    upstreamName: "hash-wasm (Daninet/hash-wasm)",
    upstreamUrl: "https://github.com/Daninet/hash-wasm",
  },
  "cap.bundled.hash.blake3": {
    upstreamName: "hash-wasm (Daninet/hash-wasm)",
    upstreamUrl: "https://github.com/Daninet/hash-wasm",
  },
  "cap.bundled.hash.crc32": {
    upstreamName: "hash-wasm (Daninet/hash-wasm)",
    upstreamUrl: "https://github.com/Daninet/hash-wasm",
  },
  "cap.bundled.hash.md4": {
    upstreamName: "hash-wasm (Daninet/hash-wasm)",
    upstreamUrl: "https://github.com/Daninet/hash-wasm",
  },
  "cap.bundled.hash.ripemd160": {
    upstreamName: "hash-wasm (Daninet/hash-wasm)",
    upstreamUrl: "https://github.com/Daninet/hash-wasm",
  },
  "cap.bundled.hash.sha1": {
    upstreamName: "hash-wasm (Daninet/hash-wasm)",
    upstreamUrl: "https://github.com/Daninet/hash-wasm",
  },
  "cap.bundled.hash.sha224": {
    upstreamName: "hash-wasm (Daninet/hash-wasm)",
    upstreamUrl: "https://github.com/Daninet/hash-wasm",
  },
  "cap.bundled.hash.sha3.256": {
    upstreamName: "hash-wasm (Daninet/hash-wasm)",
    upstreamUrl: "https://github.com/Daninet/hash-wasm",
  },
  "cap.bundled.hash.sha384": {
    upstreamName: "hash-wasm (Daninet/hash-wasm)",
    upstreamUrl: "https://github.com/Daninet/hash-wasm",
  },
  "cap.bundled.hash.sm3": {
    upstreamName: "hash-wasm (Daninet/hash-wasm)",
    upstreamUrl: "https://github.com/Daninet/hash-wasm",
  },
  "cap.bundled.hash.whirlpool": {
    upstreamName: "hash-wasm (Daninet/hash-wasm)",
    upstreamUrl: "https://github.com/Daninet/hash-wasm",
  },
  "cap.bundled.hash.xxhash32": {
    upstreamName: "hash-wasm (Daninet/hash-wasm)",
    upstreamUrl: "https://github.com/Daninet/hash-wasm",
  },
  "cap.bundled.head": {
    upstreamName: "Chrome Agent Platform (a2)",
    upstreamUrl: "https://github.com/PaulKinlan/chrome-agent-platform",
  },
  "cap.bundled.imageops": {
    upstreamName: "Chrome Agent Platform",
    upstreamUrl: "https://github.com/PaulKinlan/chrome-agent-platform",
  },
  "cap.bundled.jq": {
    upstreamName: "jq (jqlang/jq)",
    upstreamUrl: "https://github.com/jqlang/jq",
  },
  "cap.bundled.jxl": {
    upstreamName: "jxl-oxide (tirr-c/jxl-oxide)",
    upstreamUrl: "https://github.com/tirr-c/jxl-oxide",
  },
  "cap.bundled.markdown": {
    upstreamName: "cmark (commonmark/cmark)",
    upstreamUrl: "https://github.com/commonmark/cmark",
  },
  "cap.bundled.md5sum": {
    upstreamName: "Chrome Agent Platform (a2)",
    upstreamUrl: "https://github.com/PaulKinlan/chrome-agent-platform",
  },
  "cap.bundled.oxipng": {
    upstreamName: "oxipng (shssoichiro/oxipng)",
    upstreamUrl: "https://github.com/shssoichiro/oxipng",
  },
  "cap.bundled.patch": {
    upstreamName: "Chrome Agent Platform (b2)",
    upstreamUrl: "https://github.com/PaulKinlan/chrome-agent-platform",
  },
  "cap.bundled.sed": {
    upstreamName: "minised (ExactCODE)",
    upstreamUrl: "https://dl.exactcode.de/oss/minised/minised-1.16.tar.gz",
  },
  "cap.bundled.sha256sum": {
    upstreamName: "Chrome Agent Platform (a2)",
    upstreamUrl: "https://github.com/PaulKinlan/chrome-agent-platform",
  },
  "cap.bundled.sha512sum": {
    upstreamName: "Chrome Agent Platform (a2)",
    upstreamUrl: "https://github.com/PaulKinlan/chrome-agent-platform",
  },
  "cap.bundled.sort": {
    upstreamName: "Chrome Agent Platform (unix-stream-v1)",
    upstreamUrl: "https://github.com/PaulKinlan/chrome-agent-platform",
  },
  "cap.bundled.sqlite3.query.bounded": {
    upstreamName: "SQLite (sqlite.org)",
    upstreamUrl: "https://www.sqlite.org/",
  },
  "cap.bundled.stat": {
    upstreamName: "Chrome Agent Platform (c2)",
    upstreamUrl: "https://github.com/PaulKinlan/chrome-agent-platform",
  },
  "cap.bundled.tail": {
    upstreamName: "Chrome Agent Platform (a2)",
    upstreamUrl: "https://github.com/PaulKinlan/chrome-agent-platform",
  },
  "cap.bundled.toml2json": {
    upstreamName: "tomlc99 (cktan/tomlc99)",
    upstreamUrl: "https://github.com/cktan/tomlc99",
  },
  "cap.bundled.touch": {
    upstreamName: "Chrome Agent Platform (c2)",
    upstreamUrl: "https://github.com/PaulKinlan/chrome-agent-platform",
  },
  "cap.bundled.tr": {
    upstreamName: "Chrome Agent Platform (unix-stream-v1)",
    upstreamUrl: "https://github.com/PaulKinlan/chrome-agent-platform",
  },
  "cap.bundled.tree": {
    upstreamName: "Chrome Agent Platform (c2)",
    upstreamUrl: "https://github.com/PaulKinlan/chrome-agent-platform",
  },
  "cap.bundled.truncate": {
    upstreamName: "Chrome Agent Platform (c2)",
    upstreamUrl: "https://github.com/PaulKinlan/chrome-agent-platform",
  },
  "cap.bundled.uniq": {
    upstreamName: "Chrome Agent Platform (unix-stream-v1)",
    upstreamUrl: "https://github.com/PaulKinlan/chrome-agent-platform",
  },
  "cap.bundled.uuid": {
    upstreamName: "Chrome Agent Platform (a2)",
    upstreamUrl: "https://github.com/PaulKinlan/chrome-agent-platform",
  },
  "cap.bundled.wc": {
    upstreamName: "Chrome Agent Platform (unix-stream-v1)",
    upstreamUrl: "https://github.com/PaulKinlan/chrome-agent-platform",
  },
  "cap.bundled.xxd": {
    upstreamName: "Chrome Agent Platform (a2)",
    upstreamUrl: "https://github.com/PaulKinlan/chrome-agent-platform",
  },
  "cap.bundled.zxing": {
    upstreamName: "zxing-cpp (zxing-cpp/zxing-cpp)",
    upstreamUrl: "https://github.com/zxing-cpp/zxing-cpp",
  },
});

function escapeHtml(text) {
  if (typeof text !== "string") return "";
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export async function extractAboutData({ root = REPO } = {}) {
  // Load BUNDLED_INVENTORY from extension/lib/bundled-inventory-data.js
  const invPath = join(root, "extension/lib/bundled-inventory-data.js");
  if (!existsSync(invPath)) {
    throw new Error("Could not find " + invPath);
  }
  const invUrl = pathToFileURL(resolve(invPath)).href + `?t=${Date.now()}_${Math.random()}`;
  const invMod = await import(invUrl);
  const inventory = invMod.BUNDLED_INVENTORY;
  if (!inventory || !Array.isArray(inventory.manifests)) {
    throw new Error("Could not parse BUNDLED_INVENTORY from " + invPath);
  }

  // Load package rows for tool metadata
  const rowsPath = join(root, "extension/lib/bundled-tool-packages.data.js");
  let packageRows = [];
  if (existsSync(rowsPath)) {
    const rowsUrl = pathToFileURL(resolve(rowsPath)).href + `?t=${Date.now()}_${Math.random()}`;
    const rowsMod = await import(rowsUrl);
    packageRows = rowsMod.BUNDLED_TOOL_PACKAGE_ROWS || [];
  }
  const rowMap = new Map();
  for (const r of packageRows) {
    rowMap.set(r.packageId, r);
  }

  const entries = [];
  for (const m of inventory.manifests) {
    const mfPath = join(root, "extension/wasm/manifests", `${m.pkg}-${m.version}.manifest.json`);
    if (!existsSync(mfPath)) {
      throw new Error(`Manifest not found: ${mfPath}`);
    }
    const manifest = JSON.parse(readFileSync(mfPath, "utf8"));
    const row = rowMap.get(m.pkg) || {};

    const toolId = row.toolId || manifest.tools?.[0]?.toolId || m.pkg.replace(/^cap\.bundled\./, "").replace(/\./g, "_");
    const displayName = row.displayName || manifest.meta?.label || toolId;
    const category = row.category || manifest.meta?.category || "general";
    const description = row.description || manifest.meta?.description || "";
    const spdx = manifest.license?.spdx || row.licence?.spdx || "Unknown";

    const licRel = manifest.license?.file;
    if (!licRel || !existsSync(join(root, licRel))) {
      throw new Error(`Missing license file for ${m.pkg}: ${licRel}`);
    }
    const licenseText = readFileSync(join(root, licRel), "utf8");

    const noticesRel = manifest.license?.notices;
    let noticesText = null;
    if (noticesRel && existsSync(join(root, noticesRel))) {
      noticesText = readFileSync(join(root, noticesRel), "utf8");
    }

    const upstream = UPSTREAM_MAP[m.pkg];
    if (!upstream) {
      throw new Error(`Missing UPSTREAM_MAP entry for package "${m.pkg}". Every bundled package in inventory must have an explicit upstream attribution.`);
    }

    entries.push({
      packageId: m.pkg,
      version: m.version,
      toolId,
      displayName,
      category,
      description,
      spdx,
      upstreamName: upstream.upstreamName,
      upstreamUrl: upstream.upstreamUrl,
      sourceRepo: manifest.source?.repo || "https://github.com/PaulKinlan/chrome-agent-platform",
      sourceCommit: manifest.source?.commit || "",
      rebuildRef: manifest.build?.rebuildRef || "",
      licenseFile: licRel,
      noticesFile: noticesRel || null,
      licenseText,
      noticesText,
    });
  }

  // Sort deterministically by toolId / packageId
  entries.sort((a, b) => a.toolId.localeCompare(b.toolId) || a.packageId.localeCompare(b.packageId));

  const metadata = {
    schemaVersion: 1,
    release: inventory.release || "0.0.0",
    toolCount: entries.length,
  };

  return { metadata, entries };
}

export function getCapIconSvg(root = REPO) {
  const compPath = join(root, "extension/shared/components.js");
  if (existsSync(compPath)) {
    const compSrc = readFileSync(compPath, "utf8");
    const m = compSrc.match(/cap:\s*'([^']+)'/);
    if (m) {
      return m[1].replace("<svg", '<svg class="brand-logo"');
    }
  }
  return '<svg class="brand-logo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><path d="M2.5 14.5c0-5 3.8-9 8.5-9 4.2 0 7 2.5 7.5 6.5l3.8 1.5c.8.3.8 1.2 0 1.5-2.2.8-5.8 1-7.8 1-2 0-8.5 0-12-1.5z"/><path d="M11 5.5v9"/><path d="M11 5.5c-2.8 1.2-5 4-5.5 9"/><path d="M10 4.5c.5-.7 1.5-.7 2 0"/></svg>';
}

export function renderAboutHtml({ metadata, entries, root = REPO }) {
  const capIcon = getCapIconSvg(root);
  const toolCards = entries.map((entry) => {
    const licFilename = entry.licenseFile ? entry.licenseFile.split("/").pop() : "";
    const noticesFilename = entry.noticesFile ? entry.noticesFile.split("/").pop() : "";

    let disclosureTitle = `View License (${escapeHtml(licFilename)})`;
    if (noticesFilename) {
      disclosureTitle = `View License &amp; Notices (${escapeHtml(licFilename)} + ${escapeHtml(noticesFilename)})`;
    }

    let noticeSection = "";
    if (entry.noticesText) {
      noticeSection = `
              <div class="notice-block">
                <h4 class="notice-heading">Notices (${escapeHtml(noticesFilename)})</h4>
                <pre class="license-pre">${escapeHtml(entry.noticesText)}</pre>
              </div>`;
    }

    const licenseSection = `
              <div class="license-block">
                <h4 class="notice-heading">License Text (${escapeHtml(licFilename)} &mdash; ${escapeHtml(entry.spdx)})</h4>
                <pre class="license-pre">${escapeHtml(entry.licenseText)}</pre>
              </div>`;

    return `        <article class="tool-card" id="tool-${escapeHtml(entry.toolId)}" data-tool-id="${escapeHtml(entry.toolId)}" data-package-id="${escapeHtml(entry.packageId)}" data-category="${escapeHtml(entry.category)}" data-spdx="${escapeHtml(entry.spdx)}">
          <header class="tool-card-head">
            <div class="tool-identity">
              <h3 class="tool-title"><code>${escapeHtml(entry.displayName)}</code></h3>
              <span class="badge version-badge">v${escapeHtml(entry.version)}</span>
              <span class="badge category-badge">${escapeHtml(entry.category)}</span>
            </div>
            <div class="tool-meta-row">
              <span class="badge spdx-badge" title="SPDX license expression">SPDX: <strong>${escapeHtml(entry.spdx)}</strong></span>
              <a href="${escapeHtml(entry.upstreamUrl)}" class="source-link" target="_blank" rel="noopener noreferrer" title="View upstream source repository">
                <span>Source</span>
                <svg class="external-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
              </a>
            </div>
          </header>
          <p class="tool-desc">${escapeHtml(entry.description)}</p>
          <div class="tool-provenance">
            <span class="prov-item">Package: <code>${escapeHtml(entry.packageId)}</code></span>
            ${entry.rebuildRef ? `<span class="prov-item">Rebuild: <code>${escapeHtml(entry.rebuildRef)}</code></span>` : ""}
          </div>
          <details class="license-disclosure">
            <summary class="disclosure-summary">
              <span class="summary-label">${disclosureTitle}</span>
            </summary>
            <div class="disclosure-body">
              ${noticeSection}
              ${licenseSection}
            </div>
          </details>
        </article>`;
  }).join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <title>About &amp; Third-Party Software Notices &mdash; Chrome Agent Platform</title>
    <link rel="icon" href="../icons/icon16.png">
    <link rel="stylesheet" href="../shared/theme.css">
    <link rel="stylesheet" href="about.css">
  </head>
  <body>
    <main class="page">
      <header class="head">
        <p class="brand">
          ${capIcon}
          <span>Chrome Agent Platform</span>
        </p>
        <h1 class="page-title">About &amp; Third-Party Software Notices</h1>
        <div class="version-banner">
          <span class="version-label">Version <strong id="about-version">v${escapeHtml(metadata.release)}</strong></span>
        </div>
        <nav class="head-nav" aria-label="Related pages">
          <a href="../options/options.html#about" class="head-nav-link">&larr; Back to Settings</a>
          <span class="nav-sep">&bull;</span>
          <a href="../privacy/privacy.html" class="head-nav-link">Privacy Statement</a>
          <span class="nav-sep">&bull;</span>
          <a href="../CHANGELOG.md" class="head-nav-link" id="changelog-link">Release Notes</a>
        </nav>
        <p class="lede">Chrome as the agent platform &mdash; a multi-agent hub for the web, with per-site agents, storage kept on this device, and usage accounting.</p>
        <p class="lede">This page lists every bundled WebAssembly tool and library shipped with Chrome Agent Platform. Attribution, licenses, and notice texts are generated directly from the bundled software inventory so they cannot drift from what ships.</p>
      </header>

      <section class="tools-section" aria-labelledby="tools-heading">
        <div class="tools-section-header">
          <h2 id="tools-heading">Bundled Tools &amp; Libraries (<span id="tool-count">${metadata.toolCount}</span>)</h2>
          <div class="section-actions">
            <button type="button" class="btn small" id="expand-all-btn">Expand all notices</button>
            <button type="button" class="btn small" id="collapse-all-btn">Collapse all notices</button>
          </div>
        </div>
        <div class="toolbar">
          <label for="tool-search" class="sr-only">Filter bundled tools</label>
          <input type="search" id="tool-search" class="search-input" placeholder="Filter by name, license, category, or keyword (e.g. jq, MIT, media)…" autocomplete="off" spellcheck="false">
          <p id="filter-status" class="filter-status" role="status" aria-live="polite">Showing ${metadata.toolCount} tools</p>
        </div>
        <div class="tools-grid" id="tools-container">
${toolCards}
        </div>
        <p id="no-results" class="no-results" hidden>No bundled tools match the filter.</p>
      </section>

      <footer class="foot">
        <p class="foot-copy">Chrome Agent Platform &mdash; attribution and license transparency.</p>
        <p class="foot-links">
          <a href="../options/options.html#about">&larr; Settings</a>
          <span class="nav-sep">&bull;</span>
          <a href="../privacy/privacy.html">Privacy Statement</a>
        </p>
      </footer>
    </main>

    <script src="about.js"></script>
  </body>
</html>
`;
}

export async function syncAboutPage({ root = REPO, check = false } = {}) {
  const { metadata, entries } = await extractAboutData({ root });
  const htmlContent = renderAboutHtml({ metadata, entries, root });
  const htmlPath = join(root, "extension/about/about.html");

  if (check) {
    const existingHtml = await readFile(htmlPath, "utf8").catch(() => null);
    if (existingHtml !== htmlContent) {
      console.error("DRIFT: extension/about/about.html differs from generated output — run `npm run sync:about`");
      return false;
    }
    console.log("About page in sync");
    return true;
  }

  await writeFile(htmlPath, htmlContent, "utf8");
  console.log(`Generated extension/about/about.html (${entries.length} tools)`);
  return true;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const check = process.argv.includes("--check");
  const ok = await syncAboutPage({ check });
  process.exit(ok ? 0 : 1);
}
