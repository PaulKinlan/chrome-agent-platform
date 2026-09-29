// scripts/generate-cap-icons.mjs — generate pixel-perfect PNG icons from the CAP line-art SVG
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SIZES = [16, 32, 48, 128];
const rootDir = path.resolve(import.meta.dirname, "..");
const iconsDir = path.join(rootDir, "extension", "icons");
const docsDir = path.join(rootDir, "docs");
const tmpDir = path.join(rootDir, "scratch", "icon-gen-temp");

fs.mkdirSync(iconsDir, { recursive: true });
fs.mkdirSync(tmpDir, { recursive: true });

for (const size of SIZES) {
  const rx = Math.max(3, Math.round(size * 28 / 128));
  let sw = 2.0;
  let pad = size * 0.1;
  let innerPaths = "";

  if (size === 16) {
    sw = 2.2;
    pad = 1.0;
    // At 16px, crisp simplified cap for pixel legibility
    innerPaths = `
      <path d="M2.5 14.5c0-5 3.8-9 8.5-9 4.2 0 7 2.5 7.5 6.5l3.8 1.5c.8.3.8 1.2 0 1.5-2.2.8-5.8 1-7.8 1-2 0-8.5 0-12-1.5z"/>
      <path d="M11 5.5v9"/>
      <path d="M10 4.5c.5-.7 1.5-.7 2 0"/>
    `;
  } else {
    if (size === 32) {
      sw = 2.2;
      pad = 2.5;
    } else if (size === 48) {
      sw = 2.1;
      pad = 4.0;
    } else {
      sw = 2.0;
      pad = 12.0;
    }
    innerPaths = `
      <path d="M2.5 14.5c0-5 3.8-9 8.5-9 4.2 0 7 2.5 7.5 6.5l3.8 1.5c.8.3.8 1.2 0 1.5-2.2.8-5.8 1-7.8 1-2 0-8.5 0-12-1.5z"/>
      <path d="M11 5.5v9"/>
      <path d="M11 5.5c-2.8 1.2-5 4-5.5 9"/>
      <path d="M10 4.5c.5-.7 1.5-.7 2 0"/>
    `;
  }

  const inner = size - pad * 2;
  const scale = inner / 24;

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${size}px; height: ${size}px; overflow: hidden; background: transparent; }
  svg { display: block; width: ${size}px; height: ${size}px; }
</style>
</head>
<body>
<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${rx}" fill="#0e6e63"/>
  <g transform="translate(${pad}, ${pad}) scale(${scale})" stroke="#ffffff" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" fill="none">
    ${innerPaths}
  </g>
</svg>
</body>
</html>`;

  const htmlPath = path.join(tmpDir, `icon_${size}.html`);
  const pngPath = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(htmlPath, html);

  execFileSync(CHROME, [
    "--headless=new",
    `--screenshot=${pngPath}`,
    `--window-size=${size},${size}`,
    "--default-background-color=00000000",
    `file://${htmlPath}`,
  ]);

  const stat = fs.statSync(pngPath);
  console.log(`Generated extension/icons/icon${size}.png: ${stat.size} bytes`);

  // docs/favicon.png is 48px
  if (size === 48) {
    const faviconPath = path.join(docsDir, "favicon.png");
    fs.copyFileSync(pngPath, faviconPath);
    console.log(`Updated docs/favicon.png from 48px icon`);
  }
}

// Also write extension/icons/app-icon.svg
const svgAppIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <rect width="128" height="128" rx="28" fill="#0e6e63"/>
  <g transform="translate(12, 12) scale(4.333)" stroke="#ffffff" stroke-width="2.0" stroke-linecap="round" stroke-linejoin="round" fill="none">
    <path d="M2.5 14.5c0-5 3.8-9 8.5-9 4.2 0 7 2.5 7.5 6.5l3.8 1.5c.8.3.8 1.2 0 1.5-2.2.8-5.8 1-7.8 1-2 0-8.5 0-12-1.5z"/>
    <path d="M11 5.5v9"/>
    <path d="M11 5.5c-2.8 1.2-5 4-5.5 9"/>
    <path d="M10 4.5c.5-.7 1.5-.7 2 0"/>
  </g>
</svg>
`;
fs.writeFileSync(path.join(iconsDir, "app-icon.svg"), svgAppIcon);
console.log("Wrote extension/icons/app-icon.svg");

// Clean up temp
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log("Done!");
