#!/usr/bin/env node
// Copies shared/*.js into every mods/vx-*/ folder. A Herdr mod can only import files from its
// own folder, and people install a mod by copying its folder, so each one carries the shared
// code. shared/ is the one to edit; run this (sync.sh does) after changing it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const shared = fs.readdirSync(path.join(root, "shared")).filter((f) => f.endsWith(".js"));
let changed = 0;
for (const mod of fs.readdirSync(path.join(root, "mods")).filter((m) => m.startsWith("vx-"))) {
  for (const f of shared) {
    const src = fs.readFileSync(path.join(root, "shared", f), "utf8");
    const dst = path.join(root, "mods", mod, f);
    if (!fs.existsSync(dst) || fs.readFileSync(dst, "utf8") !== src) {
      fs.writeFileSync(dst, src);
      changed++;
    }
  }
}
console.log(`build: ${shared.length} shared files in each mod (${changed} updated)`);
