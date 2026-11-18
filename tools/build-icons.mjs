#!/usr/bin/env node
// Usage: `node tools/build-icons.mjs ~/.config/herdr-app/mods/file-icons`.
// Reads JSON and SVG files only; runs nothing from the source.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const USAGE_EXIT_CODE = 2;
const LICENSE_FILE = "LICENSE-material-icon-theme.txt";
const REQUIRED_KEYS = ["file", "folder", "fileNames", "fileExtensions", "folderNames"];
const ACTIVE_CONTENT = /<script|javascript:|\son[a-z]+=|<foreignObject/i;

const source = process.argv[2];
if (!source) {
  console.error(`usage: node tools/build-icons.mjs <folder with icons.js, icons/, ${LICENSE_FILE}>`);
  process.exit(USAGE_EXIT_CODE);
}
const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(toolsDir, "..", "mods", "vx-icons");
const tableModule = fs.readFileSync(path.join(source, "icons.js"), "utf8");
const table = JSON.parse(tableModule.slice(tableModule.indexOf("{"), tableModule.lastIndexOf("}") + 1));
for (const key of REQUIRED_KEYS) {
  if (!(key in table)) {
    throw new Error(`icons.js has no ${key}`);
  }
}

fs.mkdirSync(path.join(outDir, "icons"), { recursive: true });
const svgFiles = fs.readdirSync(path.join(source, "icons")).filter((file) => file.endsWith(".svg"));
for (const file of svgFiles) {
  const svg = fs.readFileSync(path.join(source, "icons", file), "utf8");
  if (ACTIVE_CONTENT.test(svg)) {
    throw new Error(`refusing ${file}: active content`);
  }
  fs.writeFileSync(path.join(outDir, "icons", file), svg);
}
fs.writeFileSync(path.join(outDir, "icons.json"), `${JSON.stringify(table)}\n`);
fs.copyFileSync(path.join(source, LICENSE_FILE), path.join(outDir, LICENSE_FILE));
console.log(`vx-icons: ${svgFiles.length} icons, table with ${Object.keys(table.fileNames).length} names`);
