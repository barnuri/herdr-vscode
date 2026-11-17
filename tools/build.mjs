#!/usr/bin/env node
// Copies shared/*.js into every mods/vx-*/ folder. A Herdr mod can only import files from its
// own folder, and people install a mod by copying its folder, so each one carries the shared
// code. shared/ is the one to edit; run this (sync.sh does) after changing it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CARDS } from "./cards.mjs";

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

// The gallery shows one card per folder holding RECIPE.md + preview.png + mods/<name>/. Each
// card folder gets fresh copies of its mods from mods/ (the one source); its RECIPE.md and
// preview.png are written by hand.

const copyDir = (from, to) => {
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true, filter: (p) => !/(\/cache|\.DS_Store|jsconfig\.json|\.d\.ts)$/.test(p) });
};
for (const [card, mods] of Object.entries(CARDS)) {
  fs.mkdirSync(path.join(root, card, "mods"), { recursive: true });
  for (const m of fs.readdirSync(path.join(root, card, "mods"))) if (!mods.includes(m)) fs.rmSync(path.join(root, card, "mods", m), { recursive: true, force: true });
  for (const m of mods) copyDir(path.join(root, "mods", m), path.join(root, card, "mods", m));
}
console.log(`build: ${Object.keys(CARDS).length} gallery cards refreshed`);
