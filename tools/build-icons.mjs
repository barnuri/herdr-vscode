#!/usr/bin/env node
// Builds mods/vx-icons/ from an unpacked Material Icon Theme table + SVGs (MIT).
// Source: a folder holding icons.js (an `export default {...}` JSON table), icons/*.svg and
// LICENSE-material-icon-theme.txt -- e.g. the installed file-icons mod:
//   node tools/build-icons.mjs ~/.config/herdr-app/mods/file-icons
// Reads JSON and SVG files only; runs nothing from the source.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const src = process.argv[2];
if (!src) {
  console.error("usage: node tools/build-icons.mjs <folder with icons.js, icons/, LICENSE-material-icon-theme.txt>");
  process.exit(2);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "..", "mods", "vx-icons");
const text = fs.readFileSync(path.join(src, "icons.js"), "utf8");
const table = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
for (const key of ["file", "folder", "fileNames", "fileExtensions", "folderNames"])
  if (!(key in table)) throw new Error(`icons.js has no ${key}`);

fs.mkdirSync(path.join(out, "icons"), { recursive: true });
let copied = 0;
for (const f of fs.readdirSync(path.join(src, "icons"))) {
  if (!f.endsWith(".svg")) continue;
  const svg = fs.readFileSync(path.join(src, "icons", f), "utf8");
  if (/<script|javascript:|\son[a-z]+=|<foreignObject/i.test(svg)) throw new Error(`refusing ${f}: active content`);
  fs.writeFileSync(path.join(out, "icons", f), svg);
  copied++;
}
fs.writeFileSync(path.join(out, "icons.json"), `${JSON.stringify(table)}\n`);
fs.copyFileSync(path.join(src, "LICENSE-material-icon-theme.txt"), path.join(out, "LICENSE-material-icon-theme.txt"));
console.log(`vx-icons: ${copied} icons, table with ${Object.keys(table.fileNames).length} names`);
